# Karaoke Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static, offline “Песни” section that plays pre-analysed vocal tracks with word-synced lyrics, a scrolling pitch lane, a live tuner and per-line scoring.

**Architecture:** The app stays a vanilla static PWA. A Python ingestion script turns each MP3 into `tracks/<id>/track.json` plus audio/guide files. At runtime `karaoke-core.js` provides pure, Node-testable maths; `karaoke.js` owns the song list, audio elements, canvas and mic consumer; `app.js` gains a fifth tab and a shared microphone engine.

**Tech Stack:** HTML/CSS/vanilla JS, Web Audio for mic pitch detection, HTMLAudioElement for playback, Node `assert` for pure-function tests, Python 3 + faster-whisper + librosa + ffmpeg for ingestion.

**Spec:** `docs/superpowers/specs/2026-11-22-karaoke-mode-design.md`

## Global Constraints

- No build step, no framework, no server at runtime.
- All new runtime assets are same-origin static files under the repo root.
- Existing tabs “Ноты”, “Распевки”, “Микрофон”, “Настройки” keep working unchanged.
- `track.json` arrays `pitch` and `rms` must have exactly `Math.ceil(duration * fps)` entries.
- Scoring compares against quantised `notes`, not the continuous `pitch` curve.
- Octave is ignored for scoring: `diff -= 12 * Math.round(diff / 12)`.
- “Попал” is `|cents| <= 50`; “чисто” is `|cents| <= 25`.
- Each line keeps the best attempt; unplayed lines are not zeros.
- The first track is `radiotapok-zeit`, “Радиотапок — Zeit”, order 1.
- `prefers-reduced-motion` is respected.
- No desktop shell, exe, installer or separate app is created.

## Review Focus

- **Mic hears the reference vocal from speakers.** A loud reference must not make the score look perfect. Test that the headphone hint appears and that muting the vocal removes reference bleed.
- **User sings an octave lower.** The trail and tuner must fold the octave, display “на октаву ниже”, and still score in tune.
- **Long instrumental gaps and intros.** A five-minute track with a 17-second intro and 24-second gaps must show “Вступление/Проигрыш”, not a blank line or a crash.
- **Seeking, looping and restarting.** Repeating a phrase must keep the best result, must not double-count frames, and must not zero unplayed lines.
- **Broken or missing track data.** A missing audio file, malformed JSON or short `pitch` array must return to the list with a readable message, not a console-only failure.

---

### Task 1: Pure karaoke core

**Files:**
- Create: `karaoke-core.js`
- Create: `tools/test_karaoke_core.js`

**Interfaces:**
- Produces: `KaraokeCore` global and CommonJS export with `hzToMidi(hz: number): number`, `midiToHz(midi: number): number`, `foldOctave(diff: number): number`, `centsBetween(userMidi: number, refMidi: number): number`, `pitchAt(track, t: number): number|null`, `noteAt(track, t: number): object|null`, `lineAt(track, t: number): number`, `wordAt(line, t: number): number`, `newAttempt(): {lines: Map}`, `addFrame(attempt, track, t, userMidi): {line,note,cents,inTune}|null`, `finalizeAttempt(best: Map, attempt): void`, `overall(best: Map, track): {score,frames,inTune,played,total,coverage}`, `validateTrack(track): {ok:boolean,errors:string[]}`.

- [ ] **Step 1: Write the failing test**

Create `tools/test_karaoke_core.js` with `assert`. Cover:
```js
assert.equal(Math.round(C.hzToMidi(440)), 69);
assert.equal(Math.round(C.midiToHz(69)), 440);
assert.equal(C.foldOctave(12), 0);
assert.equal(C.foldOctave(13), 1);
assert.equal(C.foldOctave(-13), -1);
assert.equal(Math.round(C.centsBetween(70, 69)), 0); // octave folded
assert.equal(Math.round(C.centsBetween(69.5, 69)), 50);
```
Build a synthetic track:
```js
const track = {
  id: 'x', title: 'X', duration: 2, fps: 10,
  pitch: Array(20).fill(57), rms: Array(20).fill(.1),
  notes: [{t0:0.5,t1:1.5,midi:57,conf:.9}],
  lines: [{t0:0.5,t1:1.5,text:'a',words:[{t0:0.5,t1:1,text:'a'},{t0:1,t1:1.5,text:'b'}]}],
};
```
Assert `pitchAt` interpolation, `noteAt` guard (`0.51` null, `0.7` note, `1.49` null), `lineAt`, `wordAt`, scoring (`addFrame` 10 in-tune frames = score 1), octave fold, silent frame lowers score, `finalizeAttempt` keeps the best of two attempts, `overall` excludes an unplayed line and reports coverage, and `validateTrack` rejects a short pitch array.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/test_karaoke_core.js`
Expected: `ReferenceError` / `KaraokeCore is not defined`.

- [ ] **Step 3: Implement `karaoke-core.js`**

Implement the API above. Use binary search for `lineAt`/`wordAt`; `noteAt` returns `null` inside the guard window and for `conf < 0.2` (calibrated to the real pyin output). `addFrame` counts a frame whenever a note+line exists, increments `voiced` only when `userMidi != null`, and `inTune` only within 50 cents. `finalizeAttempt` stores `{...stat, score: inTune/frames, voicedRatio, avgAbs}`; attempts shorter than 6 frames are `fragment` and never replace a solid attempt. `overall` weights by `frames` and counts only scorable lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/test_karaoke_core.js`
Expected: `ok: karaoke core`.

