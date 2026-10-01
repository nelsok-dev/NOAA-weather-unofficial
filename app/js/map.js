// Map module — NEXRAD radar (NOAA RIDGE2 GeoServer WMS), GOES satellite (IEM WMS)
// Radar data sourced directly from NOAA's opengeo.ncep.noaa.gov RIDGE2 service.
// The TIME parameter allows frame-by-frame animation using timestamps from the
// WMS GetCapabilities response (comma-separated actual scan times).

// Shared animation state for radar & satellite
let animFrames = [];
let animFrameIdx = 0;
let animHandle = null;
let animLayers = [];
let animPlaying = false;
let animSpeed = 600;
let _radarLoading = false;   // guard against concurrent loads
let _retryHandle = null;     // auto-retry timer

// Whether a frame's tiles have finished loading is tracked on the layer itself
// (`layer._noaaReady`) rather than in a Set of indices. Indices are not stable:
// a refresh reuses the layers whose scan time is unchanged and shifts them down
// by however many new scans arrived, so an index-keyed set silently described
// the wrong frames afterwards.
function _frameReady(l) { return !!(l && l._noaaReady); }

// NOAA RIDGE2 GeoServer — NEXRAD CONUS composite reflectivity (QC'd base refl.)
// RIDGE2 base WMS — swap layer name per product via the workspace/layer URL segment
const RIDGE2_BASE  = 'https://opengeo.ncep.noaa.gov/geoserver/conus';
const RADAR_PRODS  = [
  { id: 'bref', layer: 'conus_bref_qcd',  label: 'Radar',
    info: 'Radar: the lowest radar beam. Best for seeing rain and snow near the ground.',
    lgnd: 'linear-gradient(90deg,#00ecec,#01a0f6,#0000f6,#00ff00,#00c800,#009000,#ffff00,#e7c000,#ff9000,#ff0000,#d60000,#c00000,#ff00ff,#9955c8)',
    lo: 'Light', hi: 'Heavy',
    src: 'NWS/NOAA RIDGE2 MRMS Base Reflectivity · opengeo.ncep.noaa.gov' },
  { id: 'cref', layer: 'conus_cref_qcd',  label: 'Storm Layer',
    info: 'Storm Layer: the strongest return at any radar height. Shows storms higher up that the lowest beam can miss.',
    lgnd: 'linear-gradient(90deg,#00ecec,#01a0f6,#0000f6,#00ff00,#00c800,#009000,#ffff00,#e7c000,#ff9000,#ff0000,#d60000,#c00000,#ff00ff,#9955c8)',
    lo: 'Light', hi: 'Heavy',
    src: 'NWS/NOAA RIDGE2 MRMS Composite Reflectivity · opengeo.ncep.noaa.gov' },
  { id: 'etop', layer: 'conus_neet_v18',  label: 'Storm Tops',
    info: 'Storm Tops: storm height in thousands of feet. Tops above 40,000 ft often mean severe thunderstorms.',
    lgnd: 'linear-gradient(90deg,#0000cc,#0066ff,#00ccff,#00ff88,#ffff00,#ff8800,#ff0000,#cc0000)',
    lo: 'Low', hi: 'High',
    src: 'NWS/NOAA RIDGE2 MRMS Enhanced Echo Tops · opengeo.ncep.noaa.gov' },
  { id: 'ptyp', layer: 'conus_pcpn_typ',  label: 'Precip Type',
    info: 'Precip Type: classifies what is falling (rain, snow, sleet, or freezing rain).',
    lgnd: 'linear-gradient(90deg,#0088ff,#00ccff,#ffffff,#ee88ff,#cc44ff)',
    lo: 'Rain', hi: 'Snow/Ice',
    src: 'NWS/NOAA RIDGE2 MRMS Precipitation Type · opengeo.ncep.noaa.gov' },
];
let curRadarProd = 'bref';

// NASA GIBS WMS — GOES-East satellite products (EPSG:3857, 10-min cadence)
const GIBS_SAT_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const SAT_PRODS = [
  { id: 'geocolor', layer: 'GOES-East_ABI_GeoColor',
    label: 'GeoColor',  lgnd: null,
    info: 'GeoColor: true color by day, blue-shaded clouds at night. The standard satellite view.',
    src: 'GOES-East GeoColor · NASA GIBS/Earthdata' },
  { id: 'ir',       layer: 'GOES-East_ABI_Band13_Clean_Infrared',
    label: 'Infrared',  lgnd: 'linear-gradient(90deg,#fff,#ccc,#aaa,#555,#222,#000,#440088,#000088,#0000ff)',
    lo: 'Warm', hi: 'Cold',
    info: 'Infrared (Band 13): cloud-top temperature. Cold = high tops; useful at night when Visible is dark.',
    src: 'GOES-East IR Band 13 · NASA GIBS/Earthdata' },
  { id: 'visible',  layer: 'GOES-East_ABI_Band2_Red_Visible_1km',
    label: 'Visible',   lgnd: 'linear-gradient(90deg,#000,#666,#bbb,#fff)',
    lo: 'Dark', hi: 'Bright',
    info: 'Visible (Band 2, red): clouds as they look in daylight. Highest detail, daytime only.',
    src: 'GOES-East Visible Band 2 · NASA GIBS/Earthdata' },
  { id: 'airmass',  layer: 'GOES-East_ABI_Air_Mass',
    label: 'Air Mass',  lgnd: null,
    info: 'Air Mass RGB: distinguishes warm/dry, cool/moist, and arctic air masses. Spot jet streams and fronts.',
    src: 'GOES-East Air Mass RGB · NASA GIBS/Earthdata' },
  { id: 'dust',     layer: 'GOES-East_ABI_Dust',
    label: 'Dust',      lgnd: null,
    info: 'Dust RGB: highlights airborne dust and volcanic ash in pink/magenta tones.',
    src: 'GOES-East Dust RGB · NASA GIBS/Earthdata' },
  { id: 'fire',     layer: 'GOES-East_ABI_FireTemp',
    label: 'Fire', lgnd: 'linear-gradient(90deg,#000,#800000,#c00,#f00,#f80,#ff0)',
    lo: 'Cooler', hi: 'Hotter',
    info: 'Fire Temperature RGB: detects hot spots from active wildfires using shortwave IR bands.',
    src: 'GOES-East Fire Temp · NASA GIBS/Earthdata' },
];
let curSatProd = 'geocolor';

// #9: how many hours of imagery the animation loop spans (1, 2, or 3). Frame
// count is derived from this and the product's native cadence at load time.
let loopHours = 1;
// ── Persistent map preferences ────────────────────────────────────────────────
// Persisted across reloads so users don't have to re-pick base layer, product,
// opacity, and alert overlay every time they reopen the app.
const MAP_PREFS_KEY = 'noaa_map_prefs_v1';
let _mapFullscreen = false;
// Last saved map viewport — re-applied on map open if it belongs to the
// current active location. Cleared when the user switches locations.
let _savedMapView = null; // { lat, lon, zoom, locId }
function loadMapPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(MAP_PREFS_KEY) || 'null');
    if (!p || typeof p !== 'object') return;
    if (['radar', 'satellite', 'lightning'].includes(p.curBase)) curBase = p.curBase;
    if (RADAR_PRODS.some(x => x.id === p.curRadarProd)) curRadarProd = p.curRadarProd;
    if (SAT_PRODS.some(x => x.id === p.curSatProd)) curSatProd = p.curSatProd;
    if (typeof p.curOp === 'number' && p.curOp >= 0.1 && p.curOp <= 1) curOp = p.curOp;
    if ([1, 2, 3].includes(p.loopHours)) loopHours = p.loopHours;
    if (typeof p.alertOp === 'number' && p.alertOp >= 0.1 && p.alertOp <= 1) alertOp = p.alertOp;
    if (typeof p.mapAlertsOn === 'boolean') mapAlertsOn = p.mapAlertsOn;
    if (typeof p.mapTropicalOn === 'boolean') mapTropicalOn = p.mapTropicalOn;
    if (typeof p.mapWinterOn === 'boolean') mapWinterOn = p.mapWinterOn;
    if (p.mapAlertTiers && typeof p.mapAlertTiers === 'object') {
      ['warning','watch','advisory'].forEach(t => {
        if (typeof p.mapAlertTiers[t] === 'boolean') mapAlertTiers[t] = p.mapAlertTiers[t];
      });
    }
    if (typeof p.fullscreen === 'boolean') _mapFullscreen = p.fullscreen;
    if (p.view && typeof p.view.lat === 'number' && typeof p.view.lon === 'number'
        && typeof p.view.zoom === 'number' && typeof p.view.locId === 'string') {
      _savedMapView = p.view;
    }
  } catch (_) {}
}
function saveMapPrefs() {
  try {
    // Merge with any existing record so we don't drop fields written elsewhere
    // (e.g. fullscreen, view).
    let existing = {};
    try { existing = JSON.parse(localStorage.getItem(MAP_PREFS_KEY) || '{}') || {}; } catch (_) {}
    localStorage.setItem(MAP_PREFS_KEY, JSON.stringify({
      ...existing,
      curBase, curRadarProd, curSatProd, curOp, alertOp, mapAlertsOn, mapTropicalOn, mapWinterOn, mapAlertTiers,
      loopHours,
    }));
  } catch (_) {}
}
// Persist the current map viewport (lat/lon/zoom) tied to the active location.
function saveMapView() {
  if (!lmap || !activeLocation) return;
  const c = lmap.getCenter();
  _savedMapView = { lat: c.lat, lon: c.lng, zoom: lmap.getZoom(), locId: activeLocation.id };
  try {
    let existing = {};
    try { existing = JSON.parse(localStorage.getItem(MAP_PREFS_KEY) || '{}') || {}; } catch (_) {}
    existing.view = _savedMapView;
    localStorage.setItem(MAP_PREFS_KEY, JSON.stringify(existing));
  } catch (_) {}
}
loadMapPrefs();

// ── WMS time-dimension helpers ────────────────────────────────────────────────

function parseWmsTimeDimension(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  for (const el of doc.querySelectorAll('Dimension, dimension')) {
    if ((el.getAttribute('name') || '').toLowerCase() === 'time') {
      return expandTimeDimension(el.textContent.trim());
    }
  }
  return [];
}

function expandTimeDimension(content) {
  if (!content) return [];
  if (content.includes(',')) return content.split(',').map(s => s.trim()).filter(Boolean);
  const parts = content.split('/');
  if (parts.length !== 3) return content ? [content.trim()] : [];
  const intervalMs = parseIsoPeriod(parts[2].trim());
  const startMs = new Date(parts[0].trim()).getTime();
  const endMs   = new Date(parts[1].trim()).getTime();
  // Guard the for-loop. parseIsoPeriod() returns 0 for "P", "PT0M", "P0D", … —
  // a malformed/zero period the external WMS server could emit — and a step of
  // 0 makes `t += intervalMs` spin forever and freeze the tab. A bad start/end
  // is equally unexpandable. Bail to [] in all these cases; loadRadarFrames()
  // then falls back to generateRecentTimes().
  if (!Number.isFinite(intervalMs) || intervalMs <= 0
      || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  // We only animate the last ~10 frames, so walk back from the most recent and
  // cap the count — protects against a tiny interval over a huge advertised
  // range producing tens of thousands of entries.
  const MAX_FRAMES = 240;
  const times = [];
  for (let t = endMs; t >= startMs && times.length < MAX_FRAMES; t -= intervalMs) {
    times.push(new Date(t).toISOString());
  }
  return times.reverse();
}

function parseIsoPeriod(p) {
  const m = p.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/);
  if (!m) return 5 * 60000;
  return ((+(m[1]||0)*1440 + +(m[2]||0)*60 + +(m[3]||0)) * 60 + +(m[4]||0)) * 1000;
}

function generateRecentTimes(count, intervalMs) {
  // Round end time down to nearest interval so times align with server frames
  const now = Math.floor(Date.now() / intervalMs) * intervalMs;
  return Array.from({ length: count }, (_, i) =>
    new Date(now - (count - 1 - i) * intervalMs).toISOString()
  );
}

// Custom marker for the active location — extracted so we can re-add on loc switch
let _locMarker = null;
function _placeLocMarker() {
  if (!lmap) return;
  if (_locMarker) { try { lmap.removeLayer(_locMarker); } catch (_) {} _locMarker = null; }
  const icon = L.divIcon({
    html: '<div class="_s-4cc309"></div>',
    iconSize: [9, 9], iconAnchor: [4, 4],
    className: ''
  });
  _locMarker = L.marker([activeLocation.lat, activeLocation.lon], { icon })
    .bindPopup(
      `<div class="loc-pop"><div class="loc-pop-name">${esc(displayName(activeLocation))}</div>
        <div class="loc-pop-sub">NWS Zone ${esc(activeLocation.zone || '—')}${activeLocation.radarStation ? ' · Radar ' + esc(activeLocation.radarStation) : ''}</div></div>`,
      { className: 'noaa-popup', maxWidth: 240 }
    )
    .addTo(lmap);
}

// Pick the lat/lon/zoom the map should open with.
// Prefer a previously saved view if it was for the *same* active location;
// otherwise center on the active location (location switch = fresh view).
function _initialMapView() {
  if (_savedMapView && _savedMapView.locId === activeLocation.id) {
    return { center: [_savedMapView.lat, _savedMapView.lon], zoom: _savedMapView.zoom };
  }
  return { center: [activeLocation.lat, activeLocation.lon], zoom: 7 };
}

