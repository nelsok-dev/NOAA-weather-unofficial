// Bump BUILD to invalidate the static-shell cache whenever index.html changes.
// STATIC_ASSETS lists each asset at its exact versioned URL from index.html so
// the service worker always caches what the shell actually requests.
const BUILD = 284;
const CACHE      = 'noaa-wx-v' + BUILD;  // shell + vendor (versioned)
const LIVE_CACHE = 'noaa-wx-live-v1';     // API/data responses (long-lived, capped)

// Cap on the live-data cache (#21). NOAA API responses are small (~5-50 KB)
// so this is roughly 4-8 MB of cached payloads. When we exceed it we drop the
// oldest entries — see `_trimCache`. Without this the cache grew forever as
// the user panned the map (new tile URLs, new station IDs, etc.).
const LIVE_CACHE_MAX = 150;

// N47: the Leaflet CSS/JS entries below are loaded via <link>/<script> tags
// that carry `integrity="sha384-..."` + `crossorigin="anonymous"`. Per spec
// the browser re-verifies SRI on every cache hit (Cache API hits included)
// because SRI checks happen at the request-pipeline level, not before cache
// lookup — so a corrupted/tampered cached copy will fail to load rather than
// execute. No extra check is required here.
// N66: Leaflet now ships from ./vendor/leaflet/ instead of unpkg.com so
// the map keeps working on cold start even if unpkg is degraded.
const STATIC_ASSETS = [
  './index.html',
  './privacy.html',
  `./css/styles.css?v=${BUILD}`,
  `./css/inline-styles.css?v=${BUILD}`,
  `./js/app.js?v=${BUILD}`,
  `./js/map.js?v=${BUILD}`,
  `./js/tropical.js?v=${BUILD}`,
  `./js/winter.js?v=${BUILD}`,
  `./js/alerts.js?v=${BUILD}`,
  `./js/notifications.js?v=${BUILD}`,
  `./js/marine.js?v=${BUILD}`,
  `./js/spc.js?v=${BUILD}`,
  `./js/push.js?v=${BUILD}`,
  './manifest.json',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
];

// Cache static shell on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Drop old shell caches on activate. The live cache version is independent
// so its contents survive a BUILD bump.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE && k !== LIVE_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Trim the live cache to the first N entries on insertion-order (≈ LRU; the
// Cache API exposes keys in insertion order). Called after every put.
async function _trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) {
    try { await cache.delete(keys[i]); } catch (_) {}
  }
}

// N53: cache.put can reject with QuotaExceededError when the origin's storage
// budget is full (rare on iOS, more common on low-storage Android). On the
// first quota error, drop the oldest ~25% of the live cache and retry once.
async function _safePut(cacheName, request, response) {
  const cache = await caches.open(cacheName);
  try {
    await cache.put(request, response);
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
      const keys = await cache.keys();
      const drop = Math.max(1, Math.floor(keys.length / 4));
      for (let i = 0; i < drop; i++) {
        try { await cache.delete(keys[i]); } catch (_) {}
      }
      try { await cache.put(request, response); } catch (_) {}
    }
  }
}

// Fetch strategy:
//   - NOAA API / WMS hosts → network-first, fall back to cache (LIVE_CACHE)
//   - Everything else (static shell) → cache-first, network as fallback
//
// Note (#20): tile.openstreetmap.org is intentionally NOT in the live-data
// list. The OSM Foundation's tile-usage policy forbids bulk/persistent
// caching, and the browser's HTTP cache handles per-session reuse fine.
self.addEventListener('fetch', event => {
  // Non-GET requests (e.g. the relay /register POST) can't be cached —
  // Cache.put() throws on them and caches.match() can never satisfy them.
  // Let the network handle them untouched.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // OSM tiles: never cached (see note #20 above — OSMF tile policy forbids
  // persistent caching). Bypass the SW entirely; the browser HTTP cache
  // handles per-session reuse.
  if (url.hostname.endsWith('tile.openstreetmap.org')) return;

  const isLiveData = [
    'api.weather.gov',
    'opengeo.ncep.noaa.gov',       // RIDGE2 WMS (radar)
    'gibs.earthdata.nasa.gov',     // NASA GIBS GOES satellite WMS
    'geocoding-api.open-meteo.com', // search-bar geocoding (primary)
    'photon.komoot.io',            // search-bar geocoding fallback + reverse ZIP
    'geocoding.geo.census.gov',    // ZIP reverse-geocode (UV index path)
    'api.tidesandcurrents.noaa.gov',
    'marine-api.open-meteo.com',
    'air-quality-api.open-meteo.com', // AQI fallback where AirNow has no reporting area
    'airnowgovapi.com',            // EPA AirNow — air quality screen + tile
    'data.epa.gov',
    'noaa-alert-relay.nelsok.workers.dev', // push registration relay
    'mapservices.weather.noaa.gov',        // NHC tropical, WPC winter, CPC outlooks
    'api.open-meteo.com',                  // nowcast + long-range outlook
    'data.rcc-acis.org',                   // climate dry-streak history
  ].some(host => url.hostname.includes(host));

  if (isLiveData) {
    // Network-first: always try to get fresh data; fall back to cache.
    // After a successful put we trim the live cache so it can't grow forever.
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Only a good answer is worth serving offline later. Caching every
          // response meant an NWS 500 could become the offline fallback.
          if (response.ok) {
            const clone = response.clone();
            _safePut(LIVE_CACHE, event.request, clone)
              .then(() => _trimCache(LIVE_CACHE, LIVE_CACHE_MAX))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first: serve the static shell instantly; update cache in background.
    // Only same-origin assets belong in the versioned shell cache — caching
    // arbitrary third-party hosts here would grow it without bound and serve
    // them stale forever (cache-first never revalidates).
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (url.origin === self.location.origin && response.ok) {
            const clone = response.clone();
            _safePut(CACHE, event.request, clone).catch(() => {});
          }
          return response;
        });
      })
    );
  }
});

// Tapping the system notification should land on the content it summarized,
// not just foreground the app on whatever screen it last showed. The morning
// briefing (tag 'daily-briefing', see notifications.js fireBriefingNotif) is a
// summary of *today's* weather — route it straight to the Weather tab via
// `?goto=`, which app.js reads on boot/focus to call goNav(). Every other
// push (NWS watches/warnings/advisories) keeps the default "just focus" since
// the Alerts tab is genuinely where that content lives.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const goto = event.notification.tag === 'daily-briefing' ? 's-wx' : null;
  const targetUrl = goto ? `./?goto=${goto}` : './';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      if ('focus' in c) {
        await c.focus();
        if (goto && 'postMessage' in c) c.postMessage({ type: 'noaa-goto', screen: goto });
        return;
      }
    }
    await clients.openWindow(targetUrl);
  })());
});
