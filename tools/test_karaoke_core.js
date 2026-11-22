'use strict';

const assert = require('assert');
const C = require('../karaoke-core.js');

// ---------- pitch maths ----------
assert.strictEqual(Math.round(C.hzToMidi(440)), 69);
assert.strictEqual(Math.round(C.midiToHz(69)), 440);
assert.strictEqual(C.foldOctave(12), 0);
assert.strictEqual(C.foldOctave(13), 1);
assert.strictEqual(C.foldOctave(-13), -1);
assert.strictEqual(Math.round(C.centsBetween(81, 69)), 0);
assert.strictEqual(Math.round(C.centsBetween(69.5, 69)), 50);

// ---------- synthetic track ----------
const pitch = new Array(20).fill(57);
pitch[10] = 59;
pitch[5] = null;
pitch[6] = null;
const track = {
  id: 'x',
  title: 'X',
  duration: 2,
  fps: 10,
  pitch,
  rms: new Array(20).fill(0.1),
  notes: [{ t0: 0.5, t1: 1.5, midi: 57, conf: 0.9 }],
  lines: [{
    t0: 0.5,
    t1: 1.5,
    text: 'a b',
    words: [
      { t0: 0.5, t1: 1.0, text: 'a' },
      { t0: 1.0, t1: 1.5, text: 'b' },
    ],
  }],
};

assert.strictEqual(C.pitchAt(track, 0), 57);
assert.strictEqual(C.pitchAt(track, 1.0), 59);
assert.strictEqual(C.pitchAt(track, 0.95), 58);
assert.strictEqual(C.pitchAt(track, 0.5), null);
assert.strictEqual(C.pitchAt(track, 2), 57);

assert.strictEqual(C.noteAt(track, 0.51), null);
assert.ok(C.noteAt(track, 0.6));
assert.ok(C.noteAt(track, 1.4));
assert.strictEqual(C.noteAt(track, 1.43), null);

assert.strictEqual(C.lineAt(track, 0.5), 0);
assert.strictEqual(C.lineAt(track, 1.5), 0);
assert.strictEqual(C.lineAt(track, 1.6), -1);
assert.strictEqual(C.wordAt(track.lines[0], 0.6), 0);
assert.strictEqual(C.wordAt(track.lines[0], 1.1), 1);
assert.strictEqual(C.wordAt(track.lines[0], 1.6), -1);

// ---------- scoring ----------
let attempt = C.newAttempt();
for (let i = 0; i < 10; i++) C.addFrame(attempt, track, 0.6 + i * 0.08, 57);
let best = new Map();
C.finalizeAttempt(best, attempt);
assert.strictEqual(best.get(0).score, 1);
assert.strictEqual(best.get(0).frames, 10);
assert.strictEqual(best.get(0).voiced, 10);

attempt = C.newAttempt();
for (let i = 0; i < 10; i++) C.addFrame(attempt, track, 0.6 + i * 0.08, i < 5 ? null : 57);
best = new Map();
C.finalizeAttempt(best, attempt);
assert.strictEqual(best.get(0).score, 0.5);
assert.strictEqual(best.get(0).voicedRatio, 0.5);

attempt = C.newAttempt();
for (let i = 0; i < 10; i++) C.addFrame(attempt, track, 0.6 + i * 0.08, 69);
best = new Map();
C.finalizeAttempt(best, attempt);
assert.strictEqual(best.get(0).score, 1);

// best-of-two
best = new Map();
C.finalizeAttempt(best, (() => {
  const a = C.newAttempt();
  for (let i = 0; i < 10; i++) C.addFrame(a, track, 0.6 + i * 0.08, i < 3 ? 57 : 60);
  return a;
})());
const weak = best.get(0).score;
C.finalizeAttempt(best, (() => {
  const a = C.newAttempt();
  for (let i = 0; i < 10; i++) C.addFrame(a, track, 0.6 + i * 0.08, 57);
  return a;
})());
assert.ok(best.get(0).score > weak);
const strong = best.get(0).score;
C.finalizeAttempt(best, (() => {
  const a = C.newAttempt();
  for (let i = 0; i < 10; i++) C.addFrame(a, track, 0.6 + i * 0.08, 60);
  return a;
})());
assert.strictEqual(best.get(0).score, strong);

// ---------- overall excludes unplayed lines ----------
const track2 = {
  id: 'y', title: 'Y', duration: 5, fps: 10,
  pitch: new Array(50).fill(57), rms: new Array(50).fill(0.1),
  notes: [
    { t0: 0.5, t1: 1.5, midi: 57, conf: 0.9 },
    { t0: 3.5, t1: 4.5, midi: 60, conf: 0.9 },
  ],
  lines: [
    { t0: 0.5, t1: 1.5, text: 'a', words: [{ t0: 0.5, t1: 1.5, text: 'a' }] },
    { t0: 3.5, t1: 4.5, text: 'b', words: [{ t0: 3.5, t1: 4.5, text: 'b' }] },
  ],
};
const a2 = C.newAttempt();
for (let i = 0; i < 10; i++) C.addFrame(a2, track2, 0.6 + i * 0.08, 57);
const b2 = new Map();
C.finalizeAttempt(b2, a2);
const ov = C.overall(b2, track2);
assert.strictEqual(ov.score, 1);
assert.strictEqual(ov.played, 1);
assert.strictEqual(ov.total, 2);
assert.strictEqual(ov.coverage, 0.5);

// ---------- validation ----------
assert.deepStrictEqual(C.validateTrack(track), { ok: true, errors: [] });
const bad = C.validateTrack({ ...track, pitch: pitch.slice(0, 10) });
assert.strictEqual(bad.ok, false);
assert.ok(bad.errors.some(e => e.includes('pitch length')));

console.log('ok: karaoke core');