function initMap() {
  if (lmap) {
    // Re-center on new location and replace marker. If the user has a saved
    // view for this same location, restore it instead of forcing the default
    // zoom — that way returning to the map keeps their pan/zoom intact.
    lmap.invalidateSize();
    const v = _initialMapView();
    lmap.setView(v.center, v.zoom);
    _placeLocMarker();
    if (mapAlertsOn) drawMapAlerts();
    if (mapTropicalOn) drawTropical();
    if (mapWinterOn) drawWinterMap();
    setDeckCondensed(true); // every visit to the map starts with the tools condensed
    _refreshFramesIfStale(false);
    return;
  }
  const v0 = _initialMapView();
  lmap = L.map('lmap', { center: v0.center, zoom: v0.zoom, zoomControl: false, attributionControl: true, maxZoom: 18 });
  // Remove the Leaflet branding prefix (courtesy, not required) but keep the
  // control itself — it carries the OpenStreetMap credit the ODbL requires, and
  // that credit has to be visible on the map rather than buried behind the
  // deck's "More" disclosure where #map-src lives.
  //
  // Bottom-right is where map credits belong, and it keeps the top of the map
  // clear. The control deck is absolutely positioned over the lower part of
  // #lmap, so the CSS lifts the credit by --deck-h — see _syncDeckHeight().
  lmap.attributionControl.setPrefix('').setPosition('bottomright');
  L.control.zoom({ position: 'topright' }).addTo(lmap);

  // After zoom settles, re-show the current frame so opacity is correct
  let _zoomDebounce = null;
  lmap.on('zoomend', () => {
    clearTimeout(_zoomDebounce);
    _zoomDebounce = setTimeout(() => {
      if (animLayers.length) showFrame(animFrameIdx);
    }, 150);
  });

  // Persist viewport after the user pans/zooms — debounced so we don't write
  // to localStorage every frame of a pinch.
  let _viewSaveTimer = null;
  lmap.on('moveend', () => {
    clearTimeout(_viewSaveTimer);
    _viewSaveTimer = setTimeout(saveMapView, 400);
  });

  // Refresh the alert legend to show only types visible in the new viewport.
  // Debounced — moveend fires repeatedly during momentum scrolling on iOS.
  let _legendTimer = null;
  lmap.on('moveend zoomend', () => {
    clearTimeout(_legendTimer);
    _legendTimer = setTimeout(_refreshAlertLegend, 250);
  });

  // Outline weight tracks zoom. Not debounced: the restyle is a no-op unless
  // the zoom crossed into a different weight band, and waiting would leave the
  // borders visibly wrong for a beat after the zoom lands.
  lmap.on('zoomend', _restyleAlertsForZoom);

  // Double-tap zoom polyfill. iOS WebKit doesn't fire `dblclick` from a
  // double-tap when the page disables user-zoom (viewport meta in
  // index.html has user-scalable=no), and Leaflet 1.9 dropped its tap
  // shim — so doubleClickZoom never triggers on touch. Detect two close
  // taps ourselves and zoom in around the tap point. Touch-only, so
  // desktop mouse double-click still goes through Leaflet natively.
  _bindMapDoubleTapZoom();

  _placeLocMarker();
  // Reflect persisted prefs into the UI before applyBase() so the active
  // product is highlighted and the opacity slider matches.
  _syncMapPrefsUI();
  applyBase();
  if (mapAlertsOn) drawMapAlerts();
  if (mapTropicalOn) drawTropical();
  if (mapWinterOn) drawWinterMap();
  updateProductHint();
  _bindAlertLegendClick();
  _bindMapSheetSwipe();
  _bindDeckResize();
  setDeckCondensed(true);
  // The deck's height changes with orientation and with the on-screen keyboard,
  // and the OSM credit is positioned off it.
  window.addEventListener('resize', _syncDeckHeightSoon);
}

// Drag the controls deck open and closed, the way an iOS bottom sheet works.
//
// It used to be swipe-DOWN-to-close only: there was no way to pull the deck
// open at all, and the close gesture was judged once, at touchend — nothing
// moved under the finger, it needed 50px, and the slightest upward wobble on
// the way down cancelled it outright. Both directions now work, and the deck
// follows the finger while it is down:
//
//   * closed → drag up: the deck lifts with resistance (there is no content
//     to reveal until it opens), and a short pull or a quick flick opens it.
//   * open → drag down: the deck tracks the finger 1:1, and past a third of
//     the way — or on a downward flick — it folds back to condensed.
//
// The direction is decided once, after 8px of movement. Horizontal wins go to
// whatever is under the finger (the product chips scroll sideways), and so do
// the cases where the sheet's own list should scroll instead: dragging down
// in a tier-2 list that is scrolled, or dragging up while it is open. Sliders
// never start a drag — the scrubber and opacity controls need the whole touch.
let _sheetDrag = null;
let _sheetSwipeAt = 0;
const SHEET_OPEN_PULL = 36;     // px up to open
const SHEET_CLOSE_FRAC = 0.33;  // of the tier-2 height, down to close
const SHEET_FLICK = 0.35;       // px/ms — a flick decides regardless of distance
function _bindMapSheetSwipe() {
  const deck = document.getElementById('map-controls');
  if (!deck || deck._swipeBound) return;
  deck._swipeBound = true;

  deck.addEventListener('touchstart', e => {
    _sheetDrag = null;
    if (e.touches.length !== 1) return;
    if (e.target.closest('input[type="range"]')) return;
    const t = e.touches[0];
    const body = e.target.closest('.map-sheet-body');
    _sheetDrag = {
      x: t.clientX, y: t.clientY, dy: 0, lock: null, vy: 0,
      lastY: t.clientY, lastT: e.timeStamp || Date.now(),
      open: deck.classList.contains('sheet-open'),
      bodyScrolled: !!(body && body.scrollTop > 0),
    };
  }, { passive: true });

  // Not passive: once the gesture is ours, preventDefault keeps iOS from also
  // scrolling or rubber-banding the page underneath, and from firing a click
  // on the chip the finger started on.
  deck.addEventListener('touchmove', e => {
    const d = _sheetDrag;
    const t = e.touches && e.touches[0];
    if (!d || !t) return;
    const dx = t.clientX - d.x, dy = t.clientY - d.y;
    if (!d.lock) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) { _sheetDrag = null; return; }
      if (d.open ? (dy < 0 || d.bodyScrolled) : dy > 0) { _sheetDrag = null; return; }
      d.lock = true;
      d.bodyH = document.getElementById('map-sheet-body')?.offsetHeight || 200;
      deck.classList.add('sheet-dragging');
    }
    if (e.cancelable) e.preventDefault();
    const now = e.timeStamp || Date.now();
    const dt = Math.max(1, now - d.lastT);
    d.vy = 0.7 * ((t.clientY - d.lastY) / dt) + 0.3 * d.vy;
    d.lastY = t.clientY; d.lastT = now; d.dy = dy;
    const off = d.open ? Math.max(0, dy) : Math.max(-64, Math.min(0, dy) * 0.45);
    deck.style.transform = `translateY(${off}px)`;
  }, { passive: false });

  const end = () => {
    const d = _sheetDrag;
    _sheetDrag = null;
    if (!d || !d.lock) return;
    deck.classList.remove('sheet-dragging');
    deck.style.transform = '';
    _sheetSwipeAt = Date.now(); // swallow any trailing click on "Tools"/"Close"
    if (d.open) {
      if (d.dy > d.bodyH * SHEET_CLOSE_FRAC || (d.dy > 16 && d.vy > SHEET_FLICK)) setDeckCondensed(true);
    } else if (d.dy < -SHEET_OPEN_PULL || (d.dy < -10 && d.vy < -SHEET_FLICK)) {
      _openMapSheet();
    }
  };
  deck.addEventListener('touchend', end, { passive: true });
  deck.addEventListener('touchcancel', end, { passive: true });
}

// Synthesize double-tap-to-zoom on touch. See call site in initMap() for
// the iOS WebKit / Leaflet 1.9 background.
function _bindMapDoubleTapZoom() {
  const el = document.getElementById('lmap');
  if (!el || el._dtapBound) return;
  el._dtapBound = true;
  let tapStart = null;
  let lastTap = null;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tapStart = null; return; }
    const t = e.touches[0];
    tapStart = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!tapStart || e.changedTouches.length !== 1 || e.touches.length !== 0) {
      tapStart = null;
      return;
    }
    const t = e.changedTouches[0];
    const moved = Math.abs(t.clientX - tapStart.x) + Math.abs(t.clientY - tapStart.y);
    const dt = Date.now() - tapStart.t;
    tapStart = null;
    // Drag/long-press → not a tap; reset and bail.
    if (moved > 12 || dt > 350) { lastTap = null; return; }
    const now = Date.now();
    if (lastTap && now - lastTap.t < 300
        && Math.abs(t.clientX - lastTap.x) < 30
        && Math.abs(t.clientY - lastTap.y) < 30) {
      const r = el.getBoundingClientRect();
      const pt = L.point(t.clientX - r.left, t.clientY - r.top);
      const z = lmap.getZoom();
      if (z < lmap.getMaxZoom()) lmap.setZoomAround(pt, z + 1);
      lastTap = null;
      if (e.cancelable) e.preventDefault();
      return;
    }
    lastTap = { x: t.clientX, y: t.clientY, t: now };
  }, { passive: false });
}

// Push persisted preferences into the controls UI so the visible state matches.
function _syncMapPrefsUI() {
  // Fullscreen state
  const sMap = document.getElementById('s-map');
  if (sMap) sMap.classList.toggle('map-fullscreen', _mapFullscreen);
  const fsBtn = document.getElementById('map-fs-btn');
  if (fsBtn) fsBtn.textContent = _mapFullscreen ? '⤣' : '⤢';
  // Base layer
  document.querySelectorAll('.lbtn').forEach(b => b.classList.remove('on', 'on-sat'));
  document.getElementById('lb-radar')?.classList.toggle('on', curBase === 'radar');
  document.getElementById('lb-sat')?.classList.toggle('on-sat', curBase === 'satellite');
  document.getElementById('lb-lt')?.classList.toggle('on-lt', curBase === 'lightning');
  // Radar product — use data-prod attribute (data-click-action dispatch system)
  document.querySelectorAll('.prbtn:not(.sat-prbtn)').forEach(b => {
    b.classList.toggle('on', b.dataset.prod === curRadarProd);
  });
  // Satellite product
  document.querySelectorAll('.sat-prbtn').forEach(b => {
    b.classList.toggle('on', b.dataset.prod === curSatProd);
  });
  // Loop-length buttons (#9)
  document.querySelectorAll('.llbtn').forEach(b => b.classList.toggle('active', +b.dataset.len === loopHours));
  // Opacity slider
  const op = document.querySelector('.op-row input[type="range"]');
  if (op) { op.value = Math.round(curOp * 100); document.getElementById('opVal').textContent = op.value + '%'; }
  // Alert opacity slider
  const aop = document.getElementById('alert-op-slider');
  if (aop) { aop.value = Math.round(alertOp * 100); const lbl = document.getElementById('alertOpVal'); if (lbl) lbl.textContent = aop.value + '%'; }
  // Alerts toggle
  const tog = document.getElementById('map-alerts-tog');
  if (tog) tog.checked = mapAlertsOn;
  const lbl = document.getElementById('map-tog-lbl');
  if (lbl) lbl.textContent = mapAlertsOn ? 'On' : 'Off';
  const al = document.getElementById('map-al-lgnd');
  if (al) al.style.display = mapAlertsOn ? 'flex' : 'none';
  // Tropical (NHC) toggle
  const ttog = document.getElementById('map-trop-tog');
  if (ttog) ttog.checked = mapTropicalOn;
  const tlbl = document.getElementById('map-trop-lbl');
  if (tlbl) tlbl.textContent = mapTropicalOn ? 'On' : 'Off';
  // Winter storm severity (WPC WSSI) toggle
  const wtog = document.getElementById('map-wtr-tog');
  if (wtog) wtog.checked = mapWinterOn;
  const wlbl = document.getElementById('map-wtr-lbl');
  if (wlbl) wlbl.textContent = mapWinterOn ? 'On' : 'Off';
  const tierRow = document.getElementById('alert-tier-row');
  if (tierRow) tierRow.style.display = mapAlertsOn ? 'flex' : 'none';
  const opRow = document.getElementById('alert-op-row');
  if (opRow) opRow.style.display = mapAlertsOn ? 'flex' : 'none';
  _syncAlertTierUI();
}

// Returns a Promise that resolves when a WMS layer fires its first 'load' event
// (all tiles in the current viewport are done), with a hard timeout fallback so
// a slow/failed tile never hangs the animation indefinitely.
function waitForLayer(layer, timeoutMs = 12000) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, timeoutMs);
    layer.once('load', () => { clearTimeout(t); resolve(); });
  });
}

// ── Shared animation helpers ──────────────────────────────────────────────────

function clearAnim() {
  if (animHandle) { clearInterval(animHandle); animHandle = null; }
  if (_retryHandle) { clearTimeout(_retryHandle); _retryHandle = null; }
  animLayers.forEach(l => { try { if (lmap) lmap.removeLayer(l); } catch(_) {} });
  animLayers = [];
  animFrames = [];
  animFrameIdx = 0;
  animPlaying = false;
  _radarLoading = false;
  _resetScrubState();
  const btn = document.getElementById('radar-play-btn');
  if (btn) btn.innerHTML = '&#9646;&#9646;';
  _showDeckRows(false);
}

// The playback controls live on TWO rows now — speed/loop/refresh above, and
// transport + scrubber + time below — so they have to appear and disappear
// together. Hiding only #radar-anim (all of it, back when it held everything)
// used to be enough; after the split it left the transport and an empty slider
// on screen with the chips gone.
function _showDeckRows(on) {
  const rows = [document.getElementById('radar-anim'),
                document.querySelector('.ranim-scrub-row')];
  for (const el of rows) if (el) el.style.display = on ? 'flex' : 'none';
}

// Only a sliding window of frame layers is kept attached to the map at once.
// Holding all 30–60 fully-tiled WMS layers simultaneously exhausts the WKWebView
// content-process memory and crashes the map (the process is jettisoned and the
// app reloads to the default tab). The window covers the active frame, a few
// look-ahead frames (the loop plays forward, so upcoming frames are preloaded and
// ready by the time they're shown), and one behind for reverse stepping.
const FRAME_WINDOW_AHEAD  = 4;
const FRAME_WINDOW_BEHIND = 1;

function _syncFrameWindow(activeIdx) {
  const n = animLayers.length;
  if (!n || !lmap) return;
  const keep = new Set();
  for (let d = -FRAME_WINDOW_BEHIND; d <= FRAME_WINDOW_AHEAD; d++) {
    keep.add(((activeIdx + d) % n + n) % n); // wrap so the loop's start is preloaded near the end
  }
  animLayers.forEach((layer, i) => {
    const attached = lmap.hasLayer(layer);
    if (keep.has(i)) {
      if (!attached) { layer.setOpacity(0); layer.addTo(lmap); } // attach hidden; showFrame reveals the active one
    } else if (attached) {
      lmap.removeLayer(layer);
      layer._noaaReady = false; // tiles are discarded on detach → no longer loaded
    }
  });
}

