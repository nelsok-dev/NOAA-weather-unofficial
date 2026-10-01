// ── Tropical: NHC hurricanes and tropical storms ─────────────────────────────
//
// Active storms from the National Hurricane Center (Atlantic, East and Central
// Pacific), drawn on the map and listed in Storm Center:
//   * forecast cone, forecast track and forecast points (5 days)
//   * past track
//   * coastal watches and warnings
//   * the 7-day Tropical Weather Outlook areas, so there is something to show
//     between storms
//
// Source: NOAA's NHC_tropical_weather_summary map service, which folds every
// active storm in every basin into one layer per product — a handful of
// requests covers everything, where the per-storm service needs one per slot
// (AT1–AT5, EP1–EP5, CP1–CP5). Queried as GeoJSON and drawn as vectors, NOT
// image frames: see the WKWebView frame-count limit in CLAUDE.md, which this
// stays well clear of.
//
// Advisories come every 6 hours (3 when a watch or warning is up), so a
// 10-minute cache is plenty; the map's refresh button bypasses it.

const TROP_BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const TROP_TTL_MS = 10 * 60 * 1000;
// Layer ids in the summary service (verified against its layer list 2026-09-23).
const TROP_LAYERS = {
  points: 5, track: 6, cone: 7, ww: 8, pastPoints: 10, pastTrack: 11,
  outlook7: 3,   // Seven-Day: Potential Development Region (polygons)
};
// Cones come back as ~1,500-vertex rings. Generalising to ~0.02° (~2 km) cuts
// the payload several-fold with no visible change at the zooms a cone is read at.
const TROP_SIMPLIFY_DEG = 0.02;
// NHC's "no value" sentinel for pressure/motion on forecast (tau > 0) points.
const TROP_MISSING = 9999;

let _tropCache = null;          // { at, data }
let _tropInflight = null;
let tropicalMapLayer = null;
let _tropDrawGen = 0;

function _tropUrl(layer, extra = '') {
  return `${TROP_BASE}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson${extra}`;
}

async function _tropGet(layer, extra) {
  const res = await fetch(_tropUrl(layer, extra));
  if (!res.ok) throw new Error('NHC ' + layer + ' HTTP ' + res.status);
  const gj = await res.json();
  if (gj.error) throw new Error('NHC ' + layer + ': ' + (gj.error.message || 'error'));
  return gj.features || [];
}

// Every product at once. One failed layer should not blank the rest (a cone
// with no points is still a cone), so each is settled on its own and only an
// all-failed fetch counts as an error.
async function tropFetch(force) {
  if (!force && _tropCache && Date.now() - _tropCache.at < TROP_TTL_MS) return _tropCache.data;
  if (_tropInflight) return _tropInflight;
  _tropInflight = (async () => {
    const keys = Object.keys(TROP_LAYERS);
    const simplify = `&maxAllowableOffset=${TROP_SIMPLIFY_DEG}`;
    const results = await Promise.allSettled(keys.map(k =>
      _tropGet(TROP_LAYERS[k], (k === 'cone' || k === 'outlook7') ? simplify : '')));
    if (results.every(r => r.status === 'rejected')) throw results[0].reason;
    const raw = {};
    keys.forEach((k, i) => {
      raw[k] = results[i].status === 'fulfilled' ? results[i].value : [];
      if (results[i].status === 'rejected') _warn('tropFetch/' + k, results[i].reason);
    });
    const data = { ...raw, storms: _tropStorms(raw.points) };
    _tropCache = { at: Date.now(), data };
    return data;
  })();
  try { return await _tropInflight; } finally { _tropInflight = null; }
}

