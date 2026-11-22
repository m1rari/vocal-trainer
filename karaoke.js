/* Karaoke mode: song library, playback, pitch lane and mic consumer. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const K = {};
  window.Karaoke = K;
  const C = window.KaraokeCore;

  const ui = {
    library: $('songsLibrary'),
    list: $('songList'),
    empty: $('songsEmpty'),
    count: $('songsCount'),
    karaoke: $('karaoke'),
    title: $('karaokeTitle'),
    artist: $('karaokeArtist'),
    back: $('karaokeBack'),
    song: $('songAudio'),
    guide: $('guideAudio'),
    lyricPrev: $('lyricPrev'),
    lyricCurrent: $('lyricCurrent'),
    lyricNext: $('lyricNext'),
    lane: $('karaokeLane'),
    play: $('karaokePlay'),
    time: $('karaokeTime'),
    progress: $('karaokeProgress'),
    progressFill: $('karaokeProgressFill'),
    loop: $('karaokeLoop'),
    speed: $('karaokeSpeed'),
    guideBtn: $('karaokeGuide'),
    micBtn: $('karaokeMic'),
    resultBtn: $('karaokeResult'),
    settingsBtn: $('karaokeSettingsBtn'),
    settings: $('karaokeSettings'),
    results: $('karaokeResults'),
    resultsBody: $('karaokeResultsBody'),
    resultsClose: $('karaokeResultsClose'),
    again: $('karaokeAgain'),
    hint: $('karaokeHint'),
    hintClose: $('karaokeHintClose'),
    vocalVol: $('karaokeVocalVol'),
    guideVol: $('karaokeGuideVol'),
    sync: $('karaokeSync'),
    syncVal: $('karaokeSyncVal'),
  };

  const state = {
    trackId: null,
    track: null,
    view: 'library',
    playing: false,
    raf: 0,
    lastLine: -2,
    lastWord: -2,
    lastPrev: null,
    lastNext: null,
    loop: null,
    speed: 1,
    guideOn: false,
    micOn: false,
    syncMs: 0,
    vocalVol: 1,
    guideVol: 0.35,
    hintSeen: false,
    lastGuideSync: 0,
    trail: [],
    lastT: 0,
    viewTime: 0,
    pendingSeek: null,
    session: { best: new Map(), current: null, active: false },
  };

  let manifest = null;
  let loading = null;

  const plural = (n, forms) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  };

  const fmt = s => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const noteName = m => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

  function distText(cents) {
    const a = Math.abs(cents) / 100;
    if (a < 0.75) return `${Math.round(Math.abs(cents))} центов`;
    const half = Math.round(a * 2) / 2;
    return `${String(half).replace('.', ',')} полутона`;
  }

  function resetSession() {
    state.session.best = new Map();
    state.session.current = null;
    state.session.active = false;
  }

  function startAttempt() {
    if (!state.track) return;
    if (state.session.active) endAttempt();
    state.session.current = C.newAttempt();
    state.session.active = true;
  }

  function endAttempt() {
    if (!state.session.active || !state.session.current) {
      state.session.active = false;
      state.session.current = null;
      return;
    }
    C.finalizeAttempt(state.session.best, state.session.current);
    state.session.active = false;
    state.session.current = null;
  }

  function addScoreFrame(t, midi) {
    if (!state.session.active || !state.session.current) return;
    C.addFrame(state.session.current, state.track, t, midi);
  }

  const LS_KEY = 'vt-songs';

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (typeof s.vocalVol === 'number') state.vocalVol = clamp(s.vocalVol, 0, 1);
      if (typeof s.guideVol === 'number') state.guideVol = clamp(s.guideVol, 0, 1);
      if (typeof s.speed === 'number') state.speed = s.speed === 0.75 ? 0.75 : 1;
      if (typeof s.syncMs === 'number') state.syncMs = clamp(s.syncMs, -300, 300);
      if (typeof s.hintSeen === 'boolean') state.hintSeen = s.hintSeen;
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        lastId: state.trackId,
        vocalVol: state.vocalVol,
        guideVol: state.guideVol,
        speed: state.speed,
        syncMs: state.syncMs,
        hintSeen: state.hintSeen,
      }));
    } catch (e) {}
  }

  function applyVolumes() {
    if (ui.song) ui.song.volume = state.vocalVol;
    if (ui.guide) ui.guide.volume = state.guideOn ? state.guideVol : 0;
  }

  function syncGuide(t) {
    if (!state.guideOn || !ui.guide.src || ui.guide.paused) return;
    const now = performance.now();
    if (now - state.lastGuideSync < 500) return;
    state.lastGuideSync = now;
    if (Math.abs(ui.guide.currentTime - t) > 0.06) ui.guide.currentTime = t;
  }

  function setGuide(on) {
    state.guideOn = !!on && !!ui.guide.src;
    ui.guideBtn.classList.toggle('on', state.guideOn);
    ui.guideBtn.textContent = state.guideOn ? 'Поводырь вкл' : 'Поводырь';
    applyVolumes();
    if (state.guideOn && state.playing) {
      ui.guide.currentTime = ui.song.currentTime;
      ui.guide.play().catch(() => {});
    } else {
      ui.guide.pause();
    }
  }

  function initials(t) {
    const a = (t.artist || '').trim();
    const title = (t.title || '').trim();
    return ((a[0] || '') + (title[0] || '')).toUpperCase() || '♪';
  }

  async function loadManifest() {
    if (manifest) return manifest;
    if (loading) return loading;
    loading = fetch('tracks/index.json', { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`tracks/index.json: ${r.status}`);
        return r.json();
      })
      .then(data => {
        manifest = data && Array.isArray(data.tracks) ? data : { tracks: [] };
        return manifest;
      })
      .catch(err => {
        manifest = { tracks: [], error: err.message };
        return manifest;
      })
      .finally(() => { loading = null; });
    return loading;
  }

  function renderList() {
    const tracks = (manifest && manifest.tracks) || [];
    ui.list.innerHTML = '';
    ui.count.textContent = tracks.length ? `${tracks.length} ${plural(tracks.length, ['песня', 'песни', 'песен'])}` : '';
    ui.empty.hidden = tracks.length > 0 && !manifest.error;
    ui.list.hidden = tracks.length === 0;

    tracks.forEach((t, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'song-card';
      card.dataset.id = t.id;

      const num = document.createElement('span');
      num.className = 'song-num';
      num.textContent = String(i + 1).padStart(2, '0');

      const cover = document.createElement('span');
      cover.className = 'song-cover';
      if (t.cover) {
        const img = document.createElement('img');
        img.src = t.dir + t.cover;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => { img.remove(); cover.textContent = initials(t); });
        cover.appendChild(img);
      } else {
        cover.textContent = initials(t);
      }

      const text = document.createElement('span');
      text.className = 'song-text';
      const title = document.createElement('span');
      title.className = 'song-title';
      title.textContent = t.title || t.id;
      const artist = document.createElement('span');
      artist.className = 'song-artist';
      artist.textContent = t.artist || '';
      text.append(title, artist);

      const dur = document.createElement('span');
      dur.className = 'song-duration';
      dur.textContent = fmt(t.duration);

      const go = document.createElement('span');
      go.className = 'song-go';
      go.textContent = 'Петь →';

      card.append(num, cover, text, dur, go);
      card.addEventListener('click', () => openTrack(t.id));
      ui.list.appendChild(card);
    });
  }

  function fail(message) {
    ui.karaoke.hidden = true;
    ui.library.hidden = false;
    ui.empty.hidden = false;
    const p = ui.empty.querySelector('p');
    if (p) p.textContent = message;
  }

  async function openTrack(id) {
    const t = manifest && manifest.tracks.find(x => x.id === id);
    if (!t) return fail('Песня не найдена в списке.');
    try {
      const res = await fetch(t.dir + 'track.json');
      if (!res.ok) throw new Error(`track.json: ${res.status}`);
      const track = await res.json();
      if (C) {
        const v = C.validateTrack(track);
        if (!v.ok) throw new Error(v.errors.join('; '));
      }
      if (!track.audio) throw new Error('track.audio отсутствует');

      state.trackId = id;
      state.track = track;
      state.view = 'player';
      state.lastLine = -2;
      state.lastWord = -2;
      state.lastPrev = null;
      state.lastNext = null;
      state.loop = null;
      state.trail.length = 0;
      state.lastT = 0;
      resetSession();
      setSpeed(state.speed);
      ui.loop.classList.remove('on');
      ui.loop.textContent = 'Фраза';
      ui.vocalVol.value = state.vocalVol;
      ui.guideVol.value = state.guideVol;
      ui.sync.value = state.syncMs;
      ui.syncVal.textContent = `${state.syncMs} мс`;
      ui.hint.hidden = state.hintSeen;
      setGuide(false);
      applyVolumes();
      saveSettings();

      ui.title.textContent = track.title || t.title;
      ui.artist.textContent = track.artist || t.artist || '';
      ui.song.src = t.dir + track.audio;
      ui.song.load();
      state.viewTime = 0;
      state.pendingSeek = null;
      ui.song.onloadedmetadata = () => {
        if (state.pendingSeek != null) {
          ui.song.currentTime = state.pendingSeek;
        } else {
          state.viewTime = ui.song.currentTime;
        }
        drawLane();
        updateLyrics(state.viewTime);
      };
      ui.song.onloadeddata = applyPendingSeek;
      ui.song.oncanplay = applyPendingSeek;
      if (track.guide) {
        ui.guide.src = t.dir + track.guide;
        ui.guide.load();
        ui.guideBtn.disabled = false;
      } else {
        ui.guide.removeAttribute('src');
        ui.guideBtn.disabled = true;
        ui.guideBtn.classList.remove('on');
      }
      ui.song.currentTime = 0;
      ui.time.textContent = `0:00 / ${fmt(track.duration)}`;
      ui.progressFill.style.width = '0%';
      ui.play.classList.remove('on');
      ui.results.hidden = true;
      ui.settings.hidden = true;
      ui.karaoke.hidden = false;
      ui.library.hidden = true;
      document.body.dataset.karaoke = 'player';
      updateLyrics(0);
      drawLane();
      history.replaceState(null, '', `?tab=songs&track=${encodeURIComponent(id)}`);
    } catch (err) {
      console.error(err);
      fail('Не удалось открыть песню: ' + err.message);
    }
  }

  function showLibrary() {
    pause();
    if (state.micOn && window.__vt) window.__vt.stopMic();
    state.view = 'library';
    delete document.body.dataset.karaoke;
    ui.karaoke.hidden = true;
    ui.library.hidden = false;
    history.replaceState(null, '', '?tab=songs');
  }

  async function play() {
    if (!state.track) return;
    if (ui.song.ended) ui.song.currentTime = 0;
    if (state.pendingSeek != null && ui.song.readyState >= 1) {
      ui.song.currentTime = state.pendingSeek;
      state.pendingSeek = null;
    }
    try {
      await ui.song.play();
    } catch (err) {
      console.warn(err);
      return;
    }
    state.playing = true;
    ui.play.classList.add('on');
    if (!state.session.active) startAttempt();
    applyVolumes();
    if (state.guideOn && ui.guide.src) {
      ui.guide.currentTime = ui.song.currentTime;
      state.lastGuideSync = performance.now();
      ui.guide.play().catch(() => {});
    }
    startTick();
  }

  function pause() {
    if (ui.song) ui.song.pause();
    if (ui.guide) ui.guide.pause();
    state.playing = false;
    ui.play.classList.remove('on');
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function applyPendingSeek() {
    if (state.pendingSeek == null || ui.song.readyState < 2) return;
    ui.song.currentTime = state.pendingSeek;
    if (ui.guide.src) ui.guide.currentTime = state.pendingSeek;
    state.pendingSeek = null;
  }

  function seek(t, keepLoop = false) {
    if (!state.track) return;
    if (!keepLoop) {
      state.loop = null;
      ui.loop.classList.remove('on');
      ui.loop.textContent = 'Фраза';
    }
    endAttempt();
    if (state.playing) startAttempt();
    const v = Math.max(0, Math.min(state.track.duration, t));
    state.viewTime = v;
    state.pendingSeek = v;
    if (ui.song.readyState >= 1) {
      ui.song.currentTime = v;
      if (ui.guide.src) ui.guide.currentTime = v;
    }
    state.lastLine = -2;
    state.lastWord = -2;
    state.trail.length = 0;
    updateProgress(v);
    updateLyrics(v);
    setTuner(null, state.micOn ? 'Слушай…' : 'Включи микрофон', '');
    drawLane();
  }

  function updateProgress(t) {
    const d = state.track ? state.track.duration : 0;
    ui.progressFill.style.width = d ? `${Math.min(100, t / d * 100)}%` : '0%';
    ui.time.textContent = `${fmt(t)} / ${fmt(d)}`;
    ui.progress.setAttribute('aria-valuemin', '0');
    ui.progress.setAttribute('aria-valuemax', String(Math.round(d)));
    ui.progress.setAttribute('aria-valuenow', String(Math.round(t)));
  }

  function updateLyrics(t) {
    const track = state.track;
    if (!track || !C) return;
    const lines = track.lines;
    const rawIdx = C.lineAt(track, t);
    let idx = rawIdx;

    let prev = -1;
    let next = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t1 <= t) prev = i;
      if (lines[i].t0 > t) { next = i; break; }
    }

    // A short breath between lines is not an interlude: keep the line on screen.
    if (idx < 0 && prev >= 0 && next >= 0 && lines[next].t0 - lines[prev].t1 < 1.2) {
      idx = prev;
    }
    const prevText = prev >= 0 ? lines[prev].text : '';
    const nextText = next >= 0 ? lines[next].text : '';
    if (prevText !== state.lastPrev) { ui.lyricPrev.textContent = prevText; state.lastPrev = prevText; }
    if (nextText !== state.lastNext) { ui.lyricNext.textContent = nextText; state.lastNext = nextText; }

    if (idx !== state.lastLine) {
      state.lastLine = idx;
      state.lastWord = -2;
      if (idx < 0) {
        ui.lyricCurrent.textContent = t < lines[0].t0 ? 'Вступление' : (prev >= lines.length - 1 ? 'Конец' : 'Проигрыш');
        return;
      }
      const line = lines[idx];
      ui.lyricCurrent.innerHTML = '';
      line.words.forEach((w, i) => {
        const s = document.createElement('span');
        s.className = 'w';
        s.textContent = w.text;
        ui.lyricCurrent.appendChild(s);
        if (i < line.words.length - 1 && !line.words[i + 1].text.startsWith('-')) {
          ui.lyricCurrent.appendChild(document.createTextNode(' '));
        }
      });
    }

    if (idx >= 0) {
      const wi = rawIdx < 0 ? lines[idx].words.length - 1 : C.wordAt(lines[idx], t);
      if (wi !== state.lastWord) {
        state.lastWord = wi;
        const spans = ui.lyricCurrent.querySelectorAll('.w');
        spans.forEach((s, i) => s.classList.toggle('on', i === wi));
      }
    }
  }

  function startTick() {
    if (!state.raf) state.raf = requestAnimationFrame(tick);
  }

  function tick() {
    state.raf = 0;
    if (!state.track || ui.song.paused) return;
    const t = ui.song.currentTime;
    state.lastT = t;
    state.viewTime = t;
    updateProgress(t);
    updateLyrics(t);
    syncGuide(t);
    drawLane();
    if (state.loop && t >= state.loop.t1 - 0.04) {
      endAttempt();
      ui.song.currentTime = state.loop.t0;
      if (ui.guide.src) ui.guide.currentTime = state.loop.t0;
      state.viewTime = state.loop.t0;
      state.lastLine = -2;
      state.lastWord = -2;
      state.trail.length = 0;
      startAttempt();
    }
    state.raf = requestAnimationFrame(tick);
  }

  function onMicFrame(f) {
    if (!state.track) return;
    const t = (state.playing ? ui.song.currentTime : state.viewTime) - state.syncMs / 1000;
    if (!state.playing) {
      updateTuner(t, f.midi);
      return;
    }
    if (f.midi == null) {
      addScoreFrame(t, null);
      updateTuner(t, null);
      return;
    }
    addScoreFrame(t, f.midi);
    pushPitch(f.midi, t, true);
  }

  async function toggleMic() {
    if (!window.__vt || !window.__vt.startMic) return;
    if (state.micOn) {
      window.__vt.stopMic();
      return;
    }
    ui.micBtn.disabled = true;
    const ok = await window.__vt.startMic('songs', onMicFrame);
    ui.micBtn.disabled = false;
    if (!ok) setTuner(null, 'Нет доступа к микрофону', 'Разреши микрофон в настройках браузера');
  }

  function setSpeed(rate) {
    state.speed = rate;
    if (ui.song) {
      ui.song.playbackRate = rate;
      ui.song.preservesPitch = true;
    }
    if (ui.guide) {
      ui.guide.playbackRate = rate;
      ui.guide.preservesPitch = true;
    }
    if (ui.speed) {
      ui.speed.textContent = rate === 1 ? '1×' : `${rate}×`;
      ui.speed.classList.toggle('on', rate !== 1);
    }
  }

  function toggleSpeed() {
    setSpeed(state.speed === 1 ? 0.75 : 1);
    saveSettings();
  }

  function loopPhrase(i) {
    if (!state.track || !state.track.lines[i]) return;
    const line = state.track.lines[i];
    state.loop = { t0: line.t0, t1: line.t1, line: i };
    ui.loop.classList.add('on');
    ui.loop.textContent = 'Фраза вкл';
    seek(line.t0, true);
  }

  function toggleLoop() {
    if (!state.track) return;
    if (state.loop) {
      state.loop = null;
      ui.loop.classList.remove('on');
      ui.loop.textContent = 'Фраза';
      return;
    }
    let idx = C.lineAt(state.track, state.viewTime);
    if (idx < 0) idx = state.track.lines.findIndex(l => l.t0 > state.viewTime);
    if (idx < 0) idx = state.track.lines.length - 1;
    loopPhrase(idx);
  }

  function showResults() {
    if (!state.track) return;
    pause();
    endAttempt();
    const ov = C.overall(state.session.best, state.track);
    ui.results.hidden = false;
    ui.resultsBody.innerHTML = '';
    const total = document.createElement('div');
    total.className = 'karaoke-result-total';
    total.innerHTML = `<b>${Math.round(ov.score * 100)}%</b> попаданий · ${ov.played} из ${ov.total} строк`;
    ui.resultsBody.appendChild(total);
    if (!ov.played) {
      const note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = 'Пока нет данных: спой хотя бы одну строку.';
      ui.resultsBody.appendChild(note);
    }
    state.track.lines.forEach((line, i) => {
      const s = state.session.best.get(i);
      const row = document.createElement('div');
      row.className = 'karaoke-line-result';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = line.text;
      btn.title = 'Зациклить строку';
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = s ? `${Math.round(s.score * 100)}%` : '—';
      const cents = document.createElement('span');
      cents.className = 'pct';
      cents.textContent = s && s.avgAbs != null ? `±${Math.round(s.avgAbs)}¢` : '';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = s ? `${Math.min(100, s.score * 100)}%` : '0%';
      bar.appendChild(fill);
      row.append(btn, pct, cents, bar);
      btn.addEventListener('click', () => {
        ui.results.hidden = true;
        loopPhrase(i);
      });
      ui.resultsBody.appendChild(row);
    });
  }

  function setTuner(cents, status, detail, cls) {
    const needle = $('karaokeNeedle');
    if (needle) {
      if (cents == null) {
        needle.style.opacity = '0';
      } else {
        needle.style.opacity = '1';
        needle.style.left = (50 + clamp(cents, -100, 100) / 2) + '%';
      }
    }
    setStatus(status, cls);
    const d = $('karaokeDetail');
    if (d) d.textContent = detail || '\u00a0';
  }

  function updateTuner(t, midi) {
    if (!state.track) return;
    const note = C.noteAt(state.track, t);
    if (midi == null) {
      setTuner(null, state.micOn ? 'Слушай…' : 'Включи микрофон', state.micOn ? 'Пой вместе с вокалом' : 'Разреши микрофон, чтобы видеть попадание');
      return;
    }
    if (!note) {
      setTuner(null, 'Слушай…', `Ты поёшь: ${noteName(midi)}`);
      return;
    }
    const cents = C.centsBetween(midi, note.midi);
    const detail = `Цель: ${noteName(note.midi)} · ты: ${noteName(midi)}`;
    if (Math.abs(cents) <= 25) setTuner(cents, 'Чисто ✓', detail, 'ok');
    else if (Math.abs(cents) <= 50) setTuner(cents, 'Попал, держи', detail, 'ok');
    else if (cents < 0) setTuner(cents, `Ниже на ${distText(cents)} — тяни вверх ↑`, detail, 'off');
    else setTuner(cents, `Выше на ${distText(cents)} — тяни вниз ↓`, detail, 'off');
  }

  function pushPitch(midi, t, playing) {
    if (midi == null) return;
    const note = state.track ? C.noteAt(state.track, t) : null;
    let v = midi;
    let ok = false;
    let cents = null;
    if (note) {
      cents = C.centsBetween(midi, note.midi);
      v = note.midi + C.foldOctave(midi - note.midi);
      ok = Math.abs(cents) <= 50;
    }
    const now = performance.now();
    state.trail.push({ t, v, ok, cents, now, playing: !!playing });
    const cutoff = t - 10;
    while (state.trail.length && state.trail[0].t < cutoff) state.trail.shift();
    while (state.trail.length > 500) state.trail.shift();
    updateTuner(t, midi);
  }

  // ---------- pitch lane ----------
  function drawLane() {
    const cv = ui.lane;
    if (!cv || !state.track) return;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const t = state.track ? state.viewTime : 0;
    const span = w < 560 ? 6 : 8;
    const t0 = t - span * 0.32;
    const t1 = t0 + span;
    const padL = 38;
    const padR = 10;
    const x = tt => padL + (w - padL - padR) * ((tt - t0) / (t1 - t0));
    const notes = state.track.notes.filter(n => n.t1 >= t0 && n.t0 <= t1);
    const active = C.noteAt(state.track, t);
    let lo = 60;
    let hi = 72;
    if (notes.length) {
      lo = Math.min(...notes.map(n => n.midi)) - 3;
      hi = Math.max(...notes.map(n => n.midi)) + 3;
    }
    if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = mid - 6; hi = mid + 6; }
    const y = m => h - 14 - (m - lo) / (hi - lo) * (h - 28);

    g.font = '600 10px "Golos Text", system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      const yy = Math.round(y(m)) + 0.5;
      g.strokeStyle = m % 12 === 0 ? 'rgba(242,236,225,.14)' : 'rgba(242,236,225,.055)';
      g.beginPath();
      g.moveTo(padL, yy);
      g.lineTo(w - padR, yy);
      g.stroke();
      if (m % 2 === 0) {
        g.fillStyle = m % 12 === 0 ? '#ada393' : '#6f6659';
        g.fillText(['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][((m % 12) + 12) % 12], 6, yy);
      }
    }

    for (const n of notes) {
      const x0 = Math.max(padL, x(n.t0));
      const x1 = Math.min(w - padR, x(n.t1));
      if (x1 <= x0) continue;
      const yy = y(n.midi);
      const hh = Math.max(5, Math.min(12, (h - 28) / (hi - lo) * 0.55));
      g.fillStyle = n === active ? 'rgba(235,201,140,.82)' : 'rgba(216,172,99,.30)';
      g.beginPath();
      if (g.roundRect) g.roundRect(x0, yy - hh / 2, x1 - x0, hh, 3);
      else g.rect(x0, yy - hh / 2, x1 - x0, hh);
      g.fill();
    }

    // reference curve
    g.strokeStyle = 'rgba(235,201,140,.55)';
    g.lineWidth = 1.3;
    g.beginPath();
    let started = false;
    for (let tt = Math.max(0, t0); tt <= Math.min(state.track.duration, t1); tt += 0.04) {
      const v = C.pitchAt(state.track, tt);
      if (v == null) { started = false; continue; }
      const xx = x(tt);
      const yy = y(v);
      if (!started) { g.moveTo(xx, yy); started = true; } else g.lineTo(xx, yy);
    }
    g.stroke();

    // live voice trail
    if (state.trail.length) {
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let i = 1; i < state.trail.length; i++) {
        const a = state.trail[i - 1];
        const b = state.trail[i];
        if (a.v == null || b.v == null) continue;
        if (b.t < t0 || a.t > t1 || b.now - a.now > 400) continue;
        g.strokeStyle = b.ok ? '#7bd3a6' : '#d8ac63';
        g.beginPath();
        g.moveTo(x(a.t), clamp(y(a.v), 3, h - 3));
        g.lineTo(x(b.t), clamp(y(b.v), 3, h - 3));
        g.stroke();
      }
      const tip = state.trail[state.trail.length - 1];
      if (tip && tip.v != null && t1 >= tip.t && tip.t >= t0) {
        const tx = x(tip.t);
        const ty = clamp(y(tip.v), 6, h - 6);
        g.fillStyle = tip.ok ? '#7bd3a6' : '#d8ac63';
        g.beginPath();
        g.arc(tx, ty, 6, 0, Math.PI * 2);
        g.fill();
        if (!tip.ok && active) {
          const up = tip.v < active.midi;
          const s = up ? -1 : 1;
          const ay = ty + s * 12;
          g.beginPath();
          g.moveTo(tx, ay + s * 9);
          g.lineTo(tx - 6, ay);
          g.lineTo(tx + 6, ay);
          g.closePath();
          g.fill();
        }
      }
    }

    // playhead
    const px = x(t);
    g.strokeStyle = 'rgba(242,236,225,.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, 4);
    g.lineTo(px, h - 4);
    g.stroke();
  }

  let statusText = '';
  let statusAt = 0;
  function setStatus(text, cls) {
    const el = $('karaokeStatus');
    if (!el) return;
    const now = performance.now();
    if (now - statusAt < 450) return;
    statusAt = now;
    statusText = text;
    el.textContent = text;
    el.className = 'karaoke-status' + (cls ? ' ' + cls : '');
  }

  // ---------- exported API ----------
  K.enter = async function () {
    if (!ui.library || !ui.karaoke) return;
    await loadManifest();
    renderList();
    const params = new URLSearchParams(location.search);
    const wanted = params.get('track');
    if (wanted && manifest.tracks.some(t => t.id === wanted)) {
      if (state.trackId !== wanted) await openTrack(wanted);
      else {
        state.view = 'player';
        ui.karaoke.hidden = false;
        ui.library.hidden = true;
        document.body.dataset.karaoke = 'player';
      }
    } else if (state.view === 'player' && state.trackId && state.track) {
      ui.karaoke.hidden = false;
      ui.library.hidden = true;
      document.body.dataset.karaoke = 'player';
    } else {
      ui.library.hidden = false;
      ui.karaoke.hidden = true;
      delete document.body.dataset.karaoke;
    }
    if (manifest.error) {
      ui.empty.hidden = false;
      const p = ui.empty.querySelector('p');
      if (p) p.textContent = 'Не удалось загрузить список песен.';
    }
  };

  K.leave = function () {
    pause();
    delete document.body.dataset.karaoke;
    if (window.__vt && state.micOn) window.__vt.stopMic?.();
  };

  K.onKey = function (e) {
    if (ui.karaoke.hidden) return;
    if (e.code === 'Escape') { e.preventDefault(); showLibrary(); }
    else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seek(ui.song.currentTime - 5); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seek(ui.song.currentTime + 5); }
    else if (e.code === 'KeyR') { e.preventDefault(); toggleLoop(); }
  };

  K.onMicStarted = () => {
    state.micOn = true;
    state.trail.length = 0;
    ui.micBtn.textContent = 'Микрофон вкл';
    ui.micBtn.classList.add('on');
    setTuner(null, 'Спой', 'Пой вместе с вокалом');
    ui.micBtn.disabled = false;
  };
  K.onMicStopped = () => {
    state.micOn = false;
    ui.micBtn.textContent = 'Микрофон';
    ui.micBtn.classList.remove('on');
    ui.micBtn.disabled = false;
    setTuner(null, 'Включи микрофон', '');
    state.trail.length = 0;
    drawLane();
  };
  K.onMicError = () => {
    state.micOn = false;
    ui.micBtn.textContent = 'Микрофон';
    ui.micBtn.classList.remove('on');
    ui.micBtn.disabled = false;
    setTuner(null, 'Нет доступа к микрофону', 'Разреши микрофон в настройках браузера');
  };

  K.open = openTrack;
  K.showLibrary = showLibrary;
  K.toggleMic = toggleMic;
  K.getState = () => ({ state, manifest });
  K.debug = {
    seek, play, pause, open: openTrack, state, drawLane, frame: onMicFrame,
    showResults, loopPhrase, setSpeed,
    pushPitch: (midi, t) => {
      if (t != null) state.viewTime = t;
      pushPitch(midi, state.viewTime, state.playing);
      drawLane();
    },
  };

  ui.back?.addEventListener('click', showLibrary);
  ui.play?.addEventListener('click', togglePlay);
  ui.micBtn?.addEventListener('click', toggleMic);
  ui.progress?.addEventListener('click', e => {
    if (!state.track) return;
    const r = ui.progress.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * state.track.duration);
  });
  ui.progress?.addEventListener('keydown', e => {
    if (e.code === 'ArrowLeft') { e.preventDefault(); seek(ui.song.currentTime - 5); }
    if (e.code === 'ArrowRight') { e.preventDefault(); seek(ui.song.currentTime + 5); }
  });
  ui.settingsBtn?.addEventListener('click', () => { ui.settings.hidden = !ui.settings.hidden; });
  ui.resultBtn?.addEventListener('click', showResults);
  ui.loop?.addEventListener('click', toggleLoop);
  ui.speed?.addEventListener('click', toggleSpeed);
  ui.resultsClose?.addEventListener('click', () => { ui.results.hidden = true; });
  ui.again?.addEventListener('click', () => {
    ui.results.hidden = true;
    resetSession();
    seek(0);
    play();
  });
  ui.song?.addEventListener('ended', () => {
    endAttempt();
    showResults();
  });

  ui.guideBtn?.addEventListener('click', () => { setGuide(!state.guideOn); saveSettings(); });
  ui.vocalVol?.addEventListener('input', () => {
    state.vocalVol = Number(ui.vocalVol.value);
    applyVolumes();
    saveSettings();
  });
  ui.guideVol?.addEventListener('input', () => {
    state.guideVol = Number(ui.guideVol.value);
    applyVolumes();
    saveSettings();
  });
  ui.sync?.addEventListener('input', () => {
    state.syncMs = Number(ui.sync.value);
    ui.syncVal.textContent = `${state.syncMs} мс`;
    saveSettings();
  });
  ui.hintClose?.addEventListener('click', () => {
    state.hintSeen = true;
    ui.hint.hidden = true;
    saveSettings();
  });

  loadSettings();
  if (ui.vocalVol) ui.vocalVol.value = state.vocalVol;
  if (ui.guideVol) ui.guideVol.value = state.guideVol;
  if (ui.sync) ui.sync.value = state.syncMs;
  if (ui.syncVal) ui.syncVal.textContent = `${state.syncMs} мс`;
  applyVolumes();

  if (document.body.dataset.tab === 'songs') K.enter();
})();