// A frame's picture is fully determined by its source (WMS endpoint + layer)
// and its scan time, so two loads that ask for the same pair can share one
// Leaflet layer — and with it every tile already fetched into it.
function _frameKey(srcKey, isoTime) { return srcKey + '|' + isoTime; }

// Rebuild animLayers for `times`, carrying over every existing layer that
// already holds the same source+time instead of recreating it.
//
// A refresh only ever slides the window by the one or two scans published since
// the last load, so this reuses ~29 of 31 radar frames: the picture on screen
// never blanks, the tiles for reused frames are not re-downloaded, and the
// frames that aged out of the span are the only ones destroyed. Before this,
// every refresh — the button, pull-to-refresh, the auto-retry — tore down all
// 31 layers and refetched all of them from scratch.
//
// `makeLayer(isoTime, i)` builds a layer for a time that has no existing match.
function _syncFrameLayers(srcKey, times, makeLayer) {
  const prev = new Map();
  animLayers.forEach(l => prev.set(_frameKey(l._noaaSrc, l._noaaTime), l));

  const next = [];
  let reused = 0;
  times.forEach((isoTime, i) => {
    const key = _frameKey(srcKey, isoTime);
    let layer = prev.get(key);
    if (layer) {
      prev.delete(key);
      // zIndex encodes loop position, and positions shift as frames age out.
      layer.setZIndex(200 + i);
      reused++;
    } else {
      layer = makeLayer(isoTime, i);
      layer._noaaSrc = srcKey;
      layer._noaaTime = isoTime;
      layer._noaaReady = false;
      // Readiness rides on the layer, not on an index — see _frameReady().
      layer.on('load', () => { layer._noaaReady = true; });
    }
    next.push(layer);
  });

  // Anything left in `prev` has aged out of the span (or the product changed):
  // detach it so its tiles are released.
  prev.forEach(layer => { try { if (lmap) lmap.removeLayer(layer); } catch (_) {} });

  animLayers = next;
  return reused;
}

// Shared tail of both loaders: show the newest frame the moment ITS tiles are
// in, then let the rest of the window fill in behind it.
//
// Radar used to await Promise.all() over the whole six-layer window before
// revealing anything, so the map sat on "Loading…" for as long as the slowest
// frame in the window took. The newest frame is the one the user is waiting to
// see; the look-ahead frames only need to be ready by the time the loop reaches
// them, which is several hundred milliseconds later.
async function _showNewestThenFill(newestIdx, isStale) {
  const newest = animLayers[newestIdx];
  if (!newest) return;
  if (!lmap.hasLayer(newest)) { newest.setOpacity(0); newest.addTo(lmap); }
  if (!_frameReady(newest)) await waitForLayer(newest);
  if (isStale()) return;

  // showFrame() syncs the attached window itself, so the look-ahead frames
  // start fetching in the same tick that the newest one is revealed.
  animFrameIdx = newestIdx;
  showFrame(newestIdx);
}

function showFrame(idx) {
  if (!animLayers.length) return;
  idx = Math.max(0, Math.min(idx, animLayers.length - 1));

  // Keep the attached-layer window centred on this frame so we never hold every
  // frame tiled at once. The active frame is guaranteed attached afterwards.
  _syncFrameWindow(idx);

  // If this frame's tiles aren't in yet, keep showing the most recent frame that
  // is — for either base, not just satellite. Radar used to reveal the requested
  // layer unconditionally, so a frame still fetching flashed the bare basemap.
  // The counter still advances, so the loop moves on rather than stalling.
  let displayIdx = idx;
  if (!_frameReady(animLayers[idx])) {
    let found = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (_frameReady(animLayers[i]) && lmap.hasLayer(animLayers[i])) { found = i; break; }
    }
    if (found < 0) {
      animFrameIdx = idx;  // nothing loaded yet — leave whatever is on screen alone
      updateFrameUI();
      return;
    }
    displayIdx = found;
  }

  // Only attached layers live on the map; reveal the display frame, hide the rest.
  animLayers.forEach((l, i) => { if (lmap.hasLayer(l)) l.setOpacity(i === displayIdx ? curOp : 0); });
  animFrameIdx = idx; // advance counter to true position, not fallback
  const frame = animFrames[displayIdx];
  const el = document.getElementById('radar-time');
  if (el && frame && frame.time) {
    const d = new Date(frame.time * 1000);
    el.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  updateFrameUI();
}

// Advance the loop by one frame. Used by the playback interval, which must NOT
// stop itself — see stepFrame() for the button-facing version.
function _advanceFrame(dir) {
  if (!animFrames.length) return;
  showFrame((animFrameIdx + dir + animFrames.length) % animFrames.length);
}

// The ◀ / ▶| step buttons. Stepping is a manual take-over from playback, the
// same as dragging the scrubber is: without stopping the loop the frame you
// stepped to was overwritten by the next tick a few hundred ms later, so the
// buttons looked like they did nothing while playing.
function stepFrame(dir) {
  if (!animFrames.length) return;
  stopAnimLoop();
  _advanceFrame(dir);
}

function startAnimLoop() {
  if (animHandle) clearInterval(animHandle);
  // Playback and a finger on the scrubber are mutually exclusive owners of the
  // slider. Starting the loop is an unambiguous end to any scrub, so surrender
  // ownership here too — otherwise a drag that never produced a `change` event
  // left updateFrameUI() refusing to move the thumb while the track fill
  // advanced underneath it.
  _endScrub();
  animPlaying = true;
  const btn = document.getElementById('radar-play-btn');
  if (btn) btn.innerHTML = '&#9646;&#9646;';
  animHandle = setInterval(() => _advanceFrame(1), animSpeed);
}

function setAnimSpeed(ms, btn) {
  animSpeed = ms;
  if (btn) {
    document.querySelectorAll('.rspd').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  if (animPlaying) startAnimLoop();
}

function stopAnimLoop() {
  if (animHandle) { clearInterval(animHandle); animHandle = null; }
  animPlaying = false;
  const btn = document.getElementById('radar-play-btn');
  if (btn) btn.innerHTML = '&#9654;';
}

function toggleRadarPlay() {
  if (animPlaying) stopAnimLoop();
  else startAnimLoop();
}

// Keeps the scrub slider in step with the frame the map is showing — whether
// the loop advanced it, a step button did, or a new set of frames just loaded.
// Replaced a row of tap-only dots, which on a 1-hour loop meant 30 targets ~7px
// wide with no way to drag between them.
function updateFrameUI() {
  const sl = document.getElementById('radar-slider');
  if (!sl) return;
  const last = Math.max(0, animFrames.length - 1);
  if (+sl.max !== last) sl.max = String(last);
  // Don't fight the user's finger: while dragging, the slider is the source of
  // truth and writing to it here would snap the thumb back.
  if (!_scrubActive() && +sl.value !== animFrameIdx) sl.value = String(animFrameIdx);
  sl.setAttribute('aria-valuetext', document.getElementById('radar-time')?.textContent || '');
  // Paint the played portion of the track (WebKit gives no ::-webkit-progress
  // equivalent for range inputs).
  sl.style.setProperty('--scrub', last ? (100 * animFrameIdx / last) + '%' : '0%');
}

// Dragging fires `input` on every pixel of travel, and each frame change
// attaches/detaches Leaflet layers through _syncFrameWindow(). Left unchecked
// that's exactly the churn that jettisons the WKWebView content process (see
// the frame-window note above), so scrubs are coalesced to one per animation
// frame — the slider thumb still tracks the finger, the map catches up.
//
// Ownership of the slider is held as an EXPIRING timestamp rather than a
// boolean. The boolean was only ever cleared by the `change` event, and a range
// input does not fire `change` when the drag ends on the value it started from
// — so dragging out and back, or a touch cancelled by the OS, left the flag
// stuck on. From then on updateFrameUI() would not move the thumb, while it
// kept repainting the track fill from animFrameIdx: the reported "progress dot
// doesn't line up with the progress bar" after scrubbing and hitting play.
// A stamp cannot get stuck — it lapses on its own once the `input` events stop.
const SCRUB_OWN_MS = 400;
let _scrubOwnUntil = 0;
let _scrubPending = null;
let _scrubRAF = 0;
let _scrubTimer = 0;

function _scrubActive() { return Date.now() < _scrubOwnUntil; }

// Apply the latest scrub position. Called from rAF normally, and from a plain
// timer as a backstop: rAF does not run while the page is hidden (app
// backgrounded, WebView off-screen), which used to strand _scrubRAF set and
// _scrubPending unapplied — and because scrubFrame() early-returns whenever
// _scrubRAF is non-zero, every later drag was then swallowed and the scrubber
// went dead until the map was rebuilt.
function _flushScrub() {
  if (_scrubRAF) { cancelAnimationFrame(_scrubRAF); _scrubRAF = 0; }
  if (_scrubTimer) { clearTimeout(_scrubTimer); _scrubTimer = 0; }
  const idx = _scrubPending;
  _scrubPending = null;
  if (idx != null && animFrames.length) showFrame(idx);
}

function _endScrub() {
  _scrubOwnUntil = 0;
  _flushScrub();
}

function _resetScrubState() {
  _scrubOwnUntil = 0;
  _scrubPending = null;
  if (_scrubRAF) { cancelAnimationFrame(_scrubRAF); _scrubRAF = 0; }
  if (_scrubTimer) { clearTimeout(_scrubTimer); _scrubTimer = 0; }
}

function scrubFrame(el) {
  if (!animFrames.length) return;
  stopAnimLoop();                       // a manual scrub takes over from playback
  _scrubOwnUntil = Date.now() + SCRUB_OWN_MS;
  _scrubPending = Math.max(0, Math.min(+el.value || 0, animFrames.length - 1));
  if (_scrubRAF || _scrubTimer) return;
  _scrubRAF = requestAnimationFrame(_flushScrub);
  _scrubTimer = setTimeout(_flushScrub, 120);
}

// `change` lands at the end of the drag (and on a keyboard arrow); touchend /
// touchcancel cover the drags that end without changing the value, which fire
// no `change` at all.
function scrubFrameEnd(el) {
  _endScrub();
  if (animFrames.length) showFrame(Math.max(0, Math.min(+el.value || 0, animFrames.length - 1)));
}

function showAnimCtrl(timeLabel) {
  _showDeckRows(true);
  const timeEl = document.getElementById('radar-time');
  if (timeEl && timeLabel) timeEl.textContent = timeLabel;
}

// "Loading…" at the start of a load, but only when there is nothing to look at
// yet. A refresh now keeps the frames it already has on screen, so blanking the
// timestamp there would be the one visible sign of a teardown that no longer
// happens.
function showLoadingIfEmpty() {
  if (animLayers.length) showAnimCtrl(null);
  else showAnimCtrl('Loading…');
}

// ── Radar (NOAA NOWCOAST WMS) ─────────────────────────────────────────────────

// Per-load generation counter. Each load call increments this; any in-flight
// load whose token no longer matches the latest is "stale" — it bails out
// before mutating shared state. This is what makes rapid product-switching
// race-safe instead of silently no-op'ing when _radarLoading is set.
let _loadGen = 0;
// When the current loop last finished loading. The loop does not refresh itself:
// frames are fetched once per load, and iOS keeps this WebView alive for days,
// so leaving the map (or the app) and coming back resumed a loop that could be
// hours old under a strip reading "LIVE". _refreshFramesIfStale() reloads it —
// cheaply, since _syncFrameLayers() keeps every frame whose scan time is unchanged.
let _framesLoadedAt = 0;
const MAP_FRAMES_MAX_AGE_MS = 5 * 60 * 1000;
// Watchdog: if a load doesn't complete within this window, force-clear the
// loading flag so the user can retry instead of getting stuck.
const LOAD_WATCHDOG_MS = 30_000;

async function loadRadarFrames() {
  // Cancel any in-flight load by bumping the generation counter; the prior
  // call will see its token is stale and exit before touching animLayers.
  const myGen = ++_loadGen;
  _radarLoading = true;
  if (_retryHandle) { clearTimeout(_retryHandle); _retryHandle = null; }
  showLoadingIfEmpty();

  // Watchdog — clears _radarLoading if we hang
  const watchdog = setTimeout(() => {
    if (_loadGen === myGen) {
      _radarLoading = false;
      showAnimCtrl('⚠ Timed out');
      _warn('radarWatchdog', LOAD_WATCHDOG_MS + 'ms elapsed');
    }
  }, LOAD_WATCHDOG_MS);

  try {
    const prod = RADAR_PRODS.find(p => p.id === curRadarProd) || RADAR_PRODS[0];
    const wmsUrl = `${RIDGE2_BASE}/${prod.layer}/ows`;

    // Fetch available scan times from RIDGE2 GetCapabilities (comma-separated ISO list)
    let times = [];
    try {
      const capResp = await fetch(
        `${wmsUrl}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`,
        { signal: AbortSignal.timeout(10000) }
      );
      times = parseWmsTimeDimension(await capResp.text());
    } catch(_) { /* fallthrough to generated times */ }

    // Stale check before any DOM/state mutation
    if (_loadGen !== myGen) { clearTimeout(watchdog); return; }

    // Fall back: generate enough frames to cover the chosen span at the ~5-min
    // MRMS update interval.
    if (times.length < 2) times = generateRecentTimes(loopHours * 12, 5 * 60000);

    // #9: size the loop from the chosen span (1/2/3 h) and the imagery's native
    // cadence (derived from the spacing of the returned scan times). Cap the
    // layer count so a fine cadence over a long span can't spawn hundreds of
    // simultaneous WMS tile layers.
    let intervalMs = 5 * 60000;
    if (times.length >= 2) {
      const d = new Date(times[times.length - 1]).getTime() - new Date(times[times.length - 2]).getTime();
      if (Number.isFinite(d) && d > 0) intervalMs = d;
    }
    const wantFrames = Math.min(60, Math.max(6, Math.round((loopHours * 3600000) / intervalMs)));
    times = times.slice(-wantFrames);

    animFrames = times.map(t => ({ time: Math.floor(new Date(t).getTime() / 1000) }));

    // Layers are created but NOT attached — _syncFrameWindow() attaches only the
    // sliding window of frames around the active one (see showFrame).
    _syncFrameLayers(`${wmsUrl}|${prod.layer}`, times, (isoTime, i) =>
      L.tileLayer.wms(wmsUrl, {
        layers: prod.layer,
        styles: '',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        opacity: 0,
        zIndex: 200 + i,
        attribution: '',
        // Mobile WKWebView crash guard. Every frame is a stacked tile layer kept
        // attached at opacity 0, so the defaults would reload tiles for ALL of
        // them at each intermediate zoom level during a pinch — hundreds of
        // simultaneous tiles that blow past the WebKit content-process memory
        // limit, jettisoning the process (the app reloads to the default tab).
        // Defer tile loads until the zoom settles, and don't keep off-screen
        // buffer rings multiplied across N layers.
        updateWhenZooming: false,
        keepBuffer: 0
      }));

    if (!animLayers.length) { showAnimCtrl('⚠ No frames loaded'); clearTimeout(watchdog); _radarLoading = false; return; }

    // Update legend for selected product
    _updateRadarLegend(prod);

    // Newest frame first; the rest of the window fills in behind it.
    await _showNewestThenFill(times.length - 1, () => _loadGen !== myGen);

    if (_loadGen !== myGen) { clearTimeout(watchdog); return; }

    startAnimLoop();
    _radarLoading = false;
    _framesLoadedAt = Date.now();
    clearTimeout(watchdog);
  } catch(e) {
    clearTimeout(watchdog);
    if (_loadGen !== myGen) return; // a newer load is already in flight
    _radarLoading = false;
    showAnimCtrl('⚠ Retrying…');
    _warn('loadRadarFrames (retrying in 5s)', e);
    _retryHandle = setTimeout(loadRadarFrames, TIMINGS.WMS_RETRY_MS);
  }
}

function _updateRadarLegend(prod) {
  document.getElementById('lgnd-bar').style.background = prod.lgnd;
  document.getElementById('lgnd-lo').textContent = prod.lo;
  document.getElementById('lgnd-hi').textContent = prod.hi;
  document.getElementById('lgnd-row').style.display = 'flex';
  const src = document.getElementById('map-src');
  if (src) src.textContent = prod.src + ' \xb7 Tropical: NOAA/NHC \xb7 \xa9 OpenStreetMap contributors';
}

// Plain-English description of what the currently-active product shows.
// Rendered below the product row so users learn what they're looking at.
function updateProductHint() {
  const hint = document.getElementById('map-prod-hint');
  if (!hint) return;
  const list = curBase === 'satellite' ? SAT_PRODS : RADAR_PRODS;
  const cur  = curBase === 'satellite' ? curSatProd : curRadarProd;
  const prod = curBase === 'lightning' ? LIGHTNING_PROD : list.find(p => p.id === cur);
  hint.textContent = prod?.info || '';
  hint.style.display = prod?.info ? 'block' : 'none';
}

function setProd(id, btn) {
  curRadarProd = id;
  saveMapPrefs();
  document.querySelectorAll('.prbtn:not(.sat-prbtn)').forEach(b => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  if (curBase === 'radar') { clearAnim(); loadRadarFrames(); }
  updateProductHint();
}

// ── Satellite (NASA GIBS WMS — GOES-East animated) ───────────────────────────

// Parse the GIBS GetCapabilities response and find the `default` attribute on
// the time dimension of a specific layer. Uses DOMParser instead of string
// indexOf+regex so it's resilient to whitespace/attribute-order changes.
function parseGibsLatestTime(xmlText, layerName) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    for (const layerEl of doc.querySelectorAll('Layer')) {
      const nameEl = layerEl.querySelector(':scope > Name');
      if (!nameEl || nameEl.textContent.trim() !== layerName) continue;
      for (const dim of layerEl.querySelectorAll(':scope > Dimension, :scope > dimension')) {
        if ((dim.getAttribute('name') || '').toLowerCase() !== 'time') continue;
        const def = dim.getAttribute('default');
        if (def && /^\d{4}-\d{2}-\d{2}T/.test(def)) return new Date(def).getTime();
      }
    }
  } catch (e) { _warn && _warn('parseWmsTime', e); }
  return null;
}

