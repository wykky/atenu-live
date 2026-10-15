/*
 * Atenu Live service worker.
 *
 * Goals, in order:
 *   1. Never get in the way of a live game. Socket.io, /api and /auth always
 *      go straight to the network; HTML is network-first so a deploy is
 *      picked up on the next load.
 *   2. Save students' mobile data. Hashed Next.js assets (/_next/static) and
 *      game sounds (/music, ~9 MB total) are cache-first, so the second game
 *      costs almost nothing.
 *   3. Fail politely offline: a branded /offline page instead of the browser
 *      dinosaur.
 *
 * Bump VERSION only when this file's caching logic changes. Normal deploys do
 * not need a bump: /_next/static URLs are content-hashed and HTML is fetched
 * fresh.
 */

const VERSION = 'v3';
const SHELL_CACHE = `al-shell-${VERSION}`;
const STATIC_CACHE = `al-static-${VERSION}`;
const MEDIA_CACHE = `al-media-${VERSION}`;
const PAGE_CACHE = `al-pages-${VERSION}`;
const KNOWN_CACHES = [SHELL_CACHE, STATIC_CACHE, MEDIA_CACHE, PAGE_CACHE];

const OFFLINE_URL = '/offline';
const SHELL_URLS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/pwa/atn-quiz-192.png',
  '/pwa/atn-quiz-512.png',
  '/pwa/atn-quiz-maskable-512.png',
];
// Pages worth showing from cache when the network fails mid-navigation.
// Game pages are excluded: a cached game screen without a socket is useless.
const CACHEABLE_PAGES = ['/', '/join', '/library', '/how-it-works', '/privacy', '/terms'];
const STATIC_CACHE_MAX = 200;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache: 'reload' skips the browser's HTTP cache, which may hold an
      // older file at the same URL (the first icons were sent as immutable).
      await cache.addAll(SHELL_URLS.map((u) => new Request(u, { cache: 'reload' })));
      // Also precache the CSS the offline page links to, so it renders styled.
      try {
        const res = await cache.match(OFFLINE_URL);
        const html = res ? await res.text() : '';
        const css = [...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
        if (css.length) await (await caches.open(STATIC_CACHE)).addAll(css);
      } catch {
        // Unstyled offline page is still better than none.
      }
      // First install activates immediately; updates wait for the page's OK
      // (see the SKIP_WAITING message) so nobody is swapped mid-game.
      if (!self.registration.active) await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('al-') && !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n))
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (
    path.startsWith('/socket.io') ||
    path.startsWith('/api/') ||
    path.startsWith('/auth') ||
    path === '/sw.js'
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (path.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE, STATIC_CACHE_MAX));
    return;
  }
  if (path.startsWith('/music/')) {
    event.respondWith(mediaCacheFirst(request));
    return;
  }
  if (path.startsWith('/pwa/') || path.startsWith('/screenshots/') || path === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

async function handleNavigation(event) {
  const { request } = event;
  const path = new URL(request.url).pathname;
  const cacheable = CACHEABLE_PAGES.includes(path);
  try {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(request));
    if (cacheable && response.ok) {
      const copy = response.clone();
      caches.open(PAGE_CACHE).then((c) => c.put(path, copy));
    }
    return response;
  } catch {
    if (cacheable) {
      const cached = await caches.match(path, { cacheName: PAGE_CACHE });
      if (cached) return cached;
    }
    const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
    return offline || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (maxEntries) trimCache(cache, maxEntries);
  }
  return response;
}

// Old deploys leave hashed chunks behind; drop the oldest beyond the cap.
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);
}

/*
 * <audio> sends Range requests and Safari refuses to play a 200 answer to a
 * Range request. So we cache the full file once (fetched without Range) and
 * slice 206 Partial Content responses from it ourselves.
 */
async function mediaCacheFirst(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const key = new URL(request.url).pathname;
  let full = await cache.match(key);
  if (!full) {
    try {
      const fresh = await fetch(key);
      if (!fresh.ok) return fetch(request);
      await cache.put(key, fresh.clone());
      full = fresh;
    } catch {
      return fetch(request);
    }
  }
  const range = request.headers.get('range');
  if (!range) return full;

  const buf = await full.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const total = buf.byteLength;
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (m && !m[1] && m[2]) {
    start = Math.max(0, total - parseInt(m[2], 10));
    end = total - 1;
  }
  end = Math.min(end, total - 1);
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
