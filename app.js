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

  const isBlack = m => BLACK.has(m % 12);
  const octave = m => Math.floor(m / 12) - 1;
  const fileOf = m => `sounds/viola/${FILE_NAMES[m % 12]}${octave(m)}.mp3`;
  const sci = m => `${EN[m % 12]}${octave(m)}`;

  // ---------- Settings ----------
  const DEFAULTS = { lo: 53, hi: 65, chromatic: false, order: 'up', pause: 3, reps: 1, len: 2, names: 'ru' };
  let S = { ...DEFAULTS };
  try { Object.assign(S, JSON.parse(localStorage.getItem('vt-settings') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('vt-settings', JSON.stringify(S)); } catch (e) {} };

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const el = {
    phase: $('phase'), orb: $('orb'), ring: $('ringFg'), name: $('noteName'), solf: $('noteSolf'),
    counter: $('counter'), prev: $('prevBtn'), next: $('nextBtn'), auto: $('autoBtn'),
    lo: $('loVal'), hi: $('hiVal'), count: $('rangeCount'), kb: $('kb'), kbWrap: $('kbWrap'),
    chromatic: $('chromatic'), loader: $('loader'), loaderText: $('loaderText'),
  };

  // ---------- Audio ----------
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const buffers = new Map();
  let voice = null; // { src, gain }

  async function loadSamples() {
    const midis = [];
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) midis.push(m);
    let done = 0;
    await Promise.all(midis.map(async m => {
      const res = await fetch(fileOf(m));
      const arr = await res.arrayBuffer();
      const buf = await new Promise((ok, fail) => ctx.decodeAudioData(arr, ok, fail));
      buffers.set(m, buf);
      done++;
      el.loaderText.textContent = `Загружаю звуки альта… ${Math.round(done / midis.length * 100)}%`;
    }));
  }

  function stopVoice(fade = 0.06) {
    if (!voice) return;
    const { src, gain } = voice;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + fade);
    try { src.stop(t + fade + 0.02); } catch (e) {}
    voice = null;
  }

  function playMidi(m) {
    const buf = buffers.get(m);
    if (!buf) return;
    if (ctx.state !== 'running') ctx.resume();
    stopVoice();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime + 0.01;
    const len = Math.min(S.len, buf.duration);
    const fade = 0.35;
    gain.gain.setValueAtTime(1, t);
    gain.gain.setValueAtTime(1, t + Math.max(0.1, len - fade));
    gain.gain.linearRampToValueAtTime(0, t + len);
    src.start(t);
    src.stop(t + len + 0.05);
    const v = { src, gain };
    voice = v;
    src.onended = () => { if (voice === v) voice = null; };
    played++;
    renderCounter();
  }

  // Silent looping <audio> keeps the media session alive (steering-wheel / headset buttons)
  // and makes iOS route Web Audio through the media channel even in silent mode.
  let silentAudio = null;
  function makeSilentWav(seconds = 1, rate = 8000) {
    const n = seconds * rate;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function ensureSession() {
    if (ctx.state !== 'running') ctx.resume();
    if (!silentAudio) {
      silentAudio = new Audio(makeSilentWav());
      silentAudio.loop = true;
      silentAudio.setAttribute('playsinline', '');
    }
    if (silentAudio.paused) silentAudio.play().catch(() => {});
  }

  // ---------- Sequence ----------
  let cur = null;
  let dir = 1;
  const history = [];
  let played = 0;

  function pool() {
    const out = [];
    for (let m = S.lo; m <= S.hi; m++) if (S.chromatic || !isBlack(m)) out.push(m);
    return out;
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
      case 'random': {
        if (p.length === 1) return p[0];
        let m;
        do { m = p[Math.floor(Math.random() * p.length)]; } while (m === cur);
        return m;
      }
    }
    return p[0];
  }

  function goNext() {
    const m = computeNext();
    if (m == null) return;
    if (cur != null) history.push(cur);
    if (history.length > 200) history.shift();
    setCurrent(m);
  }

  function goPrev() {
    if (history.length) { setCurrent(history.pop()); return; }
    if (cur == null) { goNext(); return; }
    // No history: step backwards in the ordered list
    const p = pool();
    const i = p.indexOf(cur);
    if (i >= 0) setCurrent(p[(i - 1 + p.length) % p.length]);
  }

  function setCurrent(m) {
    cur = m;
    renderNote();
    renderKeyboard();
    updateMediaMeta();
  }

  // ---------- Auto mode ----------
  let autoToken = null;
  let wakeLock = null;

  const sleep = (ms, tok) => new Promise(res => {
    const id = setTimeout(res, ms);
    tok.cancel.push(() => { clearTimeout(id); res(); });
  });

  async function autoLoop(tok, advanceFirst) {
    if (advanceFirst || cur == null) goNext();
    while (tok.on) {
      for (let r = 0; r < S.reps && tok.on; r++) {
        setPhase('listen', r > 0 ? `Слушай ещё раз (${r + 1}/${S.reps})` : 'Слушай');
        playMidi(cur);
        await sleep(Math.min(S.len, 3) * 1000 + 150, tok);
        if (!tok.on) return;
        setPhase('sing', 'Пой!', S.pause);
        await sleep(S.pause * 1000, tok);
      }
      if (tok.on) goNext();
    }
  }

  function startAuto(advanceFirst) {
    stopAuto(false);
    ensureSession();
    autoToken = { on: true, cancel: [] };
    el.auto.classList.add('on');
    requestWake();
    setMediaState('playing');
    autoLoop(autoToken, advanceFirst);
  }

  function stopAuto(resetUi = true) {
    if (autoToken) {
      autoToken.on = false;
      autoToken.cancel.forEach(f => f());
      autoToken = null;
    }
    if (resetUi) {
      el.auto.classList.remove('on');
      setPhase('', cur == null ? 'Нажми ▶, чтобы начать' : 'Тап по кругу — повторить ноту');
      releaseWake();
      setMediaState('paused');
    }
  }

  const isAuto = () => !!(autoToken && autoToken.on);

  async function requestWake() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isAuto()) { wakeLock = null; requestWake(); }
  });

  // ---------- Manual actions ----------
  function manualStep(fn) {
    ensureSession();
    fn();
    if (isAuto()) startAuto(false); // restart cycle on the newly selected note
    else { playMidi(cur); flashPlaying(); }
  }

  function replay() {
    if (cur == null) { manualStep(goNext); return; }
    ensureSession();
    if (isAuto()) startAuto(false);
    else { playMidi(cur); flashPlaying(); }
  }

  let flashTimer = null;
  function flashPlaying() {
    setPhase('listen', 'Слушай и повтори');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (!isAuto()) setPhase('', 'Тап по кругу — повторить ноту'); }, Math.min(S.len, 3) * 1000);
  }

  // ---------- Rendering ----------
  function setPhase(kind, text, ringSeconds) {
    el.phase.className = 'phase' + (kind ? ' ' + kind : '');
    el.phase.textContent = text;
    el.orb.classList.toggle('playing', kind === 'listen');
    el.orb.classList.toggle('singing', kind === 'sing');
    const r = el.ring;
    r.style.transition = 'none';
    r.style.strokeDashoffset = RING_LEN;
    r.style.opacity = ringSeconds ? '1' : '0';
    if (ringSeconds) {
      r.getBoundingClientRect(); // reflow so the transition restarts
      r.style.transition = `stroke-dashoffset ${ringSeconds}s linear`;
      r.style.strokeDashoffset = 0;
    }
  }

  function renderNote() {
    if (cur == null) { el.name.textContent = '—'; el.solf.innerHTML = '&nbsp;'; return; }
    const pc = cur % 12, oc = octave(cur);
    if (S.names === 'ru') {
      el.name.innerHTML = `${RU[pc]}`;
      el.solf.textContent = `${sci(cur)} · ${OCT_RU[oc] || ''}`;
    } else {
      el.name.innerHTML = `${EN[pc]}<sub>${oc}</sub>`;
      el.solf.textContent = `${RU[pc]} · ${OCT_RU[oc] || ''}`;
    }
  }

  function renderCounter() {
    const n = played;
    const word = (n % 10 === 1 && n % 100 !== 11) ? 'нота'
      : ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) ? 'ноты' : 'нот';
    el.counter.textContent = `${n} ${word} за сессию`;
  }

  function renderRange() {
    el.lo.textContent = sci(S.lo);
    el.hi.textContent = sci(S.hi);
    el.count.textContent = `· ${pool().length} нот`;
    el.chromatic.checked = S.chromatic;
  }

  const KEY_W = 40; // white width + gap
  function buildKeyboard() {
    el.kb.innerHTML = '';
    let wi = 0;
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const k = document.createElement('div');
      k.dataset.m = m;
      if (isBlack(m)) {
        k.className = 'bk';
        k.style.left = (wi * KEY_W - 14) + 'px';
      } else {
        k.className = 'wk';
        k.textContent = m % 12 === 0 ? sci(m) : '';
        wi++;
      }
      el.kb.appendChild(k);
    }
    el.kb.addEventListener('pointerdown', e => {
      const k = e.target.closest('[data-m]');
      if (!k) return;
      const m = +k.dataset.m;
      if (cur != null && cur !== m) history.push(cur);
      ensureSession();
      setCurrent(m);
      if (isAuto()) startAuto(false); else { playMidi(m); flashPlaying(); }
    });
  }

  function renderKeyboard() {
    for (const k of el.kb.children) {
      const m = +k.dataset.m;
      const inRange = m >= S.lo && m <= S.hi;
      k.classList.toggle('in', inRange);
      k.classList.toggle('excluded', isBlack(m) && !S.chromatic);
      k.classList.toggle('cur', m === cur);
    }
  }

  function scrollKeyboardToRange(smooth) {
    const keys = [...el.kb.children];
    const a = keys.find(k => +k.dataset.m === S.lo);
    const b = keys.find(k => +k.dataset.m === S.hi);
    if (!a || !b) return;
    const mid = (a.offsetLeft + b.offsetLeft + b.offsetWidth) / 2;
    el.kbWrap.scrollTo({ left: mid - el.kbWrap.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
  }

  function bindSeg(id, key, parse = v => v, after) {
    const seg = $(id);
    const sync = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', parse(b.dataset.v) === S[key]));
    seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      S[key] = parse(b.dataset.v);
      save(); sync(); after && after();
    });
    sync();
  }

  // ---------- Media Session (car / headset buttons) ----------
  function updateMediaMeta() {
    if (!('mediaSession' in navigator) || cur == null) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${RU[cur % 12]} · ${sci(cur)}`,
        artist: 'Попади в ноту — альт',
        album: `Диапазон ${sci(S.lo)}–${sci(S.hi)}`,
        artwork: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }],
      });
    } catch (e) {}
  }
  function setMediaState(s) {
    if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = s; } catch (e) {}
  }
  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
    h('play', () => startAuto(cur == null));
    h('pause', () => stopAuto());
    h('stop', () => stopAuto());
    h('nexttrack', () => manualStep(goNext));
    h('previoustrack', () => manualStep(goPrev));
  }

  // ---------- Wire up ----------
  el.orb.addEventListener('click', replay);
  el.next.addEventListener('click', () => manualStep(goNext));
  el.prev.addEventListener('click', () => manualStep(goPrev));
  el.auto.addEventListener('click', () => isAuto() ? stopAuto() : startAuto(cur == null));

  document.querySelectorAll('.stepper button').forEach(b => b.addEventListener('click', () => {
    const d = +b.dataset.d;
    if (b.dataset.r === 'lo') S.lo = Math.max(MIN_MIDI, Math.min(S.hi - 1, S.lo + d));
    else S.hi = Math.min(MAX_MIDI, Math.max(S.lo + 1, S.hi + d));
    save(); renderRange(); renderKeyboard(); scrollKeyboardToRange(true); updateMediaMeta();
  }));
  el.chromatic.addEventListener('change', () => {
    S.chromatic = el.chromatic.checked; save(); renderRange(); renderKeyboard();
  });

  bindSeg('orderSeg', 'order', v => v, () => { dir = 1; });
  bindSeg('pauseSeg', 'pause', Number);
  bindSeg('repSeg', 'reps', Number);
  bindSeg('lenSeg', 'len', Number);
  bindSeg('namesSeg', 'names', v => v, renderNote);

  // Keyboard shortcuts for desktop testing
  document.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); el.auto.click(); }
    else if (e.code === 'ArrowRight') manualStep(goNext);
    else if (e.code === 'ArrowLeft') manualStep(goPrev);
    else if (e.code === 'Enter') replay();
  });

  buildKeyboard();
  renderRange();
  renderKeyboard();
  renderNote();
  renderCounter();
  bindMediaSession();
  requestAnimationFrame(() => scrollKeyboardToRange(false));

  loadSamples()
    .then(() => el.loader.classList.add('hidden'))
    .catch(err => { el.loaderText.textContent = 'Не удалось загрузить звуки: ' + err.message; });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
