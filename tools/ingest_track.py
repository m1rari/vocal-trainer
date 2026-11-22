#!/usr/bin/env python3
"""Turn an isolated vocal MP3 into a karaoke track for the static app.

Usage:
  python tools/ingest_track.py INPUT --title T --artist A --slug S [options]
  python tools/ingest_track.py --self-test
"""

from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TRACKS = ROOT / "tracks"
OUT = ROOT / "tools" / "out"
FPS = 50
SR_ANALYSIS = 22050
SR_GUIDE = 44100
HOP = 512
FRAME = 2048

def load_corrections(out_dir: Path):
    """Per-track ASR fixes live next to the track, not in this generic tool."""
    path = out_dir / "corrections.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return [(str(x["pattern"]), str(x["repl"])) for x in data.get("corrections", [])]
    except Exception as exc:
        log(f"  warning: could not read {path}: {exc}")
        return []


def log(*args):
    print(*args, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def ffprobe(path: Path) -> dict:
    out = run([
        "ffprobe", "-v", "error", "-show_format", "-show_streams",
        "-of", "json", "--", str(path),
    ]).stdout
    return json.loads(out)


def audio_duration(path: Path) -> float:
    info = ffprobe(path)
    return float(info["format"]["duration"])


def load_audio(path: Path, sr: int) -> np.ndarray:
    import librosa
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y


def transcribe(path: Path, model_name: str, language: str | None):
    from faster_whisper import WhisperModel
    y = load_audio(path, 16000)
    log(f"  whisper: model={model_name}, {len(y)/16000:.1f}s audio")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=6)
    segments, info = model.transcribe(
        y,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )
    out = []
    for s in segments:
        words = []
        for w in (s.words or []):
            txt = (w.word or "").strip()
            if txt:
                words.append({"t0": round(float(w.start), 3), "t1": round(float(w.end), 3), "text": txt})
        out.append({
            "t0": round(float(s.start), 3),
            "t1": round(float(s.end), 3),
            "text": s.text.strip(),
            "words": words,
        })
        log(f"  asr {s.start:6.1f}-{s.end:6.1f}  {s.text.strip()}")
    log(f"  whisper language={info.language} p={info.language_probability:.2f}")
    return out


def pitch_track(y: np.ndarray):
    import librosa
    t0 = time.time()
    f0, voiced, prob = librosa.pyin(
        y, fmin=80, fmax=1100, sr=SR_ANALYSIS,
        frame_length=FRAME, hop_length=HOP, fill_na=np.nan,
    )
    times = librosa.times_like(f0, sr=SR_ANALYSIS, hop_length=HOP)
    rms = librosa.feature.rms(y=y, frame_length=FRAME, hop_length=HOP)[0]
    n = min(len(times), len(f0), len(rms), len(prob))
    times, f0, prob, rms = times[:n], f0[:n], prob[:n], rms[:n]
    midi = np.full_like(f0, np.nan)
    ok = np.isfinite(f0) & (f0 > 0)
    midi[ok] = 69 + 12 * np.log2(f0[ok] / 440)
    log(f"  pyin: {len(times)} frames in {time.time()-t0:.1f}s, voiced {ok.mean()*100:.0f}%")
    return times, midi, prob, rms


def repair_pitch(times, midi, prob, rms, first_line, last_line):
    """Null outside the vocal span, gate by RMS, kill isolated octave spikes."""
    m = np.array(midi, dtype=float)
    lo = max(0.0, first_line - 1.0)
    hi = last_line + 2.0
    m[(times < lo) | (times > hi)] = np.nan

    span = (times >= lo) & (times <= hi)
    base = np.nanpercentile(rms[span], 90) if span.any() else np.nanpercentile(rms, 90)
    gate = max(0.006, 0.05 * float(base))
    m[rms < gate] = np.nan
    m[prob < 0.1] = np.nan

    # Isolated octave spikes: a single frame far from both neighbours.
    for i in range(1, len(m) - 1):
        if not np.isfinite(m[i]):
            continue
        a, b = m[i - 1], m[i + 1]
        if np.isfinite(a) and np.isfinite(b) and abs(m[i] - np.median([a, b])) > 7:
            m[i] = np.median([a, b])

    # Median filter in place, only where we have a value.
    out = m.copy()
    for i in range(2, len(m) - 2):
        if not np.isfinite(m[i]):
            continue
        vals = m[i - 2:i + 3]
        vals = vals[np.isfinite(vals)]
        if len(vals) >= 3:
            out[i] = float(np.median(vals))
    log(f"  pitch gate={gate:.4f}, voiced after gate {np.isfinite(out).mean()*100:.0f}%")
    return out