async function loadSatFrames() {
  const myGen = ++_loadGen;
  _radarLoading = true;
  if (_retryHandle) { clearTimeout(_retryHandle); _retryHandle = null; }
  showLoadingIfEmpty();

  const watchdog = setTimeout(() => {
    if (_loadGen === myGen) {
      _radarLoading = false;
      showAnimCtrl('⚠ Timed out');
      _warn('satelliteWatchdog', LOAD_WATCHDOG_MS + 'ms elapsed');
    }
  }, LOAD_WATCHDOG_MS);

  // Re-enable animation controls (satellite mode used to disable them)
  ['radar-play-btn', 'radar-prev', 'radar-next'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.style.opacity = ''; }
  });

  try {
    const prod = SAT_PRODS.find(p => p.id === curSatProd) || SAT_PRODS[0];

    // GIBS data lags real-time by ~90 min; the WMS 'default' attribute on the
    // layer's time dimension points to the latest available frame.
    let latestMs = Date.now() - TIMINGS.GIBS_LAG_MS; // conservative fallback
    try {
      const capResp = await fetch(
        `${GIBS_SAT_WMS}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`,
        { signal: AbortSignal.timeout(8000) }
      );
      const parsed = parseGibsLatestTime(await capResp.text(), prod.layer);
      if (parsed != null) latestMs = parsed;
    } catch(_) { /* keep fallback */ }

    if (_loadGen !== myGen) { clearTimeout(watchdog); return; }

    // #9: frames at 10-min GOES cadence covering the chosen span (1/2/3 h),
    // ending at the latest available frame.
    const INTERVAL = 10 * 60000;
    const frameCount = Math.min(36, Math.max(6, loopHours * 6));
    const times = Array.from({ length: frameCount }, (_, i) =>
      new Date(latestMs - (frameCount - 1 - i) * INTERVAL).toISOString().replace(/\.\d+Z$/, 'Z')
    );

    animFrames = times.map(t => ({ time: Math.floor(new Date(t).getTime() / 1000) }));

    // Created but NOT attached — only the sliding window is kept on the map.
    _syncFrameLayers(`${GIBS_SAT_WMS}|${prod.layer}`, times, (isoTime, i) =>
      L.tileLayer.wms(GIBS_SAT_WMS, {
        layers: prod.layer,
        styles: '',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        opacity: 0,
        zIndex: 200 + i,
        attribution: '',
        // See radar loader: defer tile loads until a pinch zoom settles and drop
        // off-screen buffer rings so N stacked frame layers can't exhaust the
        // WKWebView content-process memory mid-gesture and crash the map.
        updateWhenZooming: false,
        keepBuffer: 0
      }));

    if (!animLayers.length) { showAnimCtrl('⚠ No frames loaded'); clearTimeout(watchdog); _radarLoading = false; return; }
    _updateSatLegend(prod);

    // Newest frame first; the rest of the window fills in behind it.
    await _showNewestThenFill(times.length - 1, () => _loadGen !== myGen);

    if (_loadGen !== myGen) { clearTimeout(watchdog); return; }

    startAnimLoop();
    _radarLoading = false;
    _framesLoadedAt = Date.now();
    clearTimeout(watchdog);
  } catch(e) {
    clearTimeout(watchdog);
    if (_loadGen !== myGen) return;
    _radarLoading = false;
    showAnimCtrl('⚠ Retrying…');
    _retryHandle = setTimeout(loadSatFrames, TIMINGS.WMS_RETRY_MS);
  }
}

function setSatProd(id, btn) {
  curSatProd = id;
  saveMapPrefs();
  document.querySelectorAll('.sat-prbtn').forEach(b => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  if (curBase === 'satellite') {
    clearAnim();
    loadSatFrames();
  }
  updateProductHint();
}

function _updateSatLegend(prod) {
  const bar = document.getElementById('lgnd-bar');
  const lo  = document.getElementById('lgnd-lo');
  const hi  = document.getElementById('lgnd-hi');
  const row = document.getElementById('lgnd-row');
  const src = document.getElementById('map-src');
  if (prod.lgnd) {
    bar.style.background = prod.lgnd;
    lo.textContent = prod.lo || '';
    hi.textContent = prod.hi || '';
    row.style.display = 'flex';
  } else {
    row.style.display = 'none'; // RGB composites have no scalar legend
  }
  if (src) src.textContent = prod.src + ' \xb7 Tropical: NOAA/NHC \xb7 \xa9 OpenStreetMap contributors';
}


// ── Lightning (NOAA nowCOAST WMS — strike density, animated) ─────────────────
//
// The third base mode, beside radar and satellite: its own loop, on the plain
// street map, so the strike colours never compete with radar's rain colours.
// Source: nowCOAST lightning_detection:ldn_lightning_strike_density — derived by
// the NWS Ocean Prediction Center from the U.S. National Lightning Detection
// Network and the global GLD360 network, 8 km cells, one frame per 15 minutes,
// ~5 h kept, cleared by NOAA for public distribution.
//
// Frames go through the same sliding window as radar and satellite
// (_syncFrameLayers), so this adds no more attached image layers than either of
// them — the WKWebView crash limit is respected by construction.

const LIGHTNING_WMS = 'https://nowcoast.noaa.gov/geoserver/lightning_detection/ldn_lightning_strike_density/ows';
const LIGHTNING_LAYER = 'lightning_detection:ldn_lightning_strike_density';
const LIGHTNING_INTERVAL_MS = 15 * 60000;
const LIGHTNING_PROD = {
  lgnd: 'linear-gradient(90deg,#ffff00,#ffa500,#ff2a00,#ff00ff)', lo: 'Fewer strikes', hi: 'More',
  src: 'NOAA/NWS Ocean Prediction Center lightning density (NLDN, GLD360) \xb7 nowcoast.noaa.gov',
  info: 'Lightning: strikes in each 5-mile square over 15 minutes, from NOAA. Magenta marks the most active storms. Play the loop to see which are growing or weakening.',
};

async function loadLightningFrames() {
  const myGen = ++_loadGen;
  _radarLoading = true;
  if (_retryHandle) { clearTimeout(_retryHandle); _retryHandle = null; }
  showLoadingIfEmpty();

  const watchdog = setTimeout(() => {
    if (_loadGen === myGen) {
      _radarLoading = false;
      showAnimCtrl('⚠ Timed out');
      _warn('lightningWatchdog', LOAD_WATCHDOG_MS + 'ms elapsed');
    }
  }, LOAD_WATCHDOG_MS);

  try {
    // The layer-scoped capabilities document is ~10 KB; the full nowCOAST one
    // is ~460 KB. It lists every frame the server holds.
    let times = [];
    try {
      const capResp = await fetch(`${LIGHTNING_WMS}?service=WMS&version=1.3.0&request=GetCapabilities`,
        { signal: AbortSignal.timeout(10000) });
      times = parseWmsTimeDimension(await capResp.text());
    } catch (_) { /* fall through to generated times */ }

    if (_loadGen !== myGen) { clearTimeout(watchdog); return; }

    // Generated fallback: the server snaps any requested time to its nearest
    // frame (nearestValue=1), so round 15-minute steps still land on real data.
    if (times.length < 2) times = generateRecentTimes(loopHours * 4, LIGHTNING_INTERVAL_MS);

    // 15-minute frames: 1 h would be only 4, too few to read a trend, so every
    // span gets at least 6 (1.5 h). 3 h = 12 frames.
    const wantFrames = Math.min(20, Math.max(6, Math.round((loopHours * 3600000) / LIGHTNING_INTERVAL_MS)));
    times = times.slice(-wantFrames);
    animFrames = times.map(t => ({ time: Math.floor(new Date(t).getTime() / 1000) }));

    _syncFrameLayers(`${LIGHTNING_WMS}|${LIGHTNING_LAYER}`, times, (isoTime, i) =>
      L.tileLayer.wms(LIGHTNING_WMS, {
        layers: LIGHTNING_LAYER,
        styles: '',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        opacity: 0,
        zIndex: 200 + i,
        attribution: '',
        // Dark outline (styles.css): the palette starts at pale yellow, which
        // all but vanishes on the light street map without it.
        className: 'lightning-frame',
        // Same WKWebView guards as the radar loader.
        updateWhenZooming: false,
        keepBuffer: 0
      }));

    if (!animLayers.length) { showAnimCtrl('⚠ No frames loaded'); clearTimeout(watchdog); _radarLoading = false; return; }
    _updateSatLegend(LIGHTNING_PROD);   // same legend row, same credit line

    await _showNewestThenFill(times.length - 1, () => _loadGen !== myGen);
    if (_loadGen !== myGen) { clearTimeout(watchdog); return; }

    startAnimLoop();
    _radarLoading = false;
    _framesLoadedAt = Date.now();
    clearTimeout(watchdog);
  } catch (e) {
    clearTimeout(watchdog);
    if (_loadGen !== myGen) return;
    _radarLoading = false;
    showAnimCtrl('⚠ Retrying…');
    _retryHandle = setTimeout(loadLightningFrames, TIMINGS.WMS_RETRY_MS);
  }
}

// ── Base layer switching ───────────────────────────────────────────────────────

function applyBase() {
  if (!lmap) return;
  clearAnim();
  // Re-enable buttons in case satellite mode disabled them
  ['radar-play-btn', 'radar-prev', 'radar-next'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.style.opacity = ''; }
  });
  [baseTile, overlayTile].forEach(l => { if (l) lmap.removeLayer(l); });
  baseTile = overlayTile = null;

  document.getElementById('prod-row').style.display = 'none';
  document.getElementById('sat-prod-row').style.display = 'none';

  if (curBase === 'radar') {
    document.getElementById('prod-row').style.display = 'flex';
    // Header title is now the app name on every tab; the radar/satellite
    // distinction lives in the status strip below.
    const strip = document.querySelector('#s-map .ss-txt');
    if (strip) {
      const rs = activeLocation.radarStation;
      const city = displayName(activeLocation).split(',')[0].trim();
      strip.textContent = 'NWS RADAR \xb7 '
        + (rs ? rs + (city ? ' \xb7 ' + city.toUpperCase() : '') : 'NEXRAD MOSAIC')
        + ' \xb7 RIDGE2';
    }
    // Plain OSM basemap beneath the animated radar frames (zIndex 200+).
    //
    // Attribution is required by the ODbL and was previously blank. It is a
    // <span> with a delegated data-click-action rather than an <a href>: the app
    // ships zero anchors on purpose, because a plain link inside the WKWebView
    // navigates away from the app with no way back. openOsmCopyright routes it
    // through window.open like every other external link here.
    //
    // Identification: the OSMF tile policy asks for a User-Agent naming the app.
    // Tile requests are <img> loads, so no per-request header is possible — the
    // UA is set once for the whole WebView via `appendUserAgent` in
    // capacitor.config.json, which covers these automatically.
    baseTile = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, maxNativeZoom: 19, opacity: 1,
      attribution: '&copy; <span class="osm-attrib-link" data-click-action="openOsmCopyright" role="link" tabindex="0">OpenStreetMap</span> contributors'
    }).addTo(lmap);
    loadRadarFrames(); // legend updated inside loadRadarFrames via _updateRadarLegend

  } else if (curBase === 'satellite') {
    document.getElementById('sat-prod-row').style.display = 'flex';
    const strip = document.querySelector('#s-map .ss-txt');
    if (strip) strip.textContent = 'GOES-EAST \xb7 NASA GIBS/EARTHDATA \xb7 LIVE';
    // GOES imagery includes its own complete basemap — no OSM tile underneath.
    // Showing OSM causes a mismatch whenever a satellite frame hasn't loaded yet.
    baseTile = null;
    loadSatFrames();

  } else if (curBase === 'lightning') {
    // No product row: there is one lightning product.
    const strip = document.querySelector('#s-map .ss-txt');
    if (strip) strip.textContent = 'NOAA LIGHTNING · NLDN/GLD360 · 15-MIN FRAMES';
    // Same street map as radar (see the attribution note there): strike cells
    // need place names under them to mean anything.
    baseTile = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, maxNativeZoom: 19, opacity: 1,
      attribution: '&copy; <span class="osm-attrib-link" data-click-action="openOsmCopyright" role="link" tabindex="0">OpenStreetMap</span> contributors'
    }).addTo(lmap);
    loadLightningFrames();
  }

  if (mapAlertsOn) drawMapAlerts();
}

