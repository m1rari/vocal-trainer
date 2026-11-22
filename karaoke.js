/* Karaoke mode: song library, playback, pitch lane and mic consumer. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const K = {};
  window.Karaoke = K;

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
  };

  let manifest = null;
  let currentId = null;
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
    if (!Number.isFinite(s)) return '0:00';
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
    ui.empty.hidden = tracks.length > 0;
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

  async function openTrack(id) {
    currentId = id;
    console.log('karaoke: open', id);
  }

  K.enter = async function () {
    if (!ui.library || !ui.karaoke) return;
    ui.karaoke.hidden = true;
    ui.library.hidden = false;
    await loadManifest();
    renderList();
    if (manifest && manifest.error) {
      ui.empty.hidden = false;
      ui.empty.querySelector('p').textContent = 'Не удалось загрузить список песен.';
    }
  };

  K.leave = function () {
    if (ui.song && !ui.song.paused) ui.song.pause();
    if (ui.guide && !ui.guide.paused) ui.guide.pause();
  };

  K.onKey = function (e) {
    if (e.code === 'Escape') {
      e.preventDefault();
      ui.library.hidden = false;
      ui.karaoke.hidden = true;
    }
  };

  K.open = openTrack;
  K.getState = () => ({ currentId, manifest });

  ui.back?.addEventListener('click', () => {
    ui.karaoke.hidden = true;
    ui.library.hidden = false;
  });

  if (document.body.dataset.tab === 'songs') K.enter();
})();