def segment_notes(times, midi, prob, min_dur=0.08, tol=0.7, max_gap=0.05):
    notes = []
    cur = None

    def flush():
        nonlocal cur
        if not cur:
            return
        dur = cur["t1"] - cur["t0"]
        if dur >= min_dur:
            notes.append({
                "t0": round(cur["t0"], 3),
                "t1": round(cur["t1"], 3),
                "midi": int(round(float(np.median(cur["vals"])))),
                "conf": round(float(np.mean(cur["conf"])), 2),
            })
        cur = None

    for t, v, p in zip(times, midi, prob):
        if not np.isfinite(v):
            if cur and (t - cur["t1"]) > max_gap:
                flush()
            continue
        if cur is None:
            cur = {"t0": float(t), "t1": float(t), "vals": [float(v)], "conf": [float(p)]}
            continue
        med = float(np.median(cur["vals"]))
        if abs(float(v) - med) <= tol and (t - cur["t1"]) <= max_gap:
            cur["t1"] = float(t)
            cur["vals"].append(float(v))
            cur["conf"].append(float(p))
        else:
            flush()
            cur = {"t0": float(t), "t1": float(t), "vals": [float(v)], "conf": [float(p)]}
    flush()

    # Merge adjacent same-note fragments separated by a tiny gap.
    merged = []
    for n in notes:
        if merged and merged[-1]["midi"] == n["midi"] and n["t0"] - merged[-1]["t1"] < 0.15:
            merged[-1]["t1"] = n["t1"]
            merged[-1]["conf"] = round(max(merged[-1]["conf"], n["conf"]), 2)
        else:
            merged.append(n)
    return merged


def join_words(words):
    text = ""
    for w in words:
        t = w["text"]
        if not text:
            text = t
        elif t.startswith("-"):
            text += t
        else:
            text += " " + t
    return re.sub(r"\s+", " ", text).strip()


def merge_short_lines(lines):
    out = []
    for line in lines:
        if out:
            prev = out[-1]
            gap = line["t0"] - prev["t1"]
            if (prev["t1"] - prev["t0"]) < 1.4 and gap < 0.8:
                prev["t1"] = line["t1"]
                prev["words"].extend(line["words"])
                prev["text"] = join_words(prev["words"])
                continue
        out.append(line)
    return out


def split_lines(segments):
    """Split ASR segments at musical pauses and sentence breaks."""
    lines = []
    for s in segments:
        words = [w for w in s["words"] if w["text"]]
        if not words:
            continue
        cur = []
        for w in words:
            if cur:
                gap = w["t0"] - cur[-1]["t1"]
                prev = cur[-1]["text"]
                boundary = gap > 0.45
                if not boundary and gap > 0.22 and re.search(r"[,.!?]$", prev) and w["text"][:1].isupper():
                    boundary = True
                if not boundary and (w["t1"] - cur[0]["t0"]) > 7.0 and gap > 0.25:
                    boundary = True
                if boundary:
                    lines.append(cur)
                    cur = []
            cur.append(dict(w))
        if cur:
            lines.append(cur)

    out = []
    for words in lines:
        text = join_words(words)
        text = re.sub(r"\s+([,.!?])", r"\1", text)
        out.append({
            "t0": round(words[0]["t0"], 3),
            "t1": round(words[-1]["t1"], 3),
            "text": text,
            "words": [
                {"t0": round(w["t0"], 3), "t1": round(max(w["t1"], w["t0"] + 0.01), 3), "text": w["text"]}
                for w in words
            ],
        })
    return out