- [ ] **Step 5: Commit**

```bash
git add karaoke-core.js tools/test_karaoke_core.js
git commit -m "feat: add karaoke core maths and tests"
```

---

### Task 2: Ingestion pipeline and first track

**Files:**
- Create: `tools/ingest_track.py`
- Create: `tracks/index.json`
- Create: `tracks/radiotapok-zeit/lyrics.txt`
- Create: `tracks/radiotapok-zeit/track.json`
- Create: `tracks/radiotapok-zeit/audio.mp3`
- Create: `tracks/radiotapok-zeit/guide.mp3`

**Interfaces:**
- Produces: `track.json` with `{version,id,title,artist,duration,audio,guide,cover?,language,fps,pitch,rms,notes,phrases,lines}`; `tracks/index.json` with `{version, tracks:[{id,order,title,artist,duration,dir,cover?,language}]}`.
- Consumes: `KaraokeCore.validateTrack` for the JSON check.

- [ ] **Step 1: Write the pipeline skeleton and a synthetic test**

`tools/ingest_track.py` accepts:
```bash
python tools/ingest_track.py INPUT --title T --artist A --slug S [--order N] [--lyrics FILE] [--language ru] [--model medium] [--force]
```
Add `--self-test` that synthesises a 3-second sine melody (A3, C4, E4), runs the pitch/note segmentation functions and asserts the recovered MIDI values are within 0.5 semitone. Run `python tools/ingest_track.py --self-test`; expect `self-test ok`.

- [ ] **Step 2: Implement probe/audio/pitch/notes**

- `ffprobe` via `subprocess` + `json` for duration/sample rate/channels/tags.
- Copy MP3 to `audio.mp3`; otherwise ffmpeg to 160 kbps stereo MP3.
- `ffmpeg` → mono 22050 Hz f32le; `librosa.load`.
- `librosa.pyin(fmin=80, fmax=1100, sr=22050, frame_length=2048, hop_length=512)`.
- MIDI conversion; RMS floor gate; 5-frame median; octave-jump repair (`if abs(diff)>7, try ±12 and keep the smaller`).
- Notes: stable runs ≥80 ms, ±0.7 semitone, gaps <50 ms merged; `conf` from `voiced_prob`.
- Resample pitch/RMS to `fps=50` with linear interpolation; pad to `ceil(duration*fps)`.

- [ ] **Step 3: Implement text, lines and guide**

- `faster-whisper` with `word_timestamps=True`, `vad_filter=True`, `condition_on_previous_text=False`.
- Split long ASR segments at word gaps >0.45 s and sentence punctuation. Clean leading spaces and duplicate spaces.
- If `--lyrics` is given, align known lines to ASR word timings with `difflib.SequenceMatcher`; unmatched words get proportional timings inside their line. Write the source text to `lyrics.txt`.
- For `Zeit`, use the official Russian text (already found) and correct ASR errors: “по течению”, “в чьих я”, “Миг”, “Вдаль”, “настанет твой час”.
- Guide: synthesise a soft tone per note (sine + 2 harmonics, 30 ms attack, 80 ms release, light vibrato), normalise, write WAV with `soundfile`, convert to `guide.mp3` 96 kbps mono with ffmpeg.
- Cover: `ffprobe` for an attached picture; extract with ffmpeg if present.

- [ ] **Step 4: Write JSON, manifest, diagnostics**

- Write compact `track.json`.
- Upsert `tracks/index.json`, sort by `order`.
- Write `tools/out/<slug>-diag.png` with RMS, pitch, note rectangles and line boundaries.
- Print duration, voiced coverage, note/phrase/line counts, and warnings.

- [ ] **Step 5: Run on the first track**