// One entry per active storm, built from its forecast points. tau is the
// forecast hour: 0 is the current advisory position, then 12, 24 … 120.
function _tropStorms(points) {
  const by = new Map();
  for (const f of points) {
    const p = f.properties || {};
    const key = (p.basin || '') + (p.stormnum ?? '') + '|' + (p.stormname || '');
    if (!by.has(key)) by.set(key, []);
    const [lon, lat] = f.geometry?.coordinates || [];
    by.get(key).push({ ...p, lat, lon });
  }
  const storms = [];
  for (const pts of by.values()) {
    pts.sort((a, b) => (a.tau ?? 0) - (b.tau ?? 0));
    const now = pts[0];
    storms.push({
      name: now.stormname || 'Tropical cyclone',
      basin: _tropBasinAt(now.basin, now.lon), advisnum: now.advisnum, advdate: now.advdate,
      now, forecast: pts,
    });
  }
  // Strongest first — the one people are most likely looking for.
  storms.sort((a, b) => (b.now.maxwind || 0) - (a.now.maxwind || 0));
  return storms;
}

// ── Wording and colour ───────────────────────────────────────────────────────

const KT_TO_MPH = 1.15078;
const _mph = (kt) => Math.round(kt * KT_TO_MPH);
const _present = (v) => v != null && v !== TROP_MISSING && !Number.isNaN(v);

// Saffir-Simpson category where there is one, otherwise NHC's classification.
function tropClassLabel(p) {
  const ss = p.ssnum || 0;
  if (ss >= 1) return `Category ${ss} hurricane${ss >= 3 ? ' (major)' : ''}`;
  return ({
    TD: 'Tropical depression', TS: 'Tropical storm', HU: 'Hurricane', MH: 'Major hurricane',
    STD: 'Subtropical depression', SD: 'Subtropical depression', STS: 'Subtropical storm', SS: 'Subtropical storm',
    PTC: 'Potential tropical cyclone', PT: 'Post-tropical cyclone', DB: 'Disturbance', LO: 'Low',
  })[p.stormtype] || 'Tropical cyclone';
}

// The widely used Saffir-Simpson colour ramp, keyed on category — or on wind
// for anything below hurricane strength.
function tropColor(p) {
  const ss = p.ssnum || 0;
  if (ss >= 5) return '#ff6060';
  if (ss === 4) return '#ff8f20';
  if (ss === 3) return '#ffc140';
  if (ss === 2) return '#ffe775';
  if (ss === 1) return '#ffffcc';
  return (p.maxwind || 0) >= 34 ? '#00faf4' : '#5ebaff';
}

const _TROP_COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function _tropMotion(p) {
  if (!_present(p.tcdir) || !_present(p.tcspd)) return '';
  if (p.tcspd === 0) return 'Stationary';
  return `Moving ${_TROP_COMPASS[Math.round(p.tcdir / 22.5) % 16]} at ${p.tcspd} kt (${_mph(p.tcspd)} mph)`;
}

// NHC basin codes as people say them. The outlook layer already spells its
// basins out ("Atlantic"), so anything unknown passes through unchanged.
function _tropBasin(b) {
  return ({ AL: 'Atlantic', AT: 'Atlantic', EP: 'Eastern Pacific', CP: 'Central Pacific' })[String(b || '').toUpperCase()] || b || '';
}

// A storm keeps the basin code it was born with: Hurricane Nolo (2026) formed
// east of 140°W as "EP" and kept it after crossing into the Central Pacific,
// where CPHC in Honolulu issues its advisories. Labelled by where it IS, since
// "Eastern Pacific" on a storm threatening Hawaii reads as a mistake.
function _tropBasinAt(code, lon) {
  return String(code || '').toUpperCase() === 'EP' && Number.isFinite(lon) && lon < -140 ? 'CP' : code;
}

// Watch/warning line codes → the NWS event names the app already colours.
const TROP_WW = { HWR: 'Hurricane Warning', HWA: 'Hurricane Watch', TWR: 'Tropical Storm Warning', TWA: 'Tropical Storm Watch' };
const TROP_RISK_COLOR = { Low: '#ffd23f', Medium: '#ff8c1a', High: '#ff3b3b' };

// ── Map ──────────────────────────────────────────────────────────────────────
//
// Three panes, so the layer never gets between the user and an NWS alert:
//   tropArea (380) — cones and outlook areas, UNDER the alert polygons (400),
//                    so tapping a coastal warning still opens the warning
//   tropLine (390) — tracks and coastal watch/warning lines, also under alerts
//   tropPts  (620) — the storm markers, above everything so they stay tappable