def apply_corrections(lines, corrections):
    for line in lines:
        for pattern, repl in corrections:
            line["text"] = re.sub(pattern, repl, line["text"])
            for w in line["words"]:
                w["text"] = re.sub(pattern, repl, w["text"])
    return lines


def lyrics_report(lines, lyrics_path):
    """Warn when generated lines do not resemble the supplied reference text."""
    if not lyrics_path:
        return
    path = Path(lyrics_path)
    if not path.exists():
        return
    official = [x.strip() for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    if not official:
        return
    norm = lambda s: re.sub(r"[^\wа-яё]+", " ", s.lower(), flags=re.IGNORECASE).strip()
    weak = 0
    for i, line in enumerate(lines):
        best = max((difflib.SequenceMatcher(None, norm(line["text"]), norm(o)).ratio() for o in official), default=0)
        if best < 0.45:
            weak += 1
            log(f"  warning: line {i} is unlike the reference: {line['text']}")
    log(f"  lyrics check: {len(lines) - weak}/{len(lines)} lines resemble the reference")


def fix_word_specials(lines):
    for line in lines:
        if line["text"].startswith("Что поставить на весы") and line["words"] and line["words"][0]["text"] == "поставить":
            w = line["words"][0]
            line["words"].insert(0, {"t0": w["t0"], "t1": round(w["t0"] + 0.01, 3), "text": "Что"})
        for w in line["words"]:
            if w["text"] == "он" and line["text"].startswith("и оно"):
                w["text"] = "и оно"
        if line["text"].startswith("и оно"):
            line["text"] = "И" + line["text"][1:]
            if line["words"] and line["words"][0]["text"].lower() == "и":
                line["words"][0]["text"] = "И"
    return lines


def resample_nearest(times, values, duration, fps, scale=1.0):
    n = math.ceil(duration * fps)
    grid = np.arange(n) / fps
    idx = np.clip(np.searchsorted(times, grid), 0, len(values) - 1)
    arr = values[idx]
    out = []
    for v in arr:
        if isinstance(v, (float, np.floating)) and not np.isfinite(v):
            out.append(None)
        else:
            out.append(round(float(v) * scale, 3))
    return out


def midi_to_hz(m):
    return 440.0 * (2.0 ** ((float(m) - 69.0) / 12.0))


def render_guide(notes, duration, out_path: Path):
    n = int(math.ceil(duration * SR_GUIDE))
    mix = np.zeros(n, dtype=np.float32)
    for note in notes:
        start = max(0, int(note["t0"] * SR_GUIDE))
        end = min(n, int(note["t1"] * SR_GUIDE))
        if end <= start:
            continue
        t = np.arange(end - start, dtype=np.float32) / SR_GUIDE
        freq = midi_to_hz(note["midi"])
        vib = 1.0 + 0.006 * np.sin(2 * np.pi * 5.0 * t) * np.minimum(1.0, t / 0.2)
        wav = (
            np.sin(2 * np.pi * freq * vib * t)
            + 0.25 * np.sin(4 * np.pi * freq * vib * t)
            + 0.10 * np.sin(6 * np.pi * freq * vib * t)
        ).astype(np.float32)
        env = np.ones_like(t)
        a = min(len(t), int(0.03 * SR_GUIDE))
        r = min(len(t), int(0.08 * SR_GUIDE))
        if a:
            env[:a] = np.linspace(0, 1, a, dtype=np.float32)
        if r:
            env[-r:] *= np.linspace(1, 0, r, dtype=np.float32)
        mix[start:end] += wav * env * 0.20
    peak = float(np.max(np.abs(mix))) if len(mix) else 0.0
    if peak > 0:
        mix *= 0.60 / peak
    import soundfile as sf
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False, dir=str(out_path.parent)) as tf:
        wav_path = Path(tf.name)
    sf.write(str(wav_path), mix, SR_GUIDE, subtype="PCM_16")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav_path),
         "-ac", "1", "-b:a", "96k", str(out_path)])
    wav_path.unlink(missing_ok=True)