```bash
python tools/ingest_track.py "C:\Users\Stas\Downloads\audio [vocals].mp3" --title "Zeit" --artist "Радиотапок" --slug radiotapok-zeit --order 1 --language ru --lyrics tracks/radiotapok-zeit/lyrics.txt
```
Expected: `audio.mp3` (copy), `guide.mp3`, `track.json`, updated manifest, diagnostic PNG.

- [ ] **Step 6: Validate and QA**

Run `node -e "const C=require('./karaoke-core.js');const t=require('./tracks/radiotapok-zeit/track.json');console.log(C.validateTrack(t))"`; expected `{ok:true,errors:[]}`.
Open `tools/out/radiotapok-zeit-diag.png`; check no systematic octave jumps, intro starts at ~17 s, outro is clean. Read the transcript; fix any remaining ASR errors in `track.json`.
Check `pitch.length === Math.ceil(271.412 * 50)`.

- [ ] **Step 7: Commit**

```bash
git add tools/ingest_track.py tracks
git commit -m "feat: add track ingestion and first karaoke track"
```

---

### Task 3: Fifth tab and song library

**Files:**
- Modify: `index.html` (tabbar, add `#viewSongs`)
- Modify: `styles.css` (5-tab layout, library cards)
- Modify: `app.js` (titles, `setTab`, `el.vSongs`)
- Create: `karaoke.js` (manifest fetch, list render, shell)

**Interfaces:**
- Produces: `window.Karaoke = {enter(), leave(), onKey(e)}`; `document.body.dataset.tab === 'songs'`.
- Consumes: `tracks/index.json`.

- [ ] **Step 1: Add the tab and view skeleton**

Add a fifth button `data-tab="songs"` labelled “Песни” with a music-note icon. Add `<main class="view" id="viewSongs" hidden>` containing `#songsLibrary`, `#songList`, `#songsEmpty`, and a hidden `#karaoke` player shell.

- [ ] **Step 2: Wire `setTab`**

Add `songs: 'Песни'` / lede to `TITLES`/`LEDES`. Add `vSongs: $('viewSongs')`. In `setTab`, hide/show `vSongs`, call `window.Karaoke?.leave()` when leaving songs and `window.Karaoke?.enter()` when entering. Do not let `mode()` treat songs as notes/chant.

- [ ] **Step 3: Render the library**

`karaoke.js` fetches `tracks/index.json` with `cache: 'no-cache'`, renders one card per track: number, title, artist, duration, cover or initials. Empty state: “Пока нет песен. Пришли MP3 в чат — я разберу и добавлю сюда.” On card click, call `openTrack(id)` (stub for now: `console.log`).

- [ ] **Step 4: Verify in browser**

Run `python -m http.server 5173` (or the existing launch config), open `http://localhost:5173/?tab=songs`, snapshot: tab active, list contains “Радиотапок — Zeit”, no console errors. Screenshot.

- [ ] **Step 5: Commit**

```bash
git add index.html styles.css app.js karaoke.js
git commit -m "feat: add songs tab and track library"
```

---

### Task 4: Karaoke playback, lyrics and progress

**Files:**
- Modify: `karaoke.js`
- Modify: `styles.css`
- Modify: `index.html` (player elements)

**Interfaces:**
- Consumes: `track.dir`, `track.audio`, `track.lines`, `track.duration`.
- Produces: `openTrack(id)`, `closeTrack()`, `togglePlay()`, `seek(t)`, current line/word DOM classes.

- [ ] **Step 1: Load a track**

`openTrack(id)` finds the manifest entry, fetches `dir + 'track.json'`, validates it, sets `#songAudio.src = dir + audio`, shows `#karaoke`, hides `#songsLibrary`, and fills title/artist. On fetch/validation error, show a message and return to the list.

- [ ] **Step 2: Play/pause/seek**

`togglePlay()` starts/pauses `songAudio`; `seek(t)` sets `currentTime`; update the progress bar and time label in a `requestAnimationFrame` loop. Add `#karaokeBack` to return to the list.

- [ ] **Step 3: Render lyrics**

Use `KaraokeCore.lineAt/wordAt`. On line change, render the current line as word spans; previous/next text in dimmed rows. Toggle `.on` on the active word. In gaps show “Вступление” before the first line and “Проигрыш” between lines.

- [ ] **Step 4: Verify**

Open the track, play: time advances, words highlight, pause stops, clicking progress seeks. Check the 17 s intro shows “Вступление”, and the 64–82 s gap shows “Проигрыш”. Console clean.

- [ ] **Step 5: Commit**