// Cache key: NWS zone URL. Value: geometry object or null. We cache the null
// so we don't re-fetch zones with no published geometry every redraw.
//
// LRU-bounded, because this used to be an unbounded plain object and it is the
// largest structure in the app. A national draw touches ~1,700 zones (see
// ZONE_FETCH_CONCURRENCY below), each a full polygon ring array, and
// _alertLayers holds a second reference to every geometry alongside it —
// none of which was ever released. That matters more here than it would
// elsewhere: WKWebView jettisons this app's content process under memory
// pressure and it reloads to the Weather tab, which is the whole reason the
// radar loop keeps only a six-frame sliding window (see FRAME_WINDOW_AHEAD).
// The frame budget was carefully accounted for; this was not in the accounting
// at all, and it was the larger of the two.
//
// Eviction is only ever a latency cost — a dropped zone is refetched on the
// next draw that needs it — so the cap can be well under a national draw's
// working set. Reads bump recency so the zones on screen (which the near wave
// and every popup tap re-touch) stay resident while the speculative far wave
// churns through the tail.
const ZONE_GEOM_CACHE_MAX = 1000;
const zoneGeomCache = new Map();

function _zoneGeomHas(url) { return zoneGeomCache.has(url); }

function _zoneGeomGet(url) {
  if (!zoneGeomCache.has(url)) return undefined;
  const g = zoneGeomCache.get(url);
  zoneGeomCache.delete(url);   // re-insert at the tail = most recently used
  zoneGeomCache.set(url, g);
  return g;
}

function _zoneGeomSet(url, geom) {
  zoneGeomCache.delete(url);
  zoneGeomCache.set(url, geom);
  // Map iterates in insertion order, so the first key is the least recently used.
  while (zoneGeomCache.size > ZONE_GEOM_CACHE_MAX) {
    zoneGeomCache.delete(zoneGeomCache.keys().next().value);
  }
}

// Cache of the most recent /alerts/active response. NWS publishes ~5-min
// updates, and the user reopening the Map screen / pulling-to-refresh re-runs
// drawMapAlerts() — without a TTL we'd hammer the endpoint and download ~1 MB
// of GeoJSON every time. 60s is short enough to feel live but spares the API.
const ACTIVE_ALERTS_TTL_MS = 60_000;
let _activeAlertsCache = null; // { at: ms, alerts: [] }

// Track the last set of alerts we drew so re-running drawMapAlerts() with the
// same IDs (the common case for repeated map opens) is a no-op.
let _lastDrawnAlertHash = '';

async function _fetchActiveAlerts() {
  if (_activeAlertsCache && (Date.now() - _activeAlertsCache.at) < ACTIVE_ALERTS_TTL_MS) {
    return _activeAlertsCache.alerts;
  }
  // Fetch all national alerts so the map overlay works anywhere the user pans —
  // not just their home state. Cached for 60 s so the ~1 MB download only
  // happens once per minute at most. status=actual excludes test/exercise messages.
  const r = await nwsFetch('https://api.weather.gov/alerts/active?status=actual');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const alerts = d.features || [];
  _activeAlertsCache = { at: Date.now(), alerts };
  return alerts;
}

// Stable hash for "is this the same alert set we last drew?" — IDs only,
// sorted so order changes from the API don't trigger a redraw.
function _alertSetHash(alerts) {
  return alerts.map(a => a.id || a.properties?.id).filter(Boolean).sort().join('|');
}

// How many zone polygons to fetch at once. Bounded to stay clear of NWS
// rate-limiting — an alert can name 80 zones, and a national draw needs ~1,700.
const ZONE_FETCH_CONCURRENCY = 20;

// Alerts to add to the map between yields back to the event loop.
const LAYER_YIELD_EVERY = 25;

// Yield to the event loop without being throttled.
//
// `setTimeout(fn, 0)` is the obvious way and the wrong one: browsers clamp
// timers in backgrounded/hidden pages — to a second or more — so a draw that
// yields nine times would stall for nine seconds the moment the map isn't the
// visible tab. Caught exactly that way: the draw started timing out at 30s
// under measurement while the page itself was responsive.
//
// A MessageChannel message is a macrotask like a timer, so the browser still
// gets to paint between chunks, but it isn't subject to timer clamping.
const _yieldChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const _yieldWaiters = [];
if (_yieldChannel) {
  _yieldChannel.port1.onmessage = () => { const fn = _yieldWaiters.shift(); if (fn) fn(); };
}
function _yieldToEventLoop() {
  if (!_yieldChannel) return new Promise(r => setTimeout(r, 0));
  return new Promise(r => { _yieldWaiters.push(r); _yieldChannel.port2.postMessage(0); });
}
const ZONE_URL_RE = /\/zones\/(?:forecast|fire|county|public|coastal|offshore|marine|land|high_seas)\/([A-Z0-9]+)$/;

// In-flight per-zone requests, so two overlapping draws — the map opening while
// an alerts poll finishes, say — share one request per zone instead of each
// firing its own. Measured before this existed: 3,196 zone requests for a set
// of 1,720 distinct zones, i.e. every zone fetched twice.
const _zoneGeomInflight = new Map();  // url → Promise<geometry|null>
// Zone fetches that failed for a reason that may not repeat (network, 5xx,
// 429). Counted so drawMapAlerts() knows its picture is incomplete and does not
// record the alert set as fully drawn — otherwise the unchanged-set fast path
// would skip every later redraw and the missing polygons would never return.
let _zoneGeomTransientFailures = 0;

function _fetchOneZoneGeom(url) {
  if (_zoneGeomInflight.has(url)) return _zoneGeomInflight.get(url);
  const p = (async () => {
    try {
      const r = await nwsFetch(url);
      // Only a definite answer is cached: a zone that exists (with or without
      // a polygon) or one that does not (404). A 5xx or rate-limit used to be
      // cached as "no geometry" too, leaving that alert off the map for the
      // rest of the session.
      if (!r.ok && r.status !== 404) { _zoneGeomTransientFailures++; return null; }
      const geom = r.ok ? ((await r.json()).geometry || null) : null;
      _zoneGeomSet(url, geom);
      return geom;
    } catch (_) {
      _zoneGeomTransientFailures++;
      return null;
    } finally {
      _zoneGeomInflight.delete(url);
    }
  })();
  _zoneGeomInflight.set(url, p);
  return p;
}

// Zone polygons for a set of /zones/… URLs.
//
// There is no bulk geometry endpoint. `GET /zones?id=A,B,C&include_geometry=true`
// looks like one, and this function used to lead with it — but NWS ignores
// `include_geometry` on collection queries and returns `geometry: null` for
// every feature. Verified against the live API twice: a 50-id batch drawn from
// the zones this app actually looks up returned 50 features and **0**
// geometries, and the same is true of `?area=OK&type=public`. Only the per-zone
// endpoint carries the polygon.
//
// So the batch call was pure overhead: 62 SEQUENTIAL round trips per draw whose
// every result fell through to the direct path anyway. Deleting it is most of
// the fix for alerts taking ~11s to appear.
//
// `shouldAbort` lets a superseded draw stop between chunks instead of running
// its fetches to completion and discarding them at the next checkpoint.
async function fetchZoneGeoms(urls, shouldAbort) {
  const out = new Map();
  const need = [];

  for (const url of urls) {
    if (_zoneGeomHas(url)) { out.set(url, _zoneGeomGet(url)); continue; }
    if (!ZONE_URL_RE.test(url)) { _zoneGeomSet(url, null); out.set(url, null); continue; }
    need.push(url);
  }

  for (let i = 0; i < need.length; i += ZONE_FETCH_CONCURRENCY) {
    if (shouldAbort && shouldAbort()) return out;
    const chunk = need.slice(i, i + ZONE_FETCH_CONCURRENCY);
    const geoms = await Promise.all(chunk.map(_fetchOneZoneGeom));
    chunk.forEach((url, n) => out.set(url, geoms[n]));
  }

  return out;
}

// ── Alert popup ──────────────────────────────────────────────────────────────
// A tap on the map can land inside several overlapping alert polygons at once
// (a tornado warning inside a severe thunderstorm watch inside a heat advisory
// is routine). The popup therefore lists every alert under the tap point as a
// one-line row and keeps the prose — description + instruction, which is what
// used to fill the screen — collapsed behind that row until it's asked for.
//
// The list is also the fix for a second problem: Leaflet only delivers a click
// to the topmost SVG path, so the alerts underneath were unreachable. Hits are
// resolved ourselves with point-in-polygon against every drawn alert.

// Which alert is "on top" in the list — same order the legend/severity styling
// implies, most urgent first, then soonest to expire.
const _SEV_RANK = { warning: 0, watch: 1, advisory: 2, statement: 3 };

function _ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// First ring is the outer boundary, the rest are holes.
function _polyContains(rings, lng, lat) {
  if (!rings || !rings.length || !_ringContains(rings[0], lng, lat)) return false;
  for (let i = 1; i < rings.length; i++) if (_ringContains(rings[i], lng, lat)) return false;
  return true;
}

function _geomContains(geom, latlng) {
  if (!geom || !latlng) return false;
  // Panning past the antimeridian gives longitudes outside ±180; GeoJSON
  // coordinates never are, so normalise before testing.
  const lng = ((latlng.lng + 180) % 360 + 360) % 360 - 180;
  const lat = latlng.lat;
  if (geom.type === 'Polygon')      return _polyContains(geom.coordinates, lng, lat);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(rings => _polyContains(rings, lng, lat));
  return false;
}

// Every currently drawn alert whose polygon contains the tap point, most urgent
// first, one entry per distinct weather event — groupAlertTransmissions() in
// app.js collapses the re-issues and counts them, so a row can say "latest of
// 3" rather than five near-identical rows appearing.
//
// Deduping happens here, at the tap point, not at draw time: every polygon
// stays on the map, so collapsing a re-issue that covers a slightly different
// county set can't erase coverage anywhere else.
function _alertsAtPoint(latlng) {
  const byId = new Map();
  for (const { props, geom, layer, versions } of _alertLayers) {
    if (!props) continue;
    try {
      if (layer.getBounds && !layer.getBounds().contains(latlng)) continue;
    } catch (_) { /* fall through to the exact test */ }
    if (!_geomContains(geom, latlng)) continue;
    // One alert can be drawn from several zone polygons, and appears once per layer.
    const id = props.id || `${props.event}|${props.areaDesc}|${props.sent}`;
    if (!byId.has(id)) byId.set(id, { props, versions: versions || 1 });
  }

  // Regrouped on the looser key: the draw step already merged same-area
  // re-issues, this merges the same event across different areas into one row
  // and carries the transmission counts through.
  const out = regroupAlertEntries([...byId.values()]);
  out.sort((a, b) => {
    const d = (_SEV_RANK[nwsEventSeverity(a.props.event)] ?? 3) - (_SEV_RANK[nwsEventSeverity(b.props.event)] ?? 3);
    if (d) return d;
    return new Date(alertEndsAt(a.props) || 0) - new Date(alertEndsAt(b.props) || 0);
  });
  return out;
}

// Which of the alert's locations contains the tapped point, so the popup can
// lead its location list with the one under the reader's finger rather than
// whichever county NWS happens to list first.
//
// Works off the per-zone polygons already cached by fetchZoneGeoms() — which
// exist for exactly the alerts that need this, the zone-based ones (heat, air
// quality, winter storm) whose county lists run to dozens of names. Alerts with
// their own polygon geometry never had zones fetched, so they keep NWS order;
// their lists are only a few counties long.
function _alertAreaLeadAtPoint(p, latlng) {
  const zones = p?.affectedZones;
  if (!latlng || !Array.isArray(zones) || !zones.length) return -1;
  if (zones.length !== alertAreaList(p.areaDesc).length) return -1;
  for (let i = 0; i < zones.length; i++) {
    const g = _zoneGeomGet(zones[i]);
    if (g && _geomContains(g, latlng)) return i;
  }
  return -1;
}