function _tropPanes() {
  if (!lmap || lmap.getPane('tropArea')) return;
  [['tropArea', 380], ['tropLine', 390], ['tropPts', 620]].forEach(([name, z]) => {
    lmap.createPane(name).style.zIndex = z;
  });
}

function clearTropical() {
  _tropDrawGen++;
  if (tropicalMapLayer && lmap) lmap.removeLayer(tropicalMapLayer);
  tropicalMapLayer = null;
}

async function drawTropical(force) {
  if (!lmap || !mapTropicalOn) return;
  const gen = ++_tropDrawGen;
  let data;
  try { data = await tropFetch(force); }
  catch (e) { _warn('drawTropical', e); return; }
  // Superseded by a newer draw, the off-toggle, or a map that went away.
  if (gen !== _tropDrawGen || !mapTropicalOn || !lmap) return;

  _tropPanes();
  const group = L.layerGroup();

  // 7-day outlook areas: where NHC is watching for development.
  for (const f of data.outlook7) {
    const p = f.properties || {};
    const col = TROP_RISK_COLOR[p.risk7day] || TROP_RISK_COLOR.Low;
    L.geoJSON(f, {
      pane: 'tropArea',
      style: { color: col, weight: 2, dashArray: '6 5', fillColor: col, fillOpacity: 0.16 },
      onEachFeature: (_, layer) => layer.on('click', e => _tropOpenOutlookPopup(e.latlng, p)),
    }).addTo(group);
  }
  // Forecast cones. Not interactive: a cone covers a lot of coastline and must
  // not swallow taps meant for the alerts or storm markers beneath/above it.
  for (const f of data.cone) {
    L.geoJSON(f, {
      pane: 'tropArea', interactive: false,
      style: { color: '#1b2a41', weight: 1.5, fillColor: '#ffffff', fillOpacity: 0.28 },
    }).addTo(group);
  }
  for (const f of data.ww) {
    const ev = TROP_WW[f.properties?.tcww];
    if (!ev) continue;
    L.geoJSON(f, {
      pane: 'tropLine', interactive: false,
      style: { color: nwsEventColor(ev), weight: 6, opacity: 0.95, lineCap: 'round' },
    }).addTo(group);
  }
  // Past track as a halo: a dark casing under a light line, because a single
  // colour disappears on one base or the other — dark gray vanished into the
  // night side of GOES satellite, light gray into the OpenStreetMap tiles.
  for (const f of data.pastTrack) {
    L.geoJSON(f, { pane: 'tropLine', interactive: false, style: { color: '#0b1220', weight: 4.5, opacity: 0.55 } }).addTo(group);
    L.geoJSON(f, { pane: 'tropLine', interactive: false, style: { color: '#dfe7f1', weight: 2, opacity: 0.95 } }).addTo(group);
  }
  for (const f of data.track) {
    L.geoJSON(f, { pane: 'tropLine', interactive: false, style: { color: '#10151f', weight: 2.5, dashArray: '7 6', opacity: 0.95 } }).addTo(group);
  }

  // Past positions: small dots, coloured by the intensity they had then.
  for (const f of data.pastPoints) {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    if (lat == null) continue;
    L.circleMarker([lat, lon], {
      pane: 'tropPts', interactive: false, radius: 3.5,
      color: '#1b2a41', weight: 1, fillColor: tropColor({ ssnum: p.ss, maxwind: p.intensity }), fillOpacity: 1,
    }).addTo(group);
  }
  // Forecast positions; the current one is drawn larger with a ring.
  for (const s of data.storms) {
    for (const p of s.forecast) {
      if (p.lat == null) continue;
      const isNow = (p.tau ?? 0) === 0;
      L.circleMarker([p.lat, p.lon], {
        pane: 'tropPts', radius: isNow ? 10 : 6,
        color: isNow ? '#ffffff' : '#10151f', weight: isNow ? 3 : 1.5,
        fillColor: tropColor(p), fillOpacity: 1,
      }).on('click', e => _tropOpenStormPopup(e.latlng, s, p)).addTo(group);
    }
  }

  if (gen !== _tropDrawGen || !mapTropicalOn || !lmap) return;
  if (tropicalMapLayer) lmap.removeLayer(tropicalMapLayer);
  tropicalMapLayer = group.addTo(lmap);
}