```bash
git add karaoke.js styles.css index.html
git commit -m "feat: add karaoke playback and synced lyrics"
```

---

### Task 5: Pitch lane and tuner

**Files:**
- Modify: `karaoke.js`
- Modify: `styles.css`
- Modify: `index.html`

**Interfaces:**
- Consumes: `track.pitch`, `track.notes`, `track.lines`, `KaraokeCore.pitchAt`.
- Produces: `drawLane(now)`, `setTuner(cents|null, status, detail)`, `debugPushPitch(midi)`.

- [ ] **Step 1: Draw the scrolling lane**

Canvas window: `playhead - 2.5 s` to `playhead + 5.5 s` (6 s on narrow screens). Dynamic MIDI range from visible notes, at least 12 semitones. Draw semitone grid and note labels, target notes as brass rounded rectangles, reference curve as a thin brass line, playhead vertical line. DPR-aware.

- [ ] **Step 2: Draw the live trail**

`K.trail` entries `{t, v, ok}`; keep 8 s. Draw segments green when `ok`, amber otherwise; current dot with an up/down arrow when off. `debugPushPitch(midi)` appends a synthetic point for tests.

- [ ] **Step 3: Tuner**

Horizontal gauge −100…+100 cents, green zone ±50, needle position `50 + clamp(cents,-100,100)/2`%. Status text: “Чисто ✓”, “Попал, держи”, “Ниже на N — тяни вверх”, “Выше на N — тяни вниз”. No target: “Слушай…”.

- [ ] **Step 4: Verify**

Use `Karaoke.debugPushPitch(57)` at 57 target: needle center, green. Push 55: needle left, “тяни вверх”. Push 69: still center (octave fold). Screenshot.

- [ ] **Step 5: Commit**

```bash
git add karaoke.js styles.css index.html
git commit -m "feat: add karaoke pitch lane and tuner"
```

---

### Task 6: Shared microphone engine

**Files:**
- Modify: `app.js:604-761` (mic engine)
- Modify: `karaoke.js`

**Interfaces:**
- Produces: `window.__vt.startMic(consumer='mic', onFrame=null): Promise<boolean>`, `window.__vt.stopMic()`, frame `{freq,midi,rms,dt,now}`.
- Consumes: existing `detectPitch`, `getUserMedia`.

- [ ] **Step 1: Generalise `startMic`/`stopMic`**

Add `mic.consumer` and `mic.onFrame`. `startMic` returns `true` on success, `false` on permission failure; for consumer `'songs'` call `window.Karaoke?.onMicError()` on failure. `stopMic` calls `window.Karaoke?.onMicStopped()` for songs and leaves the mic-tab UI reset only for consumer `'mic'`.

- [ ] **Step 2: Route frames**

In `micTick`, after level/pitch detection, if `consumer === 'songs'` call `onFrame({freq, midi: freq>0 ? 69+12*Math.log2(freq/440) : null, rms: peak, dt, now})` and return. Otherwise keep the existing `handlePitch` path unchanged.

- [ ] **Step 3: Karaoke mic toggle**

`#karaokeMic` calls `startMic('songs', onFrame)` / `stopMic()`. On frame, if `songAudio` is playing, score and push the display trail. Show “Включи микрофон” until started.

- [ ] **Step 4: Verify**

Click mic, allow permission, sing/hum: level moves, tuner responds. Switch to “Микрофон” tab: the existing tuner still works. Switch back: mic restarts only on button. Console clean.

- [ ] **Step 5: Commit**

```bash
git add app.js karaoke.js
git commit -m "feat: share mic engine with karaoke mode"
```

---

### Task 7: Scoring, loop, speed and results

**Files:**
- Modify: `karaoke.js`
- Modify: `styles.css`
- Modify: `index.html`

**Interfaces:**
- Consumes: `KaraokeCore.newAttempt/addFrame/finalizeAttempt/overall`.
- Produces: `startAttempt()`, `endAttempt()`, `results()`, `loopPhrase(i)`, `setSpeed(rate)`.

- [ ] **Step 1: Session state**

`K.session = {best: new Map(), current: newAttempt(), active: false}`. `startAttempt()` creates a new current and sets active. `endAttempt()` finalizes current into best. Pause keeps active; seek, loop, restart and track change end/start. `addFrame` only while playing and mic active.

- [ ] **Step 2: Loop and speed**

`loopPhrase(i)` sets `{t0,t1}` from `track.phrases[i]` or `line`, seeks to t0, starts a new attempt; RAF seeks back to t0 at t1. `setSpeed(0.75|1)` sets `playbackRate` and `preservesPitch` on song/guide.

- [ ] **Step 3: Results screen**