// Re-runs Leaflet's popup layout + auto-pan after content inside it grows or
// shrinks (a row expanding, an area list unfolding).
function _refreshOpenAlertPopup() {
  if (!lmap || !_openAlertPop || !lmap.hasLayer(_openAlertPop)) return;
  setTimeout(() => {
    if (lmap && _openAlertPop && lmap.hasLayer(_openAlertPop)) _openAlertPop.update();
  }, 0);
}

// The header is filled with the alert's own colour, and NWS palettes run from
// near-black (dust storm) to bright yellow (watches) and cyan (advisories) —
// white header text disappears on the light half. Pick the text colour from
// perceived luminance instead of assuming a dark fill.
function _hdrTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#00152e' : '#fff';
}

// Severe-weather tags + storm motion (app.js). Especially useful here: you're
// already looking at where the cell is, so hail size and which way it's
// tracking are the two things the map can't tell you on its own — so they stay
// above the fold rather than inside the collapsed detail.
function _alertHeadHTML(p) {
  const tagsHTML = typeof alertTagsHTML === 'function' ? alertTagsHTML(p) : '';
  const motion   = typeof alertMotion   === 'function' ? alertMotion(p)   : '';
  return (tagsHTML ? `<div class="nws-pop-tags">${tagsHTML}</div>` : '')
       + (motion ? `<div class="nws-pop-motion">${esc(motion)}</div>` : '');
}

// The long part: everything that made the old popup a wall of text, plus a way
// out to the Alerts screen — a popup pinned to a map pin is a cramped place to
// read a full warning, and that screen is built for it.
function _alertDetailHTML(p, withArea, latlng) {
  const area  = withArea ? areaListHTML(p.areaDesc, 'nws-pa-area', _alertAreaLeadAtPoint(p, latlng)) : '';
  const desc  = (p.description || '').trim().replace(/\n{3,}/g, '\n\n');
  const instr = (p.instruction || '').trim();
  return `${area}
    ${p.headline ? `<div class="nws-pop-headline">${esc(p.headline)}</div>` : ''}
    ${desc ? `<div class="nws-pop-desc">${esc(desc)}</div>` : ''}
    ${instr ? `<div class="nws-pop-instr"><b>What to do:</b> ${esc(instr)}</div>` : ''}
    ${!desc && !instr && !p.headline ? '<div class="nws-pop-desc">No further detail published.</div>' : ''}
    ${p.id ? `<button class="nws-pa-open" data-click-action="openAlertInAlerts" data-alert-id="${esc(p.id)}">Open in Alerts <span class="clbl-chev">›</span></button>` : ''}`;
}

function _alertRowHTML(label, sub, col, detail) {
  return `<div class="nws-pa-item">
    <button class="nws-pa-row" data-click-action="toggleMapAlertRow" aria-expanded="false">
      ${col ? `<span class="nws-pa-dot" data-css-bg="${col}"></span>` : ''}
      <span class="nws-pa-txt">
        <span class="nws-pa-ev">${label}</span>
        ${sub ? `<span class="nws-pa-sub">${sub}</span>` : ''}
      </span>
      <span class="nws-pa-chev" aria-hidden="true">›</span>
    </button>
    <div class="nws-pa-det">${detail}</div>
  </div>`;
}

// `list` is `{props, versions}` per distinct weather event under the tap point,
// most urgent first — see _alertsAtPoint().
function buildAlertPopup(list, latlng) {
  const top   = list[0].props;
  const multi = list.length > 1;
  const col   = alertMapStyle(top).color;

  // Every row carries when it was issued and when it runs out — two alerts can
  // share an event name and still be different warnings (two Flash Flood
  // Warnings for the same county, different VTEC event numbers), and the times
  // are what tell them apart.
  const times = (e) => [
    ...alertTimeLabels(e.props),
    e.versions > 1 ? `latest of ${e.versions}` : '',
  ].filter(Boolean).join(' · ');

  const body = multi
    ? list.map(e => _alertRowHTML(
        `${alertEmoji(e.props.event)} ${esc(e.props.event || 'Alert')}`,
        esc(times(e)),
        nwsEventColor(e.props.event),
        _alertHeadHTML(e.props) + _alertDetailHTML(e.props, true, latlng)
      )).join('')
    // A single alert has nothing to disambiguate, so its tags/motion/times sit
    // in the open and only the prose is behind the toggle.
    : _alertHeadHTML(top)
      + (times(list[0]) ? `<div class="nws-pop-exp">${esc(times(list[0]))}</div>` : '')
      // No area here: the header's list is already expandable in place.
      + _alertRowHTML('Full details', '', '', _alertDetailHTML(top, false, latlng));

  return `<div class="nws-pop-wrap">
    <div class="nws-pop-hdr" data-css-bg="${col}" data-css-color="${_hdrTextColor(col)}">
      <button class="nws-pop-x" data-click-action="closeMapPopup" aria-label="Close alert">&times;</button>
      <div class="nws-pop-event">${multi
        ? `⚠️ ${list.length} alerts here`
        : `${alertEmoji(top.event)} ${esc(top.event || 'Alert')}`}</div>
      <div class="nws-pop-area">${multi ? 'Tap one to read it'
        : areaListHTML(top.areaDesc, '', _alertAreaLeadAtPoint(top, latlng))}</div>
    </div>
    <div class="nws-pop-body">${body}</div>
  </div>`;
}

// The popup currently open, so a row expand can re-run Leaflet's layout/auto-pan
// against the taller box.
let _openAlertPop = null;

function openAlertPopupAt(latlng, fallbackProps) {
  const hits = _alertsAtPoint(latlng);
  // The hit test can come up empty on a tap right on a polygon edge, where the
  // renderer's stroke width is generous and ray casting is not. Fall back to
  // the alert whose path actually received the click.
  const list = hits.length ? hits : (fallbackProps ? [{ props: fallbackProps, versions: 1 }] : []);
  if (!list.length || !lmap) return;

  // Content goes in as a DOM node, not an HTML string: Leaflet's popup
  // update() re-renders string content from scratch, which would throw away
  // the row the user just expanded — the very thing update() is called for.
  const holder = document.createElement('div');
  holder.innerHTML = buildAlertPopup(list, latlng);
  const content = holder.firstElementChild;
  if (!content) return;

  // Keep the popup clear of the floating map controls. The base-layer switcher
  // and the fullscreen/refresh buttons sit at z-index 500 as siblings of #lmap,
  // while Leaflet's popup pane is z-index 700 but *inside* .leaflet-map-pane,
  // which is itself z-index 400 with a transform — a stacking context. So the
  // popup can never paint above the controls, and one opened near the top of
  // the map had its header covered. Raising .leaflet-map-pane would lift the
  // tiles over the controls too, so instead we tell Leaflet's auto-pan to treat
  // the top ~74px as occupied and shift the map down.
  const pop = L.popup({
    maxWidth: 280, className: 'nws-popup', closeButton: false,
    autoPanPaddingTopLeft: L.point(12, 74),
    autoPanPaddingBottomRight: L.point(12, 12),
  })
    .setLatLng(latlng)
    .setContent(content);
  pop.openOn(lmap);
  _openAlertPop = pop;
  // Leaflet runs its auto-pan while the popup is still being laid out, so it
  // measures a shorter box than the finished one, decides no pan is needed, and
  // leaves a tall alert popup overlapping the floating controls — or clean off
  // the top edge of the map. update() re-runs layout and auto-pan once the
  // browser has settled the content. A timeout rather than
  // requestAnimationFrame: rAF is throttled to nothing when the tab isn't
  // visible, and this must still be correct when the map screen is restored
  // from the background.
  setTimeout(() => { if (lmap && lmap.hasLayer(pop)) pop.update(); }, 0);
}

// Accordion: expanding one alert collapses the others, so the popup can never
// grow back into a full-screen block of text.
function toggleMapAlertRow(btn) {
  const item = btn.closest('.nws-pa-item');
  if (!item) return;
  const open = item.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && item.parentElement) {
    for (const other of item.parentElement.querySelectorAll('.nws-pa-item.open')) {
      if (other === item) continue;
      other.classList.remove('open');
      other.querySelector('.nws-pa-row')?.setAttribute('aria-expanded', 'false');
    }
  }
  // Bring the row the user just opened to the top of the scroll box, so the
  // text they asked for isn't below the fold of a list they have to scroll.
  const box = btn.closest('.nws-pop-body');
  if (open && box) {
    box.scrollTop += item.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }
  if (lmap && _openAlertPop && lmap.hasLayer(_openAlertPop)) {
    // Same reason as the open path: the box has to finish laying out before
    // auto-pan can measure it.
    setTimeout(() => { if (lmap && _openAlertPop && lmap.hasLayer(_openAlertPop)) _openAlertPop.update(); }, 0);
  }
}

// "Open in Alerts" on a popup row. The alert's properties come from the drawn
// layers rather than the popup DOM, so the Alerts screen gets the full record
// (description, instruction, tags) and not just what the popup rendered.
function openAlertInAlerts(id) {
  const hit = _alertLayers.find(l => l.props?.id === id);
  // Carry the tapped location across so the card leads with the same place the
  // popup did. _openAlertPop's latLng is where the user actually tapped.
  const at = _openAlertPop?.getLatLng?.();
  const lead = hit ? _alertAreaLeadAtPoint(hit.props, at) : -1;
  if (typeof openAlertInAlertsTab === 'function') {
    openAlertInAlertsTab(id, hit?.props || null, lead);
  }
}

// Closes whatever alert popup is open. Wired to the X button in the popup
// header (data-click-action="closeMapPopup") so there's an obvious, finger-sized
// way to dismiss an alert box — Leaflet's default close button is disabled.
function closeMapPopup() {
  if (lmap) lmap.closePopup();
}

// Outline width is in SCREEN pixels, so it doesn't shrink with the polygon.
// Zoomed out to the national view a county zone is a few pixels across while
// its 3px warning outline stays 3px — the borders stop being an edge and become
// the whole shape, and overlapping zones turn into a mat of colour.
//
// Scaling the weight with zoom keeps the outline reading as an outline at every
// scale: hairlines at national zoom where the fill carries the meaning, full
// width once a zone is big enough to have an inside.
// Zone-based alerts are issued per COUNTY, so one product is drawn as dozens of
// adjacent polygons, each with its own outline. At national zoom those shared
// internal edges collapse into a lattice and the alert stops reading as one
// region — it becomes a mesh that swamps the radar underneath. Those lose their
// stroke when zoomed out and let the fill carry the shape.
//
// Alerts that arrive with their own polygon are the opposite case: a single
// storm footprint, small on screen, where the outline is the only thing keeping
// them visible at national zoom. They keep a hairline.
//
// The discriminator is the geometry's origin, NOT the severity tier — that was
// the first attempt and it was wrong. An Extreme Heat Warning is warning-tier
// and zone-based across hundreds of counties, so keying on severity left the
// worst lattice on the map untouched.
function _alertWeightScale(zoneBased) {
  const z = lmap ? lmap.getZoom() : 7;
  if (z <= 4) return zoneBased ? 0    : 0.30;   // national
  if (z <= 5) return zoneBased ? 0.15 : 0.45;
  if (z <= 6) return zoneBased ? 0.40 : 0.65;
  if (z <= 7) return 0.85;                      // default view — full detail from here
  if (z <= 9) return 1;
  return 1.15;                                  // street level — a touch heavier reads better
}

function alertMapStyle(p, zoneBased) {
  const col = nwsEventColor(p.event);
  const sev = nwsEventSeverity(p.event);
  const ao = alertOp;
  const w = _alertWeightScale(zoneBased);
  // With the outline gone at national zoom the fill is doing all the work, so
  // lift it enough that a washed-out advisory is still legible as a region.
  const fillBoost = w === 0 ? 1.35 : 1;
  // Fill opacities are deliberately low so polygons don't bury the radar, but
  // advisory/statement were so faint (0.08 / 0.05) they read as "nothing on the
  // map" — especially the large zone-based advisories. Bump fill + outline so
  // they're actually perceptible, preserving the severity hierarchy
  // (warning > watch > advisory > statement).
  if (sev === 'warning')  return { color: col, weight: 3   * w, opacity: ao,        fillColor: col, fillOpacity: 0.28 * ao };
  if (sev === 'watch')    return { color: col, weight: 2.5 * w, opacity: 0.9  * ao, fillColor: col, fillOpacity: 0.20 * ao };
  if (sev === 'advisory') return { color: col, weight: 2   * w, opacity: 0.85 * ao, fillColor: col, fillOpacity: 0.15 * ao * fillBoost };
  return                         { color: col, weight: 1.5 * w, opacity: 0.75 * ao, fillColor: col, fillOpacity: 0.11 * ao * fillBoost };
}

// Re-weights every drawn alert after a zoom change. Skipped when the scale band
// hasn't actually changed, so a pinch across a band boundary restyles once
// rather than on every zoomend — 200+ setStyle calls is not free.
let _lastWeightScale = null;
function _restyleAlertsForZoom() {
  // Both tiers, since they change at different zooms — keying on one would let
  // the other's band change slip through unstyled.
  const scale = _alertWeightScale(false) + '/' + _alertWeightScale(true);
  if (scale === _lastWeightScale) return;
  _lastWeightScale = scale;
  for (const { event, layer, zoneBased } of _alertLayers) {
    try { layer.setStyle(alertMapStyle({ event }, zoneBased)); } catch (_) {}
  }
}