function _tropPopup(latlng, html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  // Same frame and auto-pan clearance as the alert popups (see map.js).
  L.popup({
    maxWidth: 280, className: 'nws-popup', closeButton: false,
    autoPanPaddingTopLeft: L.point(12, 74), autoPanPaddingBottomRight: L.point(12, 12),
  }).setLatLng(latlng).setContent(holder.firstElementChild).openOn(lmap);
}

function _tropRow(label, value) {
  return value ? `<div class="trop-pop-row"><span class="trop-pop-k">${label}</span><span class="trop-pop-v">${value}</span></div>` : '';
}

function _tropOpenStormPopup(latlng, storm, p) {
  const col = tropColor(p);
  const isNow = (p.tau ?? 0) === 0;
  const when = isNow ? `Now · advisory ${esc(String(storm.advisnum ?? ''))}` : `Forecast for ${esc(p.datelbl || '')} (+${p.tau} h)`;
  const wind = p.maxwind ? `${p.maxwind} kt (${_mph(p.maxwind)} mph)` : '';
  const gust = _present(p.gust) && p.gust ? `${p.gust} kt (${_mph(p.gust)} mph)` : '';
  const html = `<div class="nws-pop-wrap">
    <div class="nws-pop-hdr" data-css-bg="${col}" data-css-color="#10151f">
      <button class="nws-pop-x" data-click-action="closeMapPopup" aria-label="Close">&times;</button>
      <div class="nws-pop-event">🌀 ${esc(storm.name)}</div>
      <div class="nws-pop-area">${esc(tropClassLabel(p))} · ${esc(_tropBasin(storm.basin))}</div>
    </div>
    <div class="nws-pop-body">
      <div class="nws-pop-exp">${when}</div>
      ${_tropRow('Sustained wind', wind)}
      ${_tropRow('Gusts', gust)}
      ${_tropRow('Pressure', _present(p.mslp) ? `${p.mslp} mb` : '')}
      ${_tropRow('Movement', esc(_tropMotion(p)))}
      <div class="trop-pop-src">NOAA/NWS National Hurricane Center · ${esc(storm.advdate || '')}</div>
    </div>
  </div>`;
  _tropPopup(latlng, html);
}

function _tropOpenOutlookPopup(latlng, p) {
  const col = TROP_RISK_COLOR[p.risk7day] || TROP_RISK_COLOR.Low;
  const html = `<div class="nws-pop-wrap">
    <div class="nws-pop-hdr" data-css-bg="${col}" data-css-color="#10151f">
      <button class="nws-pop-x" data-click-action="closeMapPopup" aria-label="Close">&times;</button>
      <div class="nws-pop-event">Area to watch</div>
      <div class="nws-pop-area">${esc(p.basin || '')} · NHC Tropical Weather Outlook</div>
    </div>
    <div class="nws-pop-body">
      ${_tropRow('Formation in 2 days', esc(`${p.prob2day || '—'} (${p.risk2day || '—'})`))}
      ${_tropRow('Formation in 7 days', esc(`${p.prob7day || '—'} (${p.risk7day || '—'})`))}
      <div class="trop-pop-src">Chance a tropical cyclone forms here · NOAA/NWS National Hurricane Center</div>
    </div>
  </div>`;
  _tropPopup(latlng, html);
}

function toggleMapTropical(on) {
  mapTropicalOn = !!on;
  saveMapPrefs();
  const lbl = document.getElementById('map-trop-lbl');
  if (lbl) lbl.textContent = mapTropicalOn ? 'On' : 'Off';
  if (mapTropicalOn) drawTropical();
  else clearTropical();
}

// ── Storm Center tab ─────────────────────────────────────────────────────────

