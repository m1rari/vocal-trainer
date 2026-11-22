// Offline cache: app shell, viola samples, karaoke tracks on demand.
const VERSION = 'vt-v6';
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SAMPLES = [];
for (let o = 3; o <= 5; o++) for (const n of NAMES) SAMPLES.push(`sounds/viola/${n}${o}.mp3`);
SAMPLES.push('sounds/viola/C6.mp3');

const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'karaoke-core.js', 'karaoke.js',
  'tracks/index.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'fonts/golos-text-cyrillic.woff2', 'fonts/golos-text-latin.woff2',
  'fonts/lora-cyrillic.woff2', 'fonts/lora-latin.woff2',
  ...SAMPLES,
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function serveTrack(request) {
  const range = request.headers.get('range');
  const cache = await caches.open(VERSION);

  if (!range) {
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  }

  let full = await cache.match(request, { ignoreVary: true });
  if (!full || full.status !== 200) {
    full = await fetch(request.url);
    if (full.ok && full.status === 200) await cache.put(request, full.clone());
  }
  if (!full || full.status !== 200) return fetch(request);

  const buf = await full.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : buf.byteLength - 1;
  if (start >= buf.byteLength) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
  }
  end = Math.min(end, buf.byteLength - 1);
  const headers = new Headers(full.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${buf.byteLength}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buf.slice(start, end + 1), {
    status: 206, statusText: 'Partial Content', headers,
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.endsWith('/tracks/index.json')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then(res => {
          if (!res || !res.ok) throw new Error('offline');
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreVary: true }))
    );
    return;
  }

  if (url.pathname.includes('/tracks/')) {
    e.respondWith(serveTrack(e.request).catch(() => caches.match(e.request)));
    return;
  }

  if (url.pathname.includes('/sounds/')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }

  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cached =
        (await caches.match(e.request, { ignoreSearch: true, ignoreVary: true })) ||
        (await caches.match('index.html', { ignoreVary: true })) ||
        (await caches.match('./', { ignoreVary: true }));
      const network = fetch(e.request, { cache: 'no-cache' }).then(res => {
        if (!res || !res.ok) throw new Error('offline');
        return res;
      });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200));
      try {
        const res = await Promise.race([network, timeout]);
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      } catch (err) {
        return cached || new Response('Нет сети и нет кэша.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' }) // always revalidate so app updates arrive at once
      .then(res => {
        if (!res || !res.ok) throw new Error('offline');
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true, ignoreVary: true }))
  );
});