// Rough bounding boxes for the UGC state prefixes, used ONLY to decide which
// zone polygons to fetch first (see _alertNearBounds). Deliberately generous —
// this is a priority hint, never a filter: an alert whose prefix is unknown
// (marine basins ANZ/GMZ/PZZ, the Great Lakes LEZ/LMZ/…) or whose box misses
// the viewport is still fetched and drawn, just in the later wave. So a wrong
// box costs a little ordering, never a missing alert.
// [minLat, minLon, maxLat, maxLon]
const US_STATE_BOUNDS = {
  AL: [30.1, -88.5, 35.1, -84.8], AK: [51.0, -180.0, 72.0, -129.0],
  AZ: [31.3, -115.0, 37.1, -109.0], AR: [33.0, -94.7, 36.6, -89.6],
  CA: [32.5, -124.5, 42.1, -114.1], CO: [36.9, -109.1, 41.1, -102.0],
  CT: [40.9, -73.8, 42.1, -71.7], DE: [38.4, -75.8, 39.9, -74.9],
  DC: [38.8, -77.2, 39.0, -76.9], FL: [24.4, -87.7, 31.1, -79.9],
  GA: [30.3, -85.7, 35.1, -80.8], HI: [18.8, -160.3, 22.3, -154.7],
  ID: [41.9, -117.3, 49.1, -110.9], IL: [36.9, -91.6, 42.6, -87.4],
  IN: [37.7, -88.2, 41.8, -84.7], IA: [40.3, -96.7, 43.6, -90.1],
  KS: [36.9, -102.1, 40.1, -94.5], KY: [36.4, -89.6, 39.2, -81.9],
  LA: [28.8, -94.1, 33.1, -88.7], ME: [42.9, -71.1, 47.5, -66.9],
  MD: [37.8, -79.5, 39.8, -74.9], MA: [41.1, -73.6, 42.9, -69.8],
  MI: [41.6, -90.5, 48.4, -82.1], MN: [43.4, -97.3, 49.5, -89.4],
  MS: [30.1, -91.7, 35.1, -88.0], MO: [35.9, -95.8, 40.7, -89.0],
  MT: [44.3, -116.1, 49.1, -104.0], NE: [39.9, -104.1, 43.1, -95.3],
  NV: [35.0, -120.1, 42.1, -114.0], NH: [42.6, -72.6, 45.4, -70.5],
  NJ: [38.9, -75.6, 41.4, -73.8], NM: [31.3, -109.1, 37.1, -103.0],
  NY: [40.4, -79.8, 45.1, -71.8], NC: [33.8, -84.4, 36.6, -75.4],
  ND: [45.9, -104.1, 49.1, -96.5], OH: [38.4, -84.9, 42.4, -80.5],
  OK: [33.6, -103.1, 37.1, -94.4], OR: [41.9, -124.6, 46.3, -116.4],
  PA: [39.7, -80.6, 42.3, -74.6], RI: [41.1, -71.9, 42.1, -71.1],
  SC: [32.0, -83.4, 35.3, -78.4], SD: [42.4, -104.1, 46.0, -96.4],
  TN: [34.9, -90.4, 36.7, -81.6], TX: [25.8, -106.7, 36.6, -93.5],
  UT: [36.9, -114.1, 42.1, -109.0], VT: [42.7, -73.5, 45.1, -71.4],
  VA: [36.5, -83.7, 39.5, -75.2], WA: [45.5, -124.9, 49.1, -116.9],
  WV: [37.1, -82.7, 40.7, -77.7], WI: [42.4, -92.9, 47.1, -86.2],
  WY: [40.9, -111.1, 45.1, -104.0], PR: [17.8, -67.3, 18.6, -65.2],
  VI: [17.6, -65.1, 18.5, -64.5], GU: [13.2, 144.6, 13.7, 145.0],
  AS: [-14.4, -171.1, -14.2, -169.4], MP: [14.0, 145.1, 20.6, 146.1],
};

// Could this zone-based alert plausibly be on screen? Returns true when in
// doubt — see the note on US_STATE_BOUNDS.
function _alertNearBounds(alert, bounds) {
  const zones = alert.properties?.affectedZones;
  if (!zones || !zones.length) return true;
  for (const u of zones) {
    // A zone already in cache costs no network, so there's nothing to defer.
    // Membership only — no recency bump: this runs over every zone of every
    // alert on each draw, and a hit here doesn't mean the zone is on screen.
    if (_zoneGeomHas(u)) return true;
    const m = ZONE_URL_RE.exec(u);
    if (!m) return true;
    const b = US_STATE_BOUNDS[m[1].slice(0, 2)];
    if (!b) return true;
    if (bounds.getSouth() <= b[2] && bounds.getNorth() >= b[0]
     && bounds.getWest()  <= b[3] && bounds.getEast()  >= b[1]) return true;
  }
  return false;
}

// Stores {event, color, layer} for every drawn alert polygon so the legend
// can be rebuilt from only the layers currently visible in the viewport.
let _alertLayers = [];
// Combined LatLngBounds per event type — used by legend tap-to-fly.
let _alertEventBounds = new Map();
// Generation token for drawMapAlerts(). The function awaits twice between
// removing the old layer group and creating the new one, so two interleaved
// calls could each addTo(lmap) a fresh group — orphaning the first, which the
// off-toggle then can't remove. Each call captures `gen`; a newer call (or an
// off-toggle) bumps the counter, and stale runs bail at their next checkpoint
// before committing, guaranteeing a single live alertsMapLayer.
let _alertDrawGen = 0;

// Rebuilds the legend to show only alert types whose polygons intersect the
// current map viewport. Called after drawMapAlerts() and on every moveend/zoomend.
function _refreshAlertLegend() {
  const lgnd = document.getElementById('map-al-lgnd');
  if (!lgnd) return;
  if (!lmap || !_alertLayers.length) {
    lgnd.innerHTML = '<div class="ali _s-c7ddd2">No active alerts</div>';
    _alertEventBounds.clear();
    return;
  }
  const mapBounds = lmap.getBounds();
  const seen = new Map();
  _alertEventBounds.clear();
  for (const { event, color, layer } of _alertLayers) {
    try {
      if (layer.getBounds && mapBounds.intersects(layer.getBounds())) {
        if (!seen.has(event)) seen.set(event, color);
        const lb = layer.getBounds();
        const existing = _alertEventBounds.get(event);
        _alertEventBounds.set(event, existing ? existing.extend(lb) : lb);
      }
    } catch (e) { _warn('alertLegend/bounds', e); }
  }
  lgnd.innerHTML = seen.size
    ? [...seen.entries()].map(([ev, col]) =>
        `<div class="ali ali-btn" data-alert-ev="${esc(ev)}"><div class="als" data-css-bg="${col}"></div>${esc(ev)}</div>`
      ).join('')
    : '<div class="ali _s-c7ddd2">No alerts in view</div>';
}

function _bindAlertLegendClick() {
  const lgnd = document.getElementById('map-al-lgnd');
  if (!lgnd || lgnd._alertClickBound) return;
  lgnd._alertClickBound = true;
  lgnd.addEventListener('click', e => {
    const item = e.target.closest('.ali-btn');
    if (!item || !lmap) return;
    const bounds = _alertEventBounds.get(item.dataset.alertEv);
    if (!bounds) return;
    document.getElementById('map-controls')?.classList.remove('sheet-open');
    lmap.flyToBounds(bounds, { padding: [40, 40], maxZoom: 9, duration: 0.8 });
  });
}

async function drawMapAlerts() {
  if (!lmap) return;
  const gen = ++_alertDrawGen; // supersede any in-flight draw

  // The map overlay shows ALL active US alerts regardless of the user's
  // configured location — so panning anywhere shows the correct polygons.
  // Fall back to wxData.alerts (already fetched for the local zone) only if
  // the national fetch fails entirely.
  let alerts = [];
  try { alerts = await _fetchActiveAlerts(); }
  catch (_) { alerts = wxData.alerts || []; }

  // Bail if alerts were toggled off, or a newer draw superseded us, mid-fetch.
  if (!mapAlertsOn || gen !== _alertDrawGen) return;

  // No-op if the alert set is unchanged since last draw. Cheap fast-path for
  // repeated map opens / pull-to-refresh against the same fixture data.
  const hash = _alertSetHash(alerts);
  if (hash === _lastDrawnAlertHash && alertsMapLayer) return;

  if (alertsMapLayer) { lmap.removeLayer(alertsMapLayer); alertsMapLayer = null; }
  _alertLayers = [];

  if (!alerts.length) {
    const lgnd = document.getElementById('map-al-lgnd');
    if (lgnd) lgnd.innerHTML = '<div class="ali _s-c7ddd2">No active alerts</div>';
    _lastDrawnAlertHash = hash;
    return;
  }

  // Collapse re-transmissions that cover exactly the same ground before drawing
  // anything. NWS re-issues a running advisory without cancelling the earlier
  // copies, so the national feed had 218 alerts for 190 distinct events — and
  // 13 of those extras were identical polygons stacked on each other. Alert
  // fills are semi-transparent, so five stacked Air Quality polygons over Boise
  // rendered five times as opaque as the same advisory anywhere else, making the
  // opacity slider lie about that region and burning WebView layers the radar
  // loop needs (see the frame-window note in CLAUDE.md).
  //
  // Keyed on area as well as event: two segments of one VTEC event can be live
  // over different zone groups, and those are different ground — the popup
  // still merges them into one row via the looser key in _alertsAtPoint().
  const featByProps = new Map();
  for (const a of alerts) if (a?.properties) featByProps.set(a.properties, a);
  const drawEntries = groupAlertTransmissions([...featByProps.keys()], Date.now(), alertGroupAreaKey);
  const versionsByProps = new Map(drawEntries.map(e => [e.props, e.versions]));
  alerts = drawEntries.map(e => featByProps.get(e.props));

  alertsMapLayer = L.layerGroup().addTo(lmap);
  const failuresAtStart = _zoneGeomTransientFailures;

  // Drawn in three waves, cheapest and most relevant first, so the map shows
  // something useful in well under a second instead of staying blank until the
  // slowest wave finishes.
  //
  // The old code fetched EVERY zone polygon up front and drew nothing until the
  // last one landed. On a busy day that's ~1,600 per-zone requests at
  // ZONE_FETCH_CONCURRENCY — measured at ~8s of blank map, for a national feed
  // that itself downloads in 0.6s. Nothing about the wait was load-bearing:
  // a third of the alerts ship their own polygon and need no fetch at all, and
  // of the rest only the handful near the viewport is visible at zoom 7.
  //
  //   1. alerts with inline geometry — no fetch, on screen as soon as the feed
  //      lands. These are also the ones that matter most: tornado, severe
  //      thunderstorm and flash flood warnings are all polygon-issued.
  //   2. zone-based alerts whose zones could be on screen (see _alertNearBounds)
  //   3. everything else, so panning away is still instant
  //
  // Wave 3 does the same total work as before, just after the user can see and
  // use the map. _lastDrawnAlertHash is set only when all three finish, so an
  // interrupted draw is never mistaken for a complete one.
  const zoned  = [];
  const inline = [];
  for (const a of alerts) (a.geometry ? inline : zoned).push(a);
  const view = lmap.getBounds();
  const near = [], far = [];
  for (const a of zoned) (_alertNearBounds(a, view) ? near : far).push(a);

  if (!await _addAlertLayers(inline, new Map(), versionsByProps, gen)) return;
  _refreshAlertLegend();

  for (const group of [near, far]) {
    if (!group.length) continue;
    const zoneUrls = new Set();
    for (const a of group) {
      for (const u of (a.properties?.affectedZones || [])) zoneUrls.add(u);
    }
    // The abort callback stops a superseded draw between chunks. The gen check
    // below already discarded its results, but it used to run every one of its
    // ~1,700 zone requests to completion first before finding that out.
    const geomByUrl = await fetchZoneGeoms(
      [...zoneUrls],
      () => !mapAlertsOn || gen !== _alertDrawGen,
    );
    // Toggled off, or superseded by a newer draw, while zone geometries were
    // fetching. Without this a stale run would keep appending to a layer group
    // that is no longer the live one.
    if (!mapAlertsOn || gen !== _alertDrawGen) return;
    if (!await _addAlertLayers(group, geomByUrl, versionsByProps, gen)) return;
    _refreshAlertLegend();
  }

  // Warnings last went on the map before the advisories that came in later
  // waves, so they'd sit UNDER them — and alert fills are semi-transparent, so
  // a tornado warning showed through a heat advisory instead of over it.
  for (const l of _alertLayers) {
    if (nwsEventSeverity(l.event) === 'warning' && l.layer.bringToFront) {
      try { l.layer.bringToFront(); } catch (_) {}
    }
  }

  // Layers were just built at the current zoom's weight, so record it — a later
  // zoomend at the same band then correctly skips the restyle.
  _lastWeightScale = _alertWeightScale(false) + '/' + _alertWeightScale(true);

  // Build legend from only the polygons visible in the current viewport.
  // _refreshAlertLegend() is also wired to moveend/zoomend so it stays live.
  _refreshAlertLegend();
  // Incomplete draw (some zones failed transiently): leave the hash unset so
  // the next draw — the next alerts poll or map visit — fetches them again.
  if (_zoneGeomTransientFailures === failuresAtStart) _lastDrawnAlertHash = hash;
}

// Builds and attaches the Leaflet layers for one wave of alerts, appending to
// the live alertsMapLayer. Returns false if the draw was superseded or toggled
// off partway, in which case the caller must stop.
//
// Building the layers is the other half of the cost — 844ms of unbroken
// synchronous work for a national draw, measured, which blocks the main thread
// outright: during it a 50ms interval fired twice instead of ~17 times, so taps
// and pans went unanswered and the map looked hung.
//
// Yielding every LAYER_YIELD_EVERY alerts hands the thread back so Leaflet can
// paint what's built so far. Polygons appear in waves instead of all at once
// after a freeze, which is both responsive and a better progress cue.
async function _addAlertLayers(alerts, geomByUrl, versionsByProps, gen) {
  let sinceYield = 0;

  for (const alert of alerts) {
    const p = alert.properties || {};
    let geom = alert.geometry;

    if (!geom && p.affectedZones?.length) {
      const valid = p.affectedZones
        .map(u => geomByUrl.get(u))
        .filter(Boolean);
      if (valid.length === 1) {
        geom = valid[0];
      } else if (valid.length > 1) {
        const coords = valid.flatMap(g =>
          g.type === 'Polygon' ? [g.coordinates] :
          g.type === 'MultiPolygon' ? g.coordinates : []
        );
        geom = { type: 'MultiPolygon', coordinates: coords };
      }
    }

    // Only warning/watch/advisory have tier toggles. nwsEventSeverity also
    // returns 'statement' for everything else (Air Quality Alerts, Special
    // Weather Statements, Outlooks, anything named "…Alert"). Those have no
    // toggle, so filter ONLY when an explicit tier exists and is off —
    // otherwise `!mapAlertTiers['statement']` (undefined) dropped them from the
    // map entirely even though the alerts list shows them.
    const sev = nwsEventSeverity(p.event);
    if (sev in mapAlertTiers && !mapAlertTiers[sev]) continue;

    if (geom && alertsMapLayer) {
      // Assembled from affectedZones rather than supplied inline — the county
      // lattice case that loses its outline when zoomed out.
      const zoneBased = !alert.geometry;
      const style = alertMapStyle(p, zoneBased);
      const col   = nwsEventColor(p.event);
      const geoLayer = L.geoJSON({ type: 'Feature', geometry: geom, properties: p }, {
        style: () => style,
        onEachFeature: (_, layer) => {
          // Show the popup at the click point rather than the polygon centroid,
          // which can be miles from where the user tapped on large zones.
          // `p` is only the fallback: the popup lists every alert containing the
          // point, not just the topmost path that received the DOM click.
          layer.on('click', e => openAlertPopupAt(e.latlng, p));
        }
      }).addTo(alertsMapLayer);
      // Store for viewport-filtered legend refresh + point-in-polygon hit tests
      _alertLayers.push({ event: p.event || '', color: col, layer: geoLayer, props: p, geom, zoneBased,
                          versions: versionsByProps.get(p) || 1 });

      if (++sinceYield >= LAYER_YIELD_EVERY) {
        sinceYield = 0;
        await _yieldToEventLoop();
        // Re-check after every yield: a newer draw (or the off-toggle) may have
        // replaced alertsMapLayer while we were off the thread, and appending to
        // a group that is no longer on the map orphans the layers.
        if (!mapAlertsOn || gen !== _alertDrawGen) return false;
      }
    }
  }
  return true;
}

