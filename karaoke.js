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
  };

  const state = {
    trackId: null,
    track: null,
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
    trail: [],
    lastT: 0,
    viewTime: 0,
    pendingSeek: null,
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
      state.lastLine = -2;
      state.lastWord = -2;
      state.lastPrev = null;
      state.lastNext = null;
      state.loop = null;
      state.trail.length = 0;
      state.lastT = 0;

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
    if (state.guideOn && ui.guide.src) {
      ui.guide.currentTime = ui.song.currentTime;
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

  function seek(t) {
    if (!state.track) return;
    const v = Math.max(0, Math.min(state.track.duration, t));
    state.viewTime = v;
    state.pendingSeek = v;
    if (ui.song.readyState >= 1) {
      ui.song.currentTime = v;
      if (ui.guide.src) ui.guide.currentTime = v;
    }
    state.lastLine = -2;
    state.lastWord = -2;
    updateProgress(v);
    updateLyrics(v);
    drawLane();
  }

  function updateProgress(t) {
    const d = state.track ? state.track.duration : 0;
    ui.progressFill.style.width = d ? `${Math.min(100, t / d * 100)}%` : '0%';
    ui.time.textContent = `${fmt(t)} / ${fmt(d)}`;
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
    drawLane();
    if (state.loop && t >= state.loop.t1 - 0.04) {
      ui.song.currentTime = state.loop.t0;
      if (ui.guide.src) ui.guide.currentTime = state.loop.t0;
      state.lastLine = -2;
      state.lastWord = -2;
    }
    state.raf = requestAnimationFrame(tick);
  }

  // ---------- pitch lane (filled in task 5) ----------
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

    g.fillStyle = 'rgba(216,172,99,.30)';
    for (const n of notes) {
      const x0 = Math.max(padL, x(n.t0));
      const x1 = Math.min(w - padR, x(n.t1));
      if (x1 <= x0) continue;
      const yy = y(n.midi);
      const hh = Math.max(5, Math.min(12, (h - 28) / (hi - lo) * 0.55));
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

    // playhead
    const px = x(t);
    g.strokeStyle = 'rgba(242,236,225,.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, 4);
    g.lineTo(px, h - 4);
    g.stroke();
  }

  function setStatus(text, cls) {
    const el = $('karaokeStatus');
    if (!el) return;
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
      else { ui.karaoke.hidden = false; ui.library.hidden = true; }
    } else if (state.trackId && state.track) {
      ui.karaoke.hidden = false;
      ui.library.hidden = true;
    } else {
      ui.library.hidden = false;
      ui.karaoke.hidden = true;
    }
    if (manifest.error) {
      ui.empty.hidden = false;
      const p = ui.empty.querySelector('p');
      if (p) p.textContent = 'Не удалось загрузить список песен.';
    }
  };

  K.leave = function () {
    pause();
    if (window.__vt && state.micOn) window.__vt.stopMic?.();
  };

  K.onKey = function (e) {
    if (ui.karaoke.hidden) return;
    if (e.code === 'Escape') { e.preventDefault(); showLibrary(); }
    else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seek(ui.song.currentTime - 5); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seek(ui.song.currentTime + 5); }
  };

  K.open = openTrack;
  K.showLibrary = showLibrary;
  K.getState = () => ({ state, manifest });
  K.debug = { seek, play, pause, open: openTrack, state };

  ui.back?.addEventListener('click', showLibrary);
  ui.play?.addEventListener('click', togglePlay);
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
  ui.song?.addEventListener('ended', () => {
    pause();
    setStatus('Песня закончилась');
  });

  if (document.body.dataset.tab === 'songs') K.enter();
})();
