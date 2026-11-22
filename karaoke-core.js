/* Pure karaoke maths. No DOM, no audio: loaded by the app and by Node tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (root) root.KaraokeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
  const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
  const foldOctave = d => d - 12 * Math.round(d / 12);
  const centsBetween = (userMidi, refMidi) => foldOctave(userMidi - refMidi) * 100;

  function pitchAt(track, t) {
    const p = track && track.pitch;
    if (!p || !p.length) return null;
    const x = clamp(t * track.fps, 0, p.length - 1);
    const i = Math.floor(x);
    const j = Math.min(p.length - 1, i + 1);
    const f = x - i;
    const a = p[i];
    const b = p[j];
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return a + (b - a) * f;
  }

  function noteAt(track, t) {
    const notes = track && track.notes;
    if (!notes || !notes.length) return null;
    let lo = 0;
    let hi = notes.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = notes[mid];
      if (t < n.t0) hi = mid - 1;
      else if (t > n.t1) lo = mid + 1;
      else { found = n; break; }
    }
    if (!found) return null;
    if ((found.conf == null ? 1 : found.conf) < 0.6) return null;
    const guard = Math.min(0.08, Math.max(0.02, 0.2 * (found.t1 - found.t0)));
    if (t < found.t0 + guard || t > found.t1 - guard) return null;
    return found;
  }

  function lineAt(track, t) {
    const lines = track && track.lines;
    if (!lines || !lines.length) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = lines[mid];
      if (t < l.t0) hi = mid - 1;
      else if (t > l.t1) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function wordAt(line, t) {
    const words = line && line.words;
    if (!words || !words.length) return -1;
    let lo = 0;
    let hi = words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = words[mid];
      if (t < w.t0) hi = mid - 1;
      else if (t > w.t1) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function newAttempt() {
    return { lines: new Map() };
  }

  function lineStat(attempt, i) {
    let s = attempt.lines.get(i);
    if (!s) {
      s = { frames: 0, inTune: 0, voiced: 0, sumAbs: 0 };
      attempt.lines.set(i, s);
    }
    return s;
  }

  function addFrame(attempt, track, t, userMidi) {
    const note = noteAt(track, t);
    if (!note) return null;
    const li = lineAt(track, t);
    if (li < 0) return null;
    const s = lineStat(attempt, li);
    s.frames++;
    if (userMidi == null || !Number.isFinite(userMidi)) {
      return { line: li, note, cents: null, inTune: false };
    }
    const cents = centsBetween(userMidi, note.midi);
    s.voiced++;
    s.sumAbs += Math.abs(cents);
    if (Math.abs(cents) <= 50) s.inTune++;
    return { line: li, note, cents, inTune: Math.abs(cents) <= 50 };
  }

  function finalizeAttempt(best, attempt) {
    for (const [i, s] of attempt.lines) {
      if (!s.frames) continue;
      const score = s.inTune / s.frames;
      const prev = best.get(i);
      if (!prev || score > prev.score) {
        best.set(i, {
          frames: s.frames,
          inTune: s.inTune,
          voiced: s.voiced,
          sumAbs: s.sumAbs,
          score,
          voicedRatio: s.voiced / s.frames,
          avgAbs: s.voiced ? s.sumAbs / s.voiced : null,
        });
      }
    }
  }

  function overall(best, track) {
    let frames = 0;
    let inTune = 0;
    let played = 0;
    for (const s of best.values()) {
      if (!s.frames) continue;
      played++;
      frames += s.frames;
      inTune += s.inTune;
    }
    const total = track && track.lines ? track.lines.length : 0;
    return {
      score: frames ? inTune / frames : 0,
      frames,
      inTune,
      played,
      total,
      coverage: total ? played / total : 0,
    };
  }

  function validateTrack(track) {
    const errors = [];
    if (!track || typeof track !== 'object') return { ok: false, errors: ['track is not an object'] };
    for (const k of ['id', 'title', 'duration', 'fps']) {
      if (!(k in track)) errors.push('missing ' + k);
    }
    if (!Array.isArray(track.pitch)) errors.push('pitch is not an array');
    if (!Array.isArray(track.rms)) errors.push('rms is not an array');
    if (!Array.isArray(track.notes)) errors.push('notes is not an array');
    if (!Array.isArray(track.lines)) errors.push('lines is not an array');
    if (Array.isArray(track.pitch) && Array.isArray(track.rms) && track.duration && track.fps) {
      const need = Math.ceil(track.duration * track.fps);
      if (track.pitch.length !== need) errors.push(`pitch length ${track.pitch.length} != ${need}`);
      if (track.rms.length !== need) errors.push(`rms length ${track.rms.length} != ${need}`);
    }
    if (Array.isArray(track.notes)) {
      for (let i = 0; i < track.notes.length; i++) {
        const n = track.notes[i];
        if (!n || !(n.t1 > n.t0)) errors.push(`note ${i} has bad times`);
        if (i && track.notes[i - 1].t0 > n.t0) { errors.push('notes are not sorted'); break; }
      }
    }
    if (Array.isArray(track.lines)) {
      for (let i = 0; i < track.lines.length; i++) {
        const l = track.lines[i];
        if (!l || !(l.t1 >= l.t0)) errors.push(`line ${i} has bad times`);
        if (!Array.isArray(l.words)) errors.push(`line ${i} has no words`);
        if (i && track.lines[i - 1].t0 > l.t0) { errors.push('lines are not sorted'); break; }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  return {
    hzToMidi, midiToHz, foldOctave, centsBetween,
    pitchAt, noteAt, lineAt, wordAt,
    newAttempt, addFrame, finalizeAttempt, overall,
    validateTrack,
  };
});