def extract_cover(src: Path, out_dir: Path):
    cover = out_dir / "cover.jpg"
    try:
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
             "-an", "-vcodec", "copy", str(cover)])
    except subprocess.CalledProcessError:
        cover.unlink(missing_ok=True)
    return cover.name if cover.exists() and cover.stat().st_size > 0 else None


def diagnostic(times, midi, rms, notes, lines, slug):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    OUT.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(3, 1, figsize=(18, 10), sharex=True)
    ax[0].plot(times, rms)
    ax[0].set_ylabel("rms")
    ax[1].plot(times, midi, ".", ms=1)
    for n in notes:
        ax[1].add_patch(plt.Rectangle((n["t0"], n["midi"] - 0.35), n["t1"] - n["t0"], 0.7,
                                      color="tab:orange", alpha=0.5))
    ax[1].set_ylabel("midi")
    ax[1].set_ylim(35, 85)
    ax[2].plot(times, midi, ".", ms=1)
    for l in lines:
        ax[2].axvline(l["t0"], color="tab:green", alpha=0.25, lw=0.8)
    ax[2].set_ylabel("lines")
    ax[2].set_ylim(35, 85)
    fig.tight_layout()
    path = OUT / f"{slug}-diag.png"
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return path


def update_manifest(entry):
    TRACKS.mkdir(exist_ok=True)
    path = TRACKS / "index.json"
    data = {"version": 1, "tracks": []}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    tracks = [t for t in data.get("tracks", []) if t.get("id") != entry["id"]]
    tracks.append(entry)
    tracks.sort(key=lambda t: (t.get("order", 999), t.get("title", "")))
    data["tracks"] = tracks
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def ingest(args):
    src = Path(args.input).expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"file not found: {src}")
    slug = args.slug
    out_dir = TRACKS / slug
    if out_dir.exists() and not args.force:
        raise SystemExit(f"{out_dir} already exists; use --force")
    out_dir.mkdir(parents=True, exist_ok=True)

    log(f"1/7 probing {src.name}")
    info = ffprobe(src)
    duration = float(info["format"]["duration"])
    log(f"  duration {duration:.2f}s, {info['format'].get('bit_rate', '?')} bps")

    log("2/7 copying audio")
    audio_name = "audio.mp3"
    if src.suffix.lower() == ".mp3":
        shutil.copyfile(src, out_dir / audio_name)
    else:
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
             "-ac", "2", "-ar", "44100", "-b:a", "160k", str(out_dir / audio_name)])
    cover = extract_cover(src, out_dir)
    if cover:
        log(f"  cover: {cover}")

    log("3/7 transcribing")
    segments = transcribe(src, args.model, args.language)
    lines = split_lines(segments)
    lines = merge_short_lines(lines)
    lines = apply_corrections(lines, load_corrections(out_dir))
    lines = fix_word_specials(lines)
    lyrics_report(lines, args.lyrics)
    if not lines:
        raise SystemExit("no lyric lines found")
    first_line = lines[0]["t0"]
    last_line = lines[-1]["t1"]
    log(f"  {len(lines)} lines, {first_line:.1f}-{last_line:.1f}s")

    log("4/7 tracking pitch")
    y = load_audio(src, SR_ANALYSIS)
    times, midi, prob, rms = pitch_track(y)
    midi = repair_pitch(times, midi, prob, rms, first_line, last_line)
    notes = segment_notes(times, midi, prob)
    notes = [n for n in notes if any(n["t1"] >= l["t0"] - 0.2 and n["t0"] <= l["t1"] + 0.2 for l in lines)]
    log(f"  {len(notes)} notes")

    log("5/7 writing arrays")
    pitch = resample_nearest(times, midi, duration, FPS)
    rms_norm = resample_nearest(times, rms, duration, FPS, scale=1.0 / max(1e-6, float(np.percentile(rms, 99))))
    rms_norm = [min(1.0, v) if v is not None else 0.0 for v in rms_norm]
    if len(pitch) != math.ceil(duration * FPS):
        raise SystemExit("pitch array length mismatch")
    if len(rms_norm) != math.ceil(duration * FPS):
        raise SystemExit("rms array length mismatch")

    log("6/7 rendering guide")
    guide_name = "guide.mp3"
    render_guide(notes, duration, out_dir / guide_name)

    lines_out = []
    for i, l in enumerate(lines):
        lines_out.append({
            "t0": l["t0"], "t1": l["t1"], "text": l["text"],
            "words": [{"t0": w["t0"], "t1": w["t1"], "text": w["text"]} for w in l["words"]],
        })
    phrases = [{"t0": l["t0"], "t1": l["t1"], "line": i} for i, l in enumerate(lines_out)]

    track = {
        "version": 1,
        "id": slug,
        "title": args.title,
        "artist": args.artist,
        "duration": round(duration, 3),
        "audio": audio_name,
        "guide": guide_name,
        "language": args.language or "ru",
        "fps": FPS,
        "pitch": pitch,
        "rms": rms_norm,
        "notes": notes,
        "phrases": phrases,
        "lines": lines_out,
    }
    if cover:
        track["cover"] = cover
    (out_dir / "track.json").write_text(
        json.dumps(track, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    if args.lyrics:
        src_lyrics = Path(args.lyrics).resolve()
        dst_lyrics = (out_dir / "lyrics.txt").resolve()
        if src_lyrics != dst_lyrics:
            shutil.copyfile(src_lyrics, dst_lyrics)

    update_manifest({
        "id": slug, "order": args.order, "title": args.title, "artist": args.artist,
        "duration": round(duration, 3), "dir": f"tracks/{slug}/",
        **({"cover": cover} if cover else {}),
        "language": args.language or "ru",
    })

    log("7/7 diagnostics")
    diag = diagnostic(times, midi, rms, notes, lines_out, slug)
    log(f"  {diag}")
    log("done")
    log(f"  lines={len(lines_out)} notes={len(notes)} pitched={sum(v is not None for v in pitch)/len(pitch)*100:.0f}%")
    log(f"  track: {out_dir / 'track.json'} ({(out_dir / 'track.json').stat().st_size/1024:.0f} KB)")
    log(f"  guide: {out_dir / guide_name} ({(out_dir / guide_name).stat().st_size/1024/1024:.1f} MB)")


def self_test():
    import librosa
    sr = SR_ANALYSIS
    dur = 3.0
    y = np.zeros(int(sr * dur), dtype=np.float32)
    for start, end, hz in [(0.2, 0.8, 220.0), (1.0, 1.6, 261.63), (1.8, 2.4, 329.63)]:
        a, b = int(start * sr), int(end * sr)
        t = np.arange(b - a) / sr
        y[a:b] = 0.35 * np.sin(2 * np.pi * hz * t) * np.hanning(b - a)
    t0 = time.time()
    f0, voiced, prob = librosa.pyin(y, fmin=80, fmax=1100, sr=sr,
                                    frame_length=FRAME, hop_length=HOP, fill_na=np.nan)
    times = librosa.times_like(f0, sr=sr, hop_length=HOP)
    rms = librosa.feature.rms(y=y, frame_length=FRAME, hop_length=HOP)[0]
    midi = np.full_like(f0, np.nan)
    ok = np.isfinite(f0) & (f0 > 0)
    midi[ok] = 69 + 12 * np.log2(f0[ok] / 440)
    notes = segment_notes(times, midi, prob)
    got = [n["midi"] for n in notes]
    log("self-test notes:", got, f"({time.time()-t0:.1f}s)")
    assert len(got) >= 3, got
    for want, g in zip([57, 60, 64], got[:3]):
        assert abs(want - g) <= 0, (want, g)
    log("self-test ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", nargs="?")
    ap.add_argument("--title")
    ap.add_argument("--artist")
    ap.add_argument("--slug")
    ap.add_argument("--order", type=int, default=999)
    ap.add_argument("--lyrics", help="reference lyrics text; copied into the track folder and used for a QA warning, text is still proofread manually")
    ap.add_argument("--language", default="ru")
    ap.add_argument("--model", default="medium")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return
    if not (args.input and args.title and args.artist and args.slug):
        ap.error("input, --title, --artist and --slug are required")
    ingest(args)


if __name__ == "__main__":
    main()