function setBase(mode, btn) {
  curBase = mode;
  saveMapPrefs();
  document.querySelectorAll('.lbtn').forEach(b => b.classList.remove('on', 'on-sat', 'on-lt'));
  btn.classList.add(mode === 'radar' ? 'on' : mode === 'lightning' ? 'on-lt' : 'on-sat');
  applyBase();
  updateProductHint();
}

// #9: change how many hours the animation loop spans, then rebuild it.
function setLoopLen(len) {
  const n = +len;
  if (![1, 2, 3].includes(n)) return;
  loopHours = n;
  saveMapPrefs();
  document.querySelectorAll('.llbtn').forEach(b => b.classList.toggle('active', +b.dataset.len === n));
  // No clearAnim() — the span shares its newest frames with the old one either
  // way, so _syncFrameLayers() keeps them and fetches only the frames the wider
  // span added. 1h → 3h used to re-download the hour already on screen.
  reloadFrames();
}

function setOp(v) {
  curOp = +v / 100;
  saveMapPrefs();
  document.getElementById('opVal').textContent = v + '%';
  if (animLayers.length) {
    animLayers[animFrameIdx]?.setOpacity(curOp);
  } else if (overlayTile) {
    overlayTile.setOpacity(curOp);
  }
}

function setAlertOp(v) {
  alertOp = +v / 100;
  saveMapPrefs();
  const lbl = document.getElementById('alertOpVal');
  if (lbl) lbl.textContent = v + '%';
  for (const { event, layer, zoneBased } of _alertLayers) {
    try { layer.setStyle(alertMapStyle({ event }, zoneBased)); } catch (_) {}
  }
}

function toggleMapAlerts(on) {
  mapAlertsOn = on;
  saveMapPrefs();
  document.getElementById('map-tog-lbl').textContent = on ? 'On' : 'Off';
  const tierRow = document.getElementById('alert-tier-row');
  if (tierRow) tierRow.style.display = on ? 'flex' : 'none';
  const opRow = document.getElementById('alert-op-row');
  if (opRow) opRow.style.display = on ? 'flex' : 'none';
  document.getElementById('map-al-lgnd').style.display = on ? 'flex' : 'none';
  if (on && lmap) drawMapAlerts();
  else {
    // Supersede any in-flight draw so it can't re-add polygons after we clear.
    _alertDrawGen++;
    if (alertsMapLayer && lmap) { lmap.removeLayer(alertsMapLayer); alertsMapLayer = null; }
    _alertLayers = [];
  }
}

function _syncAlertTierUI() {
  ['warning','watch','advisory'].forEach(tier => {
    const btn = document.getElementById('at-' + tier);
    if (btn) btn.classList.toggle('on', !!mapAlertTiers[tier]);
  });
}

function toggleAlertTier(tier) {
  if (!tier || !(tier in mapAlertTiers)) return;
  mapAlertTiers[tier] = !mapAlertTiers[tier];
  saveMapPrefs();
  _syncAlertTierUI();
  // Force redraw so the filter change takes effect immediately.
  _lastDrawnAlertHash = '';
  if (mapAlertsOn && lmap) drawMapAlerts();
}

function reloadFrames() {
  if (curBase === 'radar') loadRadarFrames();
  else if (curBase === 'satellite') loadSatFrames();
  else if (curBase === 'lightning') loadLightningFrames();
}

// Reload the loop (and the overlays that carry their own caches) when the
// frames on screen are older than MAP_FRAMES_MAX_AGE_MS. Called on entering the
// map, on returning to the app while it is showing, and once a minute while it
// is visible. `onlyIfPlaying`: the minute timer leaves a paused loop alone — a
// user stepping through frames to study one cell should not have the loop
// rebuilt under them — while arriving at the map always gets fresh imagery.
function _refreshFramesIfStale(onlyIfPlaying) {
  if (!lmap || _radarLoading) return;
  if (!_framesLoadedAt || Date.now() - _framesLoadedAt < MAP_FRAMES_MAX_AGE_MS) return;
  if (onlyIfPlaying && !animPlaying) return;
  _framesLoadedAt = Date.now();   // one attempt per window, even if this load fails
  reloadFrames();
  if (mapTropicalOn && typeof drawTropical === 'function') drawTropical();
  if (mapWinterOn && typeof drawWinterMap === 'function') drawWinterMap();
}

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (!document.getElementById('s-map')?.classList.contains('active')) return;
  _refreshFramesIfStale(true);
}, 60 * 1000);

// Pause animation when the user leaves the Map screen or backgrounds the tab,
// so we don't keep firing setIntervals + WMS fetches needlessly. The user can
// hit play again to resume.
let _wasPlayingBeforeHide = false;
function pauseAnimForBackground() {
  if (animPlaying) {
    _wasPlayingBeforeHide = true;
    stopAnimLoop();
  }
}
function resumeAnimAfterBackground() {
  if (_wasPlayingBeforeHide && animLayers.length) startAnimLoop();
  _wasPlayingBeforeHide = false;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseAnimForBackground();
  else if (document.visibilityState === 'visible' && document.getElementById('s-map')?.classList.contains('active')) {
    resumeAnimAfterBackground();
    _refreshFramesIfStale(false);
  }
});

// Fullscreen mode hides the map-controls panel so the map fills the whole area.
// State is persisted under the same MAP_PREFS key.
function toggleMapFullscreen() {
  const sMap = document.getElementById('s-map');
  if (!sMap) return;
  // Close the controls sheet before going fullscreen so the two states
  // don't fight each other.
  const ctrl = document.getElementById('map-controls');
  if (ctrl) ctrl.classList.remove('sheet-open');
  const isFs = sMap.classList.toggle('map-fullscreen');
  // Save under prefs so the user's choice survives reload
  try {
    const p = JSON.parse(localStorage.getItem(MAP_PREFS_KEY) || '{}') || {};
    p.fullscreen = isFs;
    localStorage.setItem(MAP_PREFS_KEY, JSON.stringify(p));
  } catch (_) {}
  // Resize the map so Leaflet re-renders into the new container size
  setTimeout(() => lmap?.invalidateSize(), 250);
  _syncDeckHeightSoon();
  const btn = document.getElementById('map-fs-btn');
  if (btn) btn.textContent = isFs ? '⤣' : '⤢';
}

// Publishes the deck's real height as --deck-h on #map-wrap. The OpenStreetMap
// credit is anchored bottom-right *inside* the Leaflet container, and the deck
// floats over the bottom of that same container — without this the credit would
// be swallowed the moment the deck grew. Called after every state change, once
// the CSS transition has settled.
function _syncDeckHeight() {
  const wrap = document.getElementById('map-wrap');
  const ctrl = document.getElementById('map-controls');
  if (!wrap) return;
  const fs = document.getElementById('s-map')?.classList.contains('map-fullscreen');
  // Fullscreen hides the deck entirely, so the credit drops to the map's edge.
  wrap.style.setProperty('--deck-h', (!ctrl || fs) ? '0px' : ctrl.offsetHeight + 'px');
}

// Watch the deck itself rather than sampling on a timer. The deck's height
// settles over a 0.3s transition and then keeps moving — the frame dots fill in
// as radar frames load, the product hint rewraps, the satellite row swaps in —
// so any fixed set of timeouts measures the wrong number some of the time (it
// read 174px for a 193px deck, tucking the credit under it).
function _bindDeckResize() {
  const ctrl = document.getElementById('map-controls');
  if (!ctrl || ctrl._deckRO || typeof ResizeObserver === 'undefined') return;
  ctrl._deckRO = new ResizeObserver(() => _syncDeckHeight());
  ctrl._deckRO.observe(ctrl);
}

// Fallback for engines without ResizeObserver, and for the fullscreen toggle,
// where the deck is hidden outright rather than resized.
function _syncDeckHeightSoon() {
  _syncDeckHeight();
  for (const t of [60, 160, 320]) setTimeout(_syncDeckHeight, t);
}

// The deck has three heights: condensed (handle + playback scrubber + More),
// full tier 1, and tier 1 + the tier-2 sheet.
//
// Opening the Map screen starts condensed. The deck's full tier 1 — product
// tabs, the product hint, the intensity legend, the scrubber and loop length —
// took roughly 40% of a phone screen before you had touched anything, on the
// one screen where the whole point is seeing as much map as possible. The
// scrubber stays visible because the animation is the reason to be here; one
// tap on "Tools" brings the rest back.
// The button names what the next tap DOES, not what is behind it. It used to
// read "More" while the sheet was open, which says "there is more to see" at
// exactly the moment there is not — the chevron was the only thing admitting
// the tap would collapse it. aria-expanded carries the same state for
// VoiceOver, which the label change alone never did.
function _setDeckBtnLabel(ctrl, open) {
  const txt = ctrl.querySelector('.deck-more-txt');
  if (txt) txt.textContent = open ? 'Close' : 'Tools';
  const btn = ctrl.querySelector('.deck-more-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Hide map tools' : 'Show map tools');
  }
}

function setDeckCondensed(on) {
  const ctrl = document.getElementById('map-controls');
  if (!ctrl) return;
  ctrl.classList.toggle('deck-mini', !!on);
  if (on) ctrl.classList.remove('sheet-open');
  _setDeckBtnLabel(ctrl, !on && ctrl.classList.contains('sheet-open'));
  setTimeout(() => lmap?.invalidateSize(), 300);
  _syncDeckHeightSoon();
}

// Bottom-sheet toggle for the fine-tuning controls (tier 2). From the condensed
// state this expands the whole deck, so one tap on "Tools" always gets you
// everything rather than stopping half-way.
function toggleMapSheet() {
  // Ignore the synthetic click that trails a drag so the deck doesn't
  // immediately flip back.
  if (Date.now() - _sheetSwipeAt < 400) return;
  const ctrl = document.getElementById('map-controls');
  if (!ctrl) return;
  // Closing goes all the way back to the state the map opens in. One button,
  // two states.
  if (ctrl.classList.contains('sheet-open')) { setDeckCondensed(true); return; }
  _openMapSheet();
}

// From any closed state straight to everything — shared by the button and
// the pull-up gesture.
function _openMapSheet() {
  const ctrl = document.getElementById('map-controls');
  if (!ctrl) return;
  ctrl.classList.remove('deck-mini');
  ctrl.classList.add('sheet-open');
  _setDeckBtnLabel(ctrl, true);
  // Trigger a Leaflet resize after the transition so tile seams don't show
  // if the sheet was covering part of the map.
  setTimeout(() => lmap?.invalidateSize(), 300);
  _syncDeckHeightSoon();
}

// A refresh asks the source what the newest scan times are and folds them into
// the loop the user is already watching: frames whose scan time is unchanged
// keep their layer and their downloaded tiles, only genuinely new imagery is
// fetched, and the oldest frames age out. It deliberately does NOT go through
// applyBase() any more — satellite used to, which tore down and rebuilt the
// whole map (base tiles included) to pick up one new frame.
function refreshMap() {
  reloadFrames();
  fetchAlerts();
  if (mapTropicalOn) drawTropical(true);   // true: skip the 10-min NHC cache
  if (mapWinterOn) drawWinterMap(true);
}

// Manual refresh button (top-left, next to fullscreen toggle). Spins the
// icon briefly so the tap registers even though refreshMap() itself doesn't
// return a promise we can await.
function refreshMapBtn(btn) {
  if (!btn || btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  refreshMap();
  setTimeout(() => btn.classList.remove('spinning'), 700);
}

// ── Pull-to-refresh ──────────────────────────────────────────────────────────
// Replaces the old REFRESH header button. Activates when the user starts a
// touch on the header / status strip / search row (NOT the leaflet map, which
// owns its own drag gestures) and drags down. Crossing the threshold and
// releasing fires refreshMap(); short pulls snap back.
//
// The gesture itself is addPullToRefresh() in app.js — the same implementation
// the other five screens use. This file only supplies the two things that are
// genuinely map-specific: the element to bind to (the whole screen, because
// there is no scroller here) and the predicate below. It used to carry a
// near-identical copy of the whole gesture, which had already drifted — its
// timings were hardcoded while app.js's read TIMINGS.

function _pullAllowed(target) {
  // Don't capture touches that started inside the leaflet map or its controls,
  // or inside form fields. Allowed zones are the chrome above the map.
  if (!target) return false;
  if (target.closest('#map-wrap')) return false;
  if (target.closest('input, textarea, button, .map-fs-btn')) return false;
  return !!target.closest('#s-map');
}

// #31: invoked from boot() in app.js rather than as a script-load IIFE so it
// can't fire before the DOM tree is built, regardless of script ordering.
function bindMapPullGestures() {
  if (typeof addPullToRefresh !== 'function') return;
  addPullToRefresh({
    target: document.getElementById('s-map'),
    // Static markup in index.html, unlike the five generated ones.
    indicator: document.getElementById('map-pull'),
    canPull: e => _pullAllowed(e.target),
    onRefresh: refreshMap,
  });
}
