(() => {
  'use strict';

  // ---------- Constants ----------
  const MIN_MIDI = 48;  // C3 — lowest viola string
  const MAX_MIDI = 84;  // C6
  const FILE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const EN = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const RU = ['До', 'До♯', 'Ре', 'Ми♭', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Ля♭', 'Ля', 'Си♭', 'Си'];
  const OCT_RU = { 2: 'большая октава', 3: 'малая октава', 4: 'первая октава', 5: 'вторая октава', 6: 'третья октава' };
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const RING_LEN = 339.3;
  const PATTERNS = [
    { id: 'tri3', name: 'Три ступени', deg: '1‑2‑3‑2‑1', off: [0, 2, 4, 2, 0] },
    { id: 'five', name: 'Пять ступеней', deg: '1‑2‑3‑4‑5‑4‑3‑2‑1', off: [0, 2, 4, 5, 7, 5, 4, 2, 0] },
    { id: 'triad', name: 'Трезвучие', deg: '1‑3‑5‑3‑1', off: [0, 4, 7, 4, 0] },
    { id: 'oct', name: 'Октава', deg: '1‑5‑8‑5‑1', off: [0, 7, 12, 7, 0] },
    { id: 'semi', name: 'Полутон', deg: 'нота – выше – нота', off: [0, 1, 0] },
  ];
  const TITLES = { notes: 'Ноты', chant: 'Распевки', mic: 'Микрофон', settings: 'Настройки' };

  const isBlack = m => BLACK.has(m % 12);
  const octave = m => Math.floor(m / 12) - 1;
  const fileOf = m => `sounds/viola/${FILE_NAMES[m % 12]}${octave(m)}.mp3`;
  const sci = m => `${EN[m % 12]}${octave(m)}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- Settings ----------
  const DEFAULTS = {
    lo: 53, hi: 65, chromatic: false, order: 'up', pause: 4, reps: 1, len: 4, names: 'ru',
    pattern: 'tri3', tempo: 0.7, micAdvance: true, micMode: 'target', micLive: true, tab: 'notes',
  };
  let S = { ...DEFAULTS };
  try {
    const old = JSON.parse(localStorage.getItem('vt-settings') || '{}'); // v1: keep the range only
    for (const k of ['lo', 'hi', 'chromatic', 'order', 'names']) if (k in old) S[k] = old[k];
    Object.assign(S, JSON.parse(localStorage.getItem('vt-settings-2') || '{}'));
  } catch (e) {}
  const save = () => { try { localStorage.setItem('vt-settings-2', JSON.stringify(S)); } catch (e) {} };

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const el = {
    title: $('viewTitle'), phase: $('phase'), orb: $('orb'), ring: $('ringFg'), name: $('noteName'), solf: $('noteSolf'),
    counter: $('counter'), prev: $('prevBtn'), next: $('nextBtn'), auto: $('autoBtn'), hint: $('hint'),
    lo: $('loVal'), hi: $('hiVal'), count: $('rangeCount'), kb: $('kb'), kbWrap: $('kbWrap'),
    chromatic: $('chromatic'), loader: $('loader'), loaderText: $('loaderText'), patterns: $('patternList'),
    tabbar: $('tabbar'), vTrain: $('viewTrain'), vMic: $('viewMic'), vSettings: $('viewSettings'),
    micNote: $('micNote'), micNoteSub: $('micNoteSub'), micStatus: $('micStatus'), micDetail: $('micDetail'),
    needle: $('needle'), holdBar: $('holdBar'), micToggle: $('micToggle'), micPlay: $('micPlay'),
    micAdvance: $('micAdvance'), micHits: $('micHits'), graph: $('micGraph'), level: $('micLevel'), micLive: $('micLive'),
  };

  // =====================================================================
  // Audio engine
  // Every "cycle" (note + silence to sing, or a whole chant) is rendered into one WAV
  // and played through a plain <audio> element. To the phone / CarPlay this looks like
  // a normal music track: no timers, no Web Audio output, keeps playing with the screen off.
  // =====================================================================
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: 44100 }); } catch (e) { ctx = new AC(); }
  const SR = ctx.sampleRate;
  const pcm = new Map();    // midi -> Float32Array (mono, normalised)
  const loops = new Map();  // midi -> { ls, le, xf }

  async function loadSamples() {
    const midis = [];
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) midis.push(m);
    let done = 0;
    await Promise.all(midis.map(async m => {
      const res = await fetch(fileOf(m));
      if (!res.ok) throw new Error(`${fileOf(m)}: ${res.status}`);
      const arr = await res.arrayBuffer();
      const buf = await new Promise((ok, fail) => ctx.decodeAudioData(arr, ok, fail));
      const n = buf.length, mono = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[i];
      }
      let peak = 1e-6;
      for (let i = 0; i < n; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
      const g = 0.8 / peak;
      for (let i = 0; i < n; i++) mono[i] *= g;
      pcm.set(m, mono);
      done++;
      el.loaderText.textContent = `Загружаю звуки альта… ${Math.round(done / midis.length * 100)}%`;
    }));
  }

  // Find a sustain loop whose end is in phase with its start, so notes can ring for any length.
  function loopOf(m) {
    if (loops.has(m)) return loops.get(m);
    const x = pcm.get(m);
    const xf = Math.floor(0.12 * SR);
    const ls = Math.floor(1.0 * SR);
    const maxEnd = Math.min(x.length - Math.floor(0.08 * SR), Math.floor(2.9 * SR));
    const span = Math.floor(0.7 * SR); // wide search: vibrato makes many candidates a poor match
    const W = 1024;
    let ea = 1e-9;
    for (let i = 0; i < W; i++) ea += x[ls - W + i] * x[ls - W + i];
    let best = maxEnd - ls, bestC = -Infinity;
    for (let L = maxEnd - ls - span; L <= maxEnd - ls; L++) {
      let c = 0, e = 1e-9;
      for (let i = 0; i < W; i++) {
        const a = x[ls - W + i], b = x[ls + L - W + i];
        c += a * b; e += b * b;
      }
      c /= Math.sqrt(e * ea);
      if (c > bestC) { bestC = c; best = L; }
    }
    const info = { ls, le: ls + best, xf };
    loops.set(m, info);
    return info;
  }

  function noteInto(out, offset, m, dur, fadeSec) {
    const x = pcm.get(m);
    if (!x) return;
    const { ls, le, xf } = loopOf(m);
    const n = Math.min(Math.floor(dur * SR), out.length - offset);
    const fade = Math.min(Math.floor(fadeSec * SR), n >> 1);
    const L = le - ls;
    let pos = 0;
    for (let i = 0; i < n; i++) {
      let v = x[pos];
      if (pos >= le - xf) { const k = (pos - (le - xf)) / xf; v = v * (1 - k) + x[pos - L] * k; }
      if (++pos >= le) pos = ls;
      const rem = n - i;
      if (rem < fade) v *= 0.5 - 0.5 * Math.cos(Math.PI * rem / fade);
      out[offset + i] += v;
    }
  }

  function renderWav(events, total) {
    const n = Math.ceil(total * SR);
    const mix = new Float32Array(n);
    for (const ev of events) noteInto(mix, Math.floor(ev.t0 * SR), ev.midi, ev.t1 - ev.t0 + (ev.tail || 0), ev.fade || 0.3);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    const pcm16 = new Int16Array(buf, 44, n);
    for (let i = 0; i < n; i++) pcm16[i] = clamp(mix[i], -1, 1) * 32767;
    return new Blob([buf], { type: 'audio/wav' });
  }

  const audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  let unlocked = false;
  let activeSpec = null;
  let activeUrl = null;
  let switching = false;

  // iOS only lets an <audio> element start from a user gesture; after one such start
  // the same element may be restarted from code (which is what auto mode needs).
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    audio.src = URL.createObjectURL(renderWav([], 0.05));
    audio.play().catch(() => {});
  }

  function playSpec(spec) {
    switching = true;
    const oldUrl = activeUrl;
    activeUrl = URL.createObjectURL(renderWav(spec.events, spec.dur));
    activeSpec = spec;
    lastSeg = null; lastHl = undefined;
    audio.src = activeUrl;
    const p = audio.play();
    if (p) p.catch(() => {});
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    setTimeout(() => { switching = false; }, 300);
    played++;
    renderCounter();
    startTick();
  }

  // ---------- Playback-synchronised UI ----------
  let rafId = 0, lastSeg = null, lastHl;
  function startTick() { if (!rafId) rafId = requestAnimationFrame(tick); }
  function tick() {
    rafId = 0;
    if (!activeSpec || audio.paused || audio.ended) return;
    const t = audio.currentTime;
    const seg = activeSpec.segs.find(s => t >= s.t0 && t < s.t1);
    if (seg && seg !== lastSeg) { lastSeg = seg; setPhase(seg.kind, seg.label); }
    if (seg) setRing((t - seg.t0) / (seg.t1 - seg.t0));
    const ev = activeSpec.events.find(e => t >= e.t0 && t < e.t1);
    const hl = ev ? ev.midi : null;
    if (hl !== lastHl) { lastHl = hl; renderKeyboard(hl); if (mode() === 'chant') renderNote(hl); }
    rafId = requestAnimationFrame(tick);
  }

  audio.addEventListener('ended', () => {
    if (!activeSpec) return;
    if (auto) { advance(); playSpec(buildSpec(true)); return; }
    activeSpec = null;
    idleUi();
  });
  // Paused from outside (phone call, CarPlay pause button, another app)
  audio.addEventListener('pause', () => {
    setTimeout(() => { if (auto && audio.paused && !audio.ended && !switching) stopAuto(); }, 200);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!audio.paused) startTick();
    if (auto) { wakeLock = null; requestWake(); }
  });

  // =====================================================================
  // Training modes
  // =====================================================================
  const mode = () => (S.tab === 'chant' ? 'chant' : 'notes');
  let cur = null;          // current note (notes + mic)
  let dir = 1;
  const history = [];
  let chRoot = null;       // current chant root
  let chDir = 1;
  let played = 0;
  let auto = false;
  let wakeLock = null;

  function pool() {
    const out = [];
    for (let m = S.lo; m <= S.hi; m++) if (S.chromatic || !isBlack(m)) out.push(m);
    return out;
  }
  const pattern = () => PATTERNS.find(p => p.id === S.pattern) || PATTERNS[0];
  function chantBounds() {
    const span = Math.max(...pattern().off);
    const lo = Math.min(S.lo, MAX_MIDI - span);
    return { lo, hi: Math.max(lo, Math.min(S.hi, MAX_MIDI) - span) };
  }

  function computeNext() {
    const p = pool();
    if (!p.length) return null;
    if (cur == null || !p.includes(cur)) {
      if (S.order === 'random') return p[Math.floor(Math.random() * p.length)];
      if (S.order === 'down') return p[p.length - 1];
      dir = 1;
      return p[0];
    }
    const i = p.indexOf(cur);
    switch (S.order) {
      case 'up': return p[(i + 1) % p.length];
      case 'down': return p[(i - 1 + p.length) % p.length];
      case 'updown': {
        if (p.length === 1) return p[0];
        if (dir === 1 && i === p.length - 1) dir = -1;
        else if (dir === -1 && i === 0) dir = 1;
        return p[i + dir];
      }
      default: {
        if (p.length === 1) return p[0];
        let m;
        do { m = p[Math.floor(Math.random() * p.length)]; } while (m === cur);
        return m;
      }
    }
  }

  function noteNext() {
    const m = computeNext();
    if (m == null) return;
    if (cur != null) history.push(cur);
    if (history.length > 200) history.shift();
    cur = m;
  }
  function notePrev() {
    if (history.length) { cur = history.pop(); return; }
    if (cur == null) { noteNext(); return; }
    const p = pool(), i = p.indexOf(cur);
    if (i >= 0) cur = p[(i - 1 + p.length) % p.length];
  }
  function chantStep(sign) {
    const { lo, hi } = chantBounds();
    if (chRoot == null) { chRoot = lo; chDir = 1; return; }
    if (sign < 0) { chRoot = clamp(chRoot - chDir, lo, hi); return; }
    if (lo === hi) { chRoot = lo; return; }
    if (chRoot + chDir > hi) chDir = -1;
    else if (chRoot + chDir < lo) chDir = 1;
    chRoot = clamp(chRoot + chDir, lo, hi);
  }
  function ensureItem() {
    if (mode() === 'chant') {
      const { lo, hi } = chantBounds();
      if (chRoot == null) { chRoot = lo; chDir = 1; } else chRoot = clamp(chRoot, lo, hi);
    } else if (cur == null) noteNext();
  }
  function advance() { mode() === 'chant' ? chantStep(1) : noteNext(); afterItemChange(); }
  function back() { mode() === 'chant' ? chantStep(-1) : notePrev(); afterItemChange(); }
  function afterItemChange() { renderNote(); renderKeyboard(); updateMediaMeta(); renderMicTarget(); }

  function buildSpec(isAuto) {
    const events = [], segs = [];
    let t = 0;
    if (mode() === 'chant') {
      const off = pattern().off, step = S.tempo;
      off.forEach((o, i) => {
        const d = i === off.length - 1 ? step * 2 : step;
        events.push({ midi: chRoot + o, t0: t, t1: t + d, tail: i === off.length - 1 ? 0 : 0.05, fade: i === off.length - 1 ? 0.3 : 0.09 });
        t += d;
      });
      segs.push({ t0: 0, t1: t, kind: 'listen', label: 'Слушай' });
      if (isAuto) { const p = t + 0.5; segs.push({ t0: t, t1: t + p, kind: 'sing', label: 'Пой!' }); t += p; }
    } else {
      const reps = isAuto ? S.reps : 1;
      for (let r = 0; r < reps; r++) {
        events.push({ midi: cur, t0: t, t1: t + S.len });
        segs.push({ t0: t, t1: t + S.len, kind: 'listen', label: r ? `Слушай ещё раз (${r + 1}/${reps})` : 'Слушай' });
        t += S.len;
        if (isAuto) { segs.push({ t0: t, t1: t + S.pause, kind: 'sing', label: 'Пой!' }); t += S.pause; }
      }
    }
    return { events, segs, dur: t + 0.05 };
  }

  // ---------- Transport ----------
  function startAuto() {
    unlock();
    ensureItem();
    auto = true;
    el.auto.classList.add('on');
    requestWake();
    setMediaState('playing');
    afterItemChange();
    playSpec(buildSpec(true));
  }
  function stopAuto() {
    auto = false;
    audio.pause();
    activeSpec = null;
    el.auto.classList.remove('on');
    releaseWake();
    setMediaState('paused');
    idleUi();
  }
  function playOnce() {
    unlock();
    ensureItem();
    afterItemChange();
    playSpec(buildSpec(auto));
  }

  function idleUi() {
    setPhase('', hasItem() ? 'Тап по кругу — повторить' : 'Нажми ▶, чтобы начать');
    setRing(null);
    renderNote();
    renderKeyboard();
  }
  const hasItem = () => (mode() === 'chant' ? chRoot != null : cur != null);

  async function requestWake() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

  // =====================================================================
  // Rendering
  // =====================================================================
  function setPhase(kind, text) {
    el.phase.className = 'phase' + (kind ? ' ' + kind : '');
    el.phase.textContent = text;
    el.orb.classList.toggle('playing', kind === 'listen');
    el.orb.classList.toggle('singing', kind === 'sing');
  }
  function setRing(frac) {
    el.ring.style.opacity = frac == null ? '0' : '1';
    el.ring.style.strokeDashoffset = frac == null ? RING_LEN : RING_LEN * (1 - clamp(frac, 0, 1));
  }

  function nameHtml(m) {
    return S.names === 'ru' ? RU[m % 12] : `${EN[m % 12]}<sub>${octave(m)}</sub>`;
  }
  function renderNote(sounding) {
    const chant = mode() === 'chant';
    const base = chant ? chRoot : cur;
    if (base == null) {
      el.name.textContent = '—';
      el.solf.textContent = chant ? `${pattern().name} · ${pattern().deg}` : ' ';
      return;
    }
    const m = sounding != null ? sounding : base;
    el.name.innerHTML = nameHtml(m);
    if (chant) el.solf.textContent = `${pattern().name} от ${sci(chRoot)}`;
    else el.solf.textContent = S.names === 'ru' ? `${sci(m)} · ${OCT_RU[octave(m)] || ''}` : `${RU[m % 12]} · ${OCT_RU[octave(m)] || ''}`;
  }

  function renderCounter() {
    el.counter.textContent = played ? `Сыграно за сессию: ${played}` : ' ';
  }

  function renderRange() {
    el.lo.textContent = sci(S.lo);
    el.hi.textContent = sci(S.hi);
    el.count.textContent = mode() === 'chant' ? '' : `· ${pool().length} нот`;
    el.chromatic.checked = S.chromatic;
  }

  const KEY_W = 40;
  function buildKeyboard() {
    el.kb.innerHTML = '';
    let wi = 0;
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const k = document.createElement('div');
      k.dataset.m = m;
      if (isBlack(m)) { k.className = 'bk'; k.style.left = (wi * KEY_W - 14) + 'px'; }
      else { k.className = 'wk'; k.textContent = m % 12 === 0 ? sci(m) : ''; wi++; }
      el.kb.appendChild(k);
    }
    // click (not pointerdown) so that scrolling the keyboard does not trigger notes
    el.kb.addEventListener('click', e => {
      const k = e.target.closest('[data-m]');
      if (!k) return;
      const m = +k.dataset.m;
      if (mode() === 'chant') {
        const { lo, hi } = chantBounds();
        chRoot = clamp(m, lo, hi);
      } else {
        if (cur != null && cur !== m) history.push(cur);
        cur = m;
      }
      playOnce();
    });
  }
  function renderKeyboard(hl) {
    const chant = mode() === 'chant';
    const mark = hl != null ? hl : (chant ? chRoot : cur);
    for (const k of el.kb.children) {
      const m = +k.dataset.m;
      k.classList.toggle('in', m >= S.lo && m <= S.hi);
      k.classList.toggle('excluded', !chant && isBlack(m) && !S.chromatic);
      k.classList.toggle('cur', m === mark);
    }
  }
  function scrollKeyboardToRange(smooth) {
    const keys = [...el.kb.children];
    const a = keys.find(k => +k.dataset.m === S.lo), b = keys.find(k => +k.dataset.m === S.hi);
    if (!a || !b) return;
    const mid = (a.offsetLeft + b.offsetLeft + b.offsetWidth) / 2;
    el.kbWrap.scrollTo({ left: mid - el.kbWrap.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
  }

  function renderPatterns() {
    el.patterns.innerHTML = '';
    for (const p of PATTERNS) {
      const b = document.createElement('button');
      b.className = 'list-item' + (p.id === S.pattern ? ' active' : '');
      b.innerHTML = `<span>${p.name}</span><span class="list-sub">${p.deg}</span>`;
      b.addEventListener('click', () => {
        S.pattern = p.id; save(); renderPatterns();
        if (chRoot != null) { const { lo, hi } = chantBounds(); chRoot = clamp(chRoot, lo, hi); }
        if (auto) playOnce(); else { renderNote(); renderKeyboard(); }
      });
      el.patterns.appendChild(b);
    }
  }

  function bindSegs() {
    document.querySelectorAll('[data-seg]').forEach(seg => {
      const key = seg.dataset.seg;
      const parse = seg.hasAttribute('data-num') ? Number : (v => v);
      const sync = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', parse(b.dataset.v) === S[key]));
      seg.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        S[key] = parse(b.dataset.v);
        save(); sync();
        if (key === 'order') dir = 1;
        if (key === 'names') { renderNote(); renderMicTarget(); }
        if (key === 'micMode') applyMicMode();
      });
      sync();
    });
  }

  function setTab(tab) {
    const wasTrain = S.tab === 'notes' || S.tab === 'chant';
    const isTrain = tab === 'notes' || tab === 'chant';
    if (tab !== S.tab && (auto || !audio.paused) && !(wasTrain && tab === 'settings')) {
      if (auto) stopAuto(); else { audio.pause(); activeSpec = null; }
    }
    if (S.tab === 'mic' && tab !== 'mic') stopMic();
    if (tab !== 'settings') { S.tab = tab; save(); }
    el.title.textContent = TITLES[tab];
    el.vTrain.hidden = !isTrain;
    el.vMic.hidden = tab !== 'mic';
    el.vSettings.hidden = tab !== 'settings';
    document.body.dataset.mode = isTrain ? tab : '';
    el.tabbar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (isTrain) {
      el.hint.textContent = tab === 'chant'
        ? '▶ — распевка сама поднимается по полутону и спускается обратно. После каждой — пауза, чтобы повторить.'
        : '▶ — авторежим: нота → пауза, чтобы спеть → следующая. Тап по кругу — повторить.';
      renderRange();
      if (!auto) idleUi();
      requestAnimationFrame(() => scrollKeyboardToRange(false));
    }
    if (tab === 'mic') { if (cur == null) noteNext(); applyMicMode(); }
    window.scrollTo(0, 0);
  }

  // =====================================================================
  // Microphone pitch check
  // =====================================================================
  let mic = null; // { ctx, stream, src, analyser, buf, raf }
  let micHold = 0, micMiss = 0, micLast = 0, micHits = 0, micFrame = 0, micDone = false;
  const recent = [];

  // Pitch detector (McLeod method: normalised autocorrelation, so it does not depend on
  // how loud the microphone is). Returns Hz or -1.
  function detectPitch(input, sr) {
    let buf = input;
    if (sr >= 40000) {                    // halve the rate: 4x cheaper, still accurate to a few cents
      const h = input.length >> 1;
      buf = new Float32Array(h);
      for (let i = 0; i < h; i++) buf[i] = (input[2 * i] + input[2 * i + 1]) * 0.5;
      sr /= 2;
    }
    const n = buf.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    let rms = 0;
    for (let i = 0; i < n; i++) { const a = buf[i] - mean; rms += a * a; }
    rms = Math.sqrt(rms / n);
    if (rms < 0.0012) return -1;          // real silence only; quiet iPhone input still passes
    const minLag = Math.floor(sr / 1200), maxLag = Math.min(Math.floor(sr / 65), (n >> 1) - 2);
    const nsdf = new Float32Array(maxLag + 2);
    for (let tau = 0; tau <= maxLag + 1; tau++) {
      let acf = 0, m = 0;
      for (let j = 0; j < n - tau; j++) {
        const a = buf[j] - mean, b = buf[j + tau] - mean;
        acf += a * b; m += a * a + b * b;
      }
      nsdf[tau] = m > 0 ? 2 * acf / m : 0;
    }
    let tau = 1;
    while (tau <= maxLag && nsdf[tau] > 0) tau++;     // skip the zero-lag lobe
    const peaks = [];
    let best = -1;
    for (; tau <= maxLag; tau++) {
      if (nsdf[tau] > 0) { if (best < 0 || nsdf[tau] > nsdf[best]) best = tau; }
      else if (best >= 0) { if (best >= minLag) peaks.push(best); best = -1; }
    }
    if (best >= minLag && best < maxLag && nsdf[best] >= nsdf[best + 1]) peaks.push(best);
    if (!peaks.length) return -1;
    let top = 0;
    for (const p of peaks) if (nsdf[p] > top) top = nsdf[p];
    if (top < 0.55) return -1;            // not a clear tone (noise, consonants)
    const p = peaks.find(q => nsdf[q] >= 0.9 * top);  // first strong peak = true period, not an octave below
    const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
    const shift = (a - 2 * b + c) ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    return sr / (p + shift);
  }

  async function startMic() {
    let mctx = null;
    try {
      // Own context at the device's native rate: an iPhone garbles microphone audio
      // when it is pulled into a context with a forced sample rate.
      mctx = new AC();
      // Echo cancellation removes our own note from the microphone, so you can sing along with it.
      // It also switches the iPhone to its voice-processing input, which is much louder than the raw one.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: false, channelCount: 1 },
      });
      if (mctx.state !== 'running') await mctx.resume();
      const src = mctx.createMediaStreamSource(stream);
      const analyser = mctx.createAnalyser();
      analyser.fftSize = 4096;
      src.connect(analyser);
      mic = { ctx: mctx, stream, src, analyser, buf: new Float32Array(analyser.fftSize), bytes: null, raf: 0 };
      el.micToggle.textContent = 'Выключить микрофон';
      el.micToggle.classList.add('on');
      resetHold();
      micUi(null, isFree() ? 'Спой любую ноту' : 'Спой ноту', ' ');
      micLast = performance.now();
      mic.raf = requestAnimationFrame(micTick);
    } catch (e) {
      if (mctx) try { mctx.close(); } catch (e2) {}
      el.micStatus.textContent = 'Нет доступа к микрофону';
      el.micDetail.textContent = 'Разреши доступ в настройках браузера и попробуй ещё раз.';
    }
  }
  function stopMic() {
    if (!mic) return;
    cancelAnimationFrame(mic.raf);
    mic.stream.getTracks().forEach(t => t.stop());
    try { mic.src.disconnect(); mic.ctx.close(); } catch (e) {}
    mic = null;
    el.micToggle.textContent = 'Включить микрофон';
    el.micToggle.classList.remove('on');
    el.level.style.width = '0%';
    micUi(null, 'Включи микрофон и спой ноту', ' ');
  }
  function readMic() {
    const a = mic.analyser;
    if (a.getFloatTimeDomainData) { a.getFloatTimeDomainData(mic.buf); return mic.buf; }
    if (!mic.bytes) mic.bytes = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(mic.bytes);
    for (let i = 0; i < mic.bytes.length; i++) mic.buf[i] = (mic.bytes[i] - 128) / 128;
    return mic.buf;
  }

  function resetHold() {
    micHold = 0; micMiss = 0; micDone = false; recent.length = 0; trail.length = 0;
    el.holdBar.style.width = '0%';
  }

  function micUi(cents, status, detail, cls) {
    el.micStatus.textContent = status;
    el.micStatus.className = 'gauge-status' + (cls ? ' ' + cls : '');
    el.micDetail.textContent = detail;
    el.needle.style.opacity = cents == null ? '0' : '1';
    if (cents != null) el.needle.style.left = (50 + clamp(cents, -100, 100) / 2) + '%';
    el.needle.classList.toggle('ok', cls === 'ok');
  }

  const isFree = () => S.micMode === 'free';
  const semiWord = n => (n === 1 ? 'полутон' : n < 5 ? 'полутона' : 'полутонов');
  // "how far" in plain words: cents when close, semitones when far
  function distText(diff) {
    const a = Math.abs(diff);
    if (a < 0.75) return `${Math.round(a * 100)} центов`;
    const half = Math.round(a * 2) / 2;
    return Number.isInteger(half) ? `${half} ${semiWord(half)}` : `${String(half).replace('.', ',')} полутона`;
  }

  function micTick(now) {
    if (!mic) return;
    mic.raf = requestAnimationFrame(micTick);
    const dt = Math.min(0.1, (now - micLast) / 1000);
    if (++micFrame % 2) return;           // ~30 analyses per second is plenty
    micLast = now;
    if (mic.ctx.state !== 'running') { mic.ctx.resume().catch(() => {}); return; }  // e.g. after a phone call
    const buf = readMic();
    let peak = 0;
    for (let i = 0; i < buf.length; i += 4) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    el.level.style.width = Math.min(100, Math.sqrt(peak) * 130) + '%';
    if (micDone) { drawGraph(now); return; }
    const playing = !audio.paused && !audio.ended;
    if (playing && !S.micLive) {          // optional: ignore the mic while our own note sounds
      micUi(null, 'Слушай…', ' ');
      resetHold();
      drawGraph(now);
      return;
    }
    handlePitch(detectPitch(buf, mic.ctx.sampleRate), dt, now, playing);
  }

  function handlePitch(f, dt, now, playing) {
    if (f < 0) {
      micMiss += dt;
      if (micMiss > 0.4) {
        micHold = 0; el.holdBar.style.width = '0%'; recent.length = 0;
        if (trail.length && trail[trail.length - 1].v != null) trail.push({ t: now, v: null });
        micUi(null, playing ? 'Пой вместе с нотой' : isFree() ? 'Спой любую ноту' : 'Спой ноту', ' ');
        if (isFree()) { el.micNote.textContent = '—'; el.micNoteSub.textContent = 'ты поёшь'; }
      }
      drawGraph(now);
      return;
    }
    recent.push(69 + 12 * Math.log2(f / 440));
    if (recent.length > 5) recent.shift();
    const sung = [...recent].sort((a, b) => a - b)[recent.length >> 1];
    const hz = `${Math.round(440 * Math.pow(2, (sung - 69) / 12))} Гц`;

    if (isFree()) {
      // Free tuner: nearest note + how far you are from it
      micMiss = 0;
      const near = clamp(Math.round(sung), 0, 127);
      const cents = (sung - near) * 100;
      el.micNote.innerHTML = nameHtml(near);
      el.micNoteSub.textContent = `ты поёшь · ${sci(near)}`;
      trail.push({ t: now, v: sung });
      const detail = `${cents >= 0 ? '+' : '−'}${Math.abs(Math.round(cents))} центов · ${hz}`;
      if (Math.abs(cents) <= 15) micUi(cents * 2, 'Чисто ✓', detail, 'ok');
      else micUi(cents * 2, cents < 0 ? 'Занижаешь — тяни вверх ↑' : 'Завышаешь — тяни вниз ↓', detail, 'off');
      drawGraph(now);
      return;
    }

    let diff = sung - cur;
    diff -= 12 * Math.round(diff / 12);   // any octave counts
    const cents = diff * 100;
    trail.push({ t: now, v: cur + diff });
    const sungName = (S.names === 'ru' ? RU : EN)[((Math.round(sung) % 12) + 12) % 12];
    const detail = `Ты поёшь: ${sungName} · ${hz}`;
    if (Math.abs(cents) <= 30) {
      micMiss = 0;
      micHold += dt;
      micUi(cents, 'Попал! Держи…', detail, 'ok');
    } else {
      micMiss += dt;
      if (micMiss > 0.3) micHold = 0;
      micUi(cents, cents < 0 ? `Ниже на ${distText(diff)} — тяни вверх ↑` : `Выше на ${distText(diff)} — тяни вниз ↓`, detail, 'off');
    }
    el.holdBar.style.width = Math.min(100, micHold / 1.0 * 100) + '%';
    drawGraph(now);
    if (micHold >= 1.0) micHit();
  }

  function micHit() {
    micDone = true;
    micHits++;
    el.micHits.textContent = micHits;
    micUi(0, '✓ Отлично, попал!', ' ', 'ok');
    setTimeout(() => {
      if (!mic) return;
      if (S.micAdvance) { noteNext(); afterItemChange(); playOnce(); }
      resetHold();
    }, 1100);
  }

  // ---------- Pitch graph: where your voice is relative to the notes, over the last seconds ----------
  const trail = [];          // { t, v } — v is a (fractional) MIDI note, null = silence
  const GRAPH_SEC = 6;
  let graphCenter = 57;
  function drawGraph(now) {
    const cv = el.graph;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    now = now || performance.now();
    while (trail.length && now - trail[0].t > GRAPH_SEC * 1000) trail.shift();

    const free = isFree();
    let last = null;
    for (let i = trail.length - 1; i >= 0 && !last; i--) if (trail[i].v != null) last = trail[i];
    if (free && last) graphCenter += (last.v - graphCenter) * 0.08;   // follow the voice smoothly
    const center = free ? graphCenter : (cur == null ? 57 : cur);
    const half = free ? 3.5 : 6.6;
    const padL = 38, padR = 14;
    const y = v => h / 2 - (v - center) / half * (h / 2);
    const x = t => padL + (w - padL - padR) * (1 - (now - t) / (GRAPH_SEC * 1000));
    const names = S.names === 'ru' ? RU : EN;

    if (!free && cur != null) {           // green target band
      g.fillStyle = 'rgba(74,222,128,.16)';
      g.fillRect(padL, y(cur + 0.3), w - padL, y(cur - 0.3) - y(cur + 0.3));
    }
    g.font = '600 10.5px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let m = Math.ceil(center - half); m <= Math.floor(center + half); m++) {
      const yy = Math.round(y(m)) + 0.5;
      const isTarget = !free && m === cur;
      g.strokeStyle = isTarget ? 'rgba(74,222,128,.7)' : 'rgba(255,255,255,.07)';
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(w, yy); g.stroke();
      g.fillStyle = isTarget ? '#4ade80' : '#6f7c86';
      g.fillText(names[((m % 12) + 12) % 12], 6, yy);
    }

    // voice trail
    const good = v => (free ? Math.abs(v - Math.round(v)) <= 0.15 : Math.abs(v - cur) <= 0.3);
    g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      if (a.v == null || b.v == null || b.t - a.t > 300) continue;
      g.strokeStyle = good(b.v) ? '#4ade80' : '#ffb547';
      g.beginPath(); g.moveTo(x(a.t), clamp(y(a.v), 3, h - 3)); g.lineTo(x(b.t), clamp(y(b.v), 3, h - 3)); g.stroke();
    }
    const tip = trail[trail.length - 1];
    if (tip && tip.v != null && now - tip.t < 300) {
      const ok = good(tip.v);
      const ty = clamp(y(tip.v), 6, h - 6);
      g.fillStyle = ok ? '#4ade80' : '#ffb547';
      g.beginPath(); g.arc(x(tip.t), ty, 6, 0, Math.PI * 2); g.fill();
      if (!free && !ok) {                 // arrow pointing towards the target
        const up = tip.v < cur, ax = x(tip.t), s = up ? -1 : 1, ay = ty + s * 12;
        g.beginPath(); g.moveTo(ax, ay + s * 9); g.lineTo(ax - 6, ay); g.lineTo(ax + 6, ay); g.closePath(); g.fill();
      }
    }
  }

  function applyMicMode() {
    document.body.dataset.mic = S.micMode;
    resetHold();
    renderMicTarget();
    micUi(null, !mic ? 'Включи микрофон и спой ноту' : isFree() ? 'Спой любую ноту' : 'Спой ноту', ' ');
  }

  function renderMicTarget() {
    if (isFree()) { el.micNote.textContent = '—'; el.micNoteSub.textContent = 'ты поёшь'; }
    else if (cur != null) { el.micNote.innerHTML = nameHtml(cur); el.micNoteSub.textContent = `цель · ${sci(cur)}`; }
    drawGraph();
  }
  function micStep(d) {
    unlock();
    const next = clamp((cur == null ? S.lo : cur) + d, MIN_MIDI, MAX_MIDI);
    if (cur != null && next !== cur) history.push(cur);
    cur = next;
    afterItemChange();
    resetHold();
    playSpec(buildSpec(false));
  }

  // =====================================================================
  // Media Session (car / headset buttons)
  // =====================================================================
  function updateMediaMeta() {
    if (!('mediaSession' in navigator)) return;
    const chant = mode() === 'chant';
    const m = chant ? chRoot : cur;
    if (m == null) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chant ? `${pattern().name} от ${sci(m)}` : `${RU[m % 12]} · ${sci(m)}`,
        artist: 'Попади в ноту — альт',
        album: `Диапазон ${sci(S.lo)}–${sci(S.hi)}`,
        artwork: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch (e) {}
  }
  function setMediaState(s) {
    if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = s; } catch (e) {}
  }
  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
    h('play', () => startAuto());
    h('pause', () => stopAuto());
    h('stop', () => stopAuto());
    h('nexttrack', () => { advance(); playOnce(); });
    h('previoustrack', () => { back(); playOnce(); });
  }

  // =====================================================================
  // Wire up
  // =====================================================================
  el.orb.addEventListener('click', playOnce);
  el.next.addEventListener('click', () => { if (hasItem()) advance(); playOnce(); });
  el.prev.addEventListener('click', () => { if (hasItem()) back(); playOnce(); });
  el.auto.addEventListener('click', () => (auto ? stopAuto() : startAuto()));

  document.querySelectorAll('.stepper button').forEach(b => b.addEventListener('click', () => {
    const d = +b.dataset.d;
    if (b.dataset.r === 'lo') S.lo = clamp(S.lo + d, MIN_MIDI, S.hi - 1);
    else S.hi = clamp(S.hi + d, S.lo + 1, MAX_MIDI);
    save(); renderRange(); renderKeyboard(); scrollKeyboardToRange(true); updateMediaMeta();
  }));
  el.chromatic.addEventListener('change', () => { S.chromatic = el.chromatic.checked; save(); renderRange(); renderKeyboard(); });

  el.tabbar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

  el.micToggle.addEventListener('click', () => { unlock(); mic ? stopMic() : startMic(); });
  el.micPlay.addEventListener('click', () => { unlock(); resetHold(); playSpec(buildSpec(false)); });
  $('micPrev').addEventListener('click', () => micStep(-1));
  $('micNext').addEventListener('click', () => micStep(1));
  el.micAdvance.checked = S.micAdvance;
  el.micAdvance.addEventListener('change', () => { S.micAdvance = el.micAdvance.checked; save(); });
  el.micLive.checked = S.micLive;
  el.micLive.addEventListener('change', () => { S.micLive = el.micLive.checked; save(); });

  document.addEventListener('keydown', e => {
    if (S.tab !== 'notes' && S.tab !== 'chant') return;
    if (e.code === 'Space') { e.preventDefault(); el.auto.click(); }
    else if (e.code === 'ArrowRight') el.next.click();
    else if (e.code === 'ArrowLeft') el.prev.click();
    else if (e.code === 'Enter') playOnce();
  });

  buildKeyboard();
  bindSegs();
  renderPatterns();
  renderCounter();
  bindMediaSession();
  setTab(S.tab in TITLES ? S.tab : 'notes');

  window.__vt = { detectPitch, handlePitch, trail, pcm, loopOf, get SR() { return SR; }, audio };

  loadSamples()
    .then(() => {
      el.loader.classList.add('hidden');
      // Pre-compute sustain loops in the background (range first) so the first play is instant
      const order = [...pcm.keys()].sort((a, b) => Math.abs(a - S.lo) - Math.abs(b - S.lo));
      const work = () => { const m = order.shift(); if (m == null) return; loopOf(m); setTimeout(work, 15); };
      setTimeout(work, 50);
    })
    .catch(err => { el.loaderText.textContent = 'Не удалось загрузить звуки: ' + err.message; });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