function tropicalPanelHTML(data) {
  const storms = data.storms || [];
  const areas = (data.outlook7 || []).map(f => f.properties || {});

  const stormCards = storms.map(s => {
    const p = s.now;
    const col = tropColor(p);
    // Peak of the 5-day forecast: the number people actually want next.
    const peak = s.forecast.reduce((m, x) => (x.maxwind || 0) > (m.maxwind || 0) ? x : m, p);
    const peakLine = peak !== p && peak.maxwind > (p.maxwind || 0)
      ? `Forecast to peak at ${peak.maxwind} kt (${_mph(peak.maxwind)} mph) · ${esc(peak.datelbl || '')}` : '';
    return `<div class="card trop-card">
      <div class="trop-head">
        <span class="trop-dot" data-css-bg="${col}"></span>
        <div class="trop-head-txt">
          <div class="trop-name">${esc(s.name)}</div>
          <div class="trop-class">${esc(tropClassLabel(p))} · ${esc(_tropBasin(s.basin))}</div>
        </div>
      </div>
      <div class="trop-stats">
        ${_tropRow('Sustained wind', p.maxwind ? `${p.maxwind} kt (${_mph(p.maxwind)} mph)` : '')}
        ${_tropRow('Gusts', _present(p.gust) && p.gust ? `${p.gust} kt (${_mph(p.gust)} mph)` : '')}
        ${_tropRow('Pressure', _present(p.mslp) ? `${p.mslp} mb` : '')}
        ${_tropRow('Movement', esc(_tropMotion(p)))}
      </div>
      ${peakLine ? `<div class="trop-peak">${peakLine}</div>` : ''}
      <button class="afd-expand-btn" data-click-action="tropShowOnMap" data-lat="${p.lat}" data-lon="${p.lon}">Show on map ›</button>
      <div class="spc-meta"><span class="ldot"></span>NHC advisory ${esc(String(s.advisnum ?? ''))} · ${esc(s.advdate || '')}</div>
    </div>`;
  }).join('');

  const areaRows = areas.map(a => {
    const col = TROP_RISK_COLOR[a.risk7day] || TROP_RISK_COLOR.Low;
    return `<div class="trop-area-row">
      <span class="trop-dot" data-css-bg="${col}"></span>
      <span class="trop-area-txt">${esc(a.basin || 'Area')}: ${esc(a.prob2day || '—')} in 2 days · <b>${esc(a.prob7day || '—')} in 7 days</b> (${esc(a.risk7day || '—')})</span>
    </div>`;
  }).join('');

  return `
    ${storms.length ? stormCards : `<div class="card spc-empty"><div class="spc-empty-txt">No active tropical cyclones in the Atlantic or Pacific right now.</div></div>`}
    <div class="card spc-card">
      <div class="clbl">TROPICAL WEATHER OUTLOOK<span class="spc-clbl-tag">7 DAY</span></div>
      ${areaRows || '<div class="trop-area-row"><span class="trop-area-txt">NHC is not watching any areas for development.</span></div>'}
      ${areas.length ? `<button class="afd-expand-btn" data-click-action="tropShowOnMap">Show on map ›</button>` : ''}
      <div class="spc-meta"><span class="ldot"></span>NOAA/NWS National Hurricane Center</div>
    </div>`;
}

// ── Actions ──────────────────────────────────────────────────────────────────

registerActions({
  toggleMapTropical: (el) => toggleMapTropical(el.checked),
  // Straight to the storm on the map, with the layer switched on — turning it
  // on here is the point: someone tapping "Show on map" wants to see it.
  tropShowOnMap: (el) => {
    const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
    if (!mapTropicalOn) {
      mapTropicalOn = true;
      saveMapPrefs();
      const tog = document.getElementById('map-trop-tog');
      if (tog) tog.checked = true;
      const lbl = document.getElementById('map-trop-lbl');
      if (lbl) lbl.textContent = 'On';
    }
    goNav('s-map');
    // After goNav's own initMap() has re-centred on the user's location.
    setTimeout(() => {
      if (!lmap) return;
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) lmap.setView([lat, lon], 5);
      else lmap.setView([22, -80], 3);   // outlook areas: open on the basins
      drawTropical();
    }, 350);
  },
});