On `ended` or “Итог”: end attempt, compute `overall`, render total %, coverage, per-line best score/avg cents. Click a line loops its phrase and closes results. “Ещё раз” clears best and seeks 0.

- [ ] **Step 4: Verify**

Use `debugPushPitch` while playing to simulate in-tune and off frames. Check line score, best-of-two loop attempts, overall coverage for a partial run. Verify seek does not double count. Node tests already cover the maths; browser test covers wiring.

- [ ] **Step 5: Commit**

```bash
git add karaoke.js styles.css index.html
git commit -m "feat: add karaoke scoring, looping and results"
```

---

### Task 8: Guide, settings and sync

**Files:**
- Modify: `karaoke.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js` (store karaoke settings)

**Interfaces:**
- Produces: `setVocalVolume(v)`, `setGuide(on)`, `setSync(ms)`, persisted key `vt-songs`.

- [ ] **Step 1: Guide audio**

Load `dir + guide` if present. Play/pause with the song. Every 500 ms, if `|guide.currentTime - song.currentTime| > 0.06`, correct it. Toggle/volume; if missing, disable the control.

- [ ] **Step 2: Settings**

Vocal volume slider (0–100%), guide toggle/volume, speed, sync slider (−300…+300 ms), headphone hint. Persist `{lastId, vocalVol, guideVol, speed, syncMs, hintSeen}` in `localStorage`.

- [ ] **Step 3: Verify**

Mute vocal: guide audible and in sync after seek. Change sync: tuner offset changes. Reload: settings persist. Show hint on first karaoke open.

- [ ] **Step 4: Commit**

```bash
git add karaoke.js index.html styles.css app.js
git commit -m "feat: add karaoke guide track and settings"
```

---

### Task 9: Offline, responsive and accessibility

**Files:**
- Modify: `sw.js`
- Modify: `styles.css`
- Modify: `app.js` (keyboard routing)
- Modify: `karaoke.js`

**Interfaces:**
- Consumes: existing service worker.
- Produces: cache version `vt-v7`; runtime cache for `/tracks/`.

- [ ] **Step 1: Service worker**

Bump `VERSION` to `vt-v7`; add `karaoke-core.js`, `karaoke.js`, `tracks/index.json` to `ASSETS`. Add a `/tracks/` Range-aware cache for audio/guide, network-first for track JSON, and cache fallback for navigation. Keep the app-shell network-first branch.

- [ ] **Step 2: Responsive 5 tabs**

At ≤380 px reduce tab font/icon sizes and gaps so five tabs fit; keep safe-area padding. Check 320 px. Karaoke transport wraps without horizontal scroll.

- [ ] **Step 3: Keyboard and a11y**

In `app.js`, when `S.tab === 'songs'`, delegate keys to `Karaoke.onKey`: Space play/pause, ←/→ ±5 s, R loop, Esc back. Add `aria-current`, `aria-live` for tuner at ≤2 updates/s, focus-visible, and reduced-motion.

- [ ] **Step 4: Verify offline**

Play the track once, then DevTools → Offline → reload. The library and track still load from cache. Check console and network. Check mobile viewport screenshot.

- [ ] **Step 5: Commit**

```bash
git add sw.js styles.css app.js karaoke.js
git commit -m "feat: cache karaoke tracks and polish mobile a11y"
```

---

### Task 10: End-to-end QA and deploy

**Files:**
- Modify as needed.
- Update: `docs/superpowers/specs/2026-11-22-karaoke-mode-design.md` if implementation diverges.

- [ ] **Step 1: Run all automated checks**

```bash
node tools/test_karaoke_core.js
node -e "const C=require('./karaoke-core.js');const t=require('./tracks/radiotapok-zeit/track.json');const r=C.validateTrack(t);console.log(r);if(!r.ok)process.exit(1)"
python tools/ingest_track.py --self-test
```
Expected: all pass.

- [ ] **Step 2: Browser QA**

Open `?tab=songs`; select the track; play; verify intro, lyrics, pitch lane, tuner, mic, vocal mute, guide, speed, loop, results, back. Test partial run and repeated phrase. Check console errors. Take desktop and mobile screenshots.

- [ ] **Step 3: Fix and re-run**

Fix any issues; rerun the relevant checks.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "feat: add karaoke mode with pre-analysed songs"
git push origin main
```
Expected: push succeeds; GitHub Pages serves the new version from `main`.

- [ ] **Step 5: Verify the deployed page**

Open the GitHub Pages URL, hard-reload, confirm the “Песни” tab and the track play. If Pages has not updated yet, wait for the deployment and reload.
