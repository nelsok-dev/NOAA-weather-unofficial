// ── Winter: snow, ice and winter storm severity ──────────────────────────────
//
// What the app already had (24-hour snowfall/ice, snow level, precip type on
// radar, winter alerts) answers "what is happening today". This answers "what
// is coming, and how bad":
//   * snowfall and ice for each of the next 7 days, from the NWS forecast grid
//     the app already downloads (getGridpointDataCached — no new request)
//   * WPC's odds of at least 4", 8" or 12" of snow, or 0.25" of ice, Days 1–3
//   * WPC's Winter Storm Severity Index (WSSI), Days 1–3: impact level
//     (Winter Weather Area → Minor → Moderate → Major → Extreme) and which
//     hazard drives it (snow amount, snow load, ice, blowing snow)
//   * a map overlay of the WSSI footprint, coloured like NWS's own graphics
//
// Shown as a card on the Weather screen only when there is something to say,
// and in full on Storm Center's Winter tab.
//
// Sources: NOAA's map service (mapservices.weather.noaa.gov), which sends CORS
// headers. The location lookups use ArcGIS "identify" — every layer of a
// service checked in ONE request, where per-layer queries would take twenty.
// The query point is the location rounded to 0.01° (~1 km).
//
// Deliberately NOT here yet: snow on the ground (NOHRSC snow depth). Its map
// service does not state its units, and after the 6x accumulation bug a number
// of unknown scale is not going on screen. Revisit with a known reference
// reading during real snowpack.

const WINTER_BASE = 'https://mapservices.weather.noaa.gov/vector/rest/services';
const WINTER_TTL_MS = 30 * 60 * 1000;
// WSSI layers (verified against the service's layer list 2026-09-23).
const WSSI_LAYERS = {
  1: { day: 1 }, 2: { day: 2 }, 3: { day: 3 }, 4: { day: '1-3' },
  9:  { comp: 'Snow amount' }, 14: { comp: 'Snow load' },
  19: { comp: 'Ice' },         27: { comp: 'Blowing snow' },
};
// WPC probability layers: day → [4" snow, 8" snow, 12" snow, 0.25" ice].
const WPC_PROB_LAYERS = { 1: [1, 2, 3, 4], 2: [6, 7, 8, 9], 3: [11, 12, 13, 14] };
const WPC_THRESH = ['4"+ snow', '8"+ snow', '12"+ snow', '0.25"+ ice'];

// Impact scale, lowest first, with the colours from the service's own renderer
// so the map matches the graphics NWS offices post.
const WSSI_LEVELS = [
  { key: 'WINTER WEATHER AREA', label: 'Winter weather area', color: '#d2dfe7' },
  { key: 'MINOR',    label: 'Minor impacts',    color: '#faf5a3' },
  { key: 'MODERATE', label: 'Moderate impacts', color: '#f7962f' },
  { key: 'MAJOR',    label: 'Major impacts',    color: '#e61f26' },
  { key: 'EXTREME',  label: 'Extreme impacts',  color: '#7853a1' },
];
const _wssiRank = (k) => WSSI_LEVELS.findIndex(l => l.key === String(k || '').toUpperCase());
const _wssiLevel = (rank) => rank >= 0 ? WSSI_LEVELS[rank] : null;

// WPC bands. The service also carries a background "Less than 10 percent"
// polygon — a point inside it is NOT a risk, and a naive "am I in a polygon"
// check would say it is.
const WPC_BANDS = [
  { match: /^slight/i,   label: '10–39%', rank: 1 },
  { match: /^moderate/i, label: '40–69%', rank: 2 },
  { match: /^high/i,     label: '70%+',   rank: 3 },
];
function _wpcBand(outlook) {
  const b = WPC_BANDS.find(x => x.match.test(String(outlook || '')));
  return b || null;
}

let _winterCache = null;          // { key, at, data }

async function _identify(service, layers, lat, lon) {
  const d = 0.5;
  const url = `${WINTER_BASE}/${service}/MapServer/identify?geometry=${lon},${lat}`
    + `&geometryType=esriGeometryPoint&sr=4326&layers=all:${layers.join(',')}&tolerance=0`
    + `&mapExtent=${lon - d},${lat - d},${lon + d},${lat + d}&imageDisplay=400,400,96`
    + '&returnGeometry=false&f=json';
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('winter identify HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('winter identify: ' + (j.error.message || 'error'));
  return j.results || [];
}

// Next 7 local days of snowfall and ice (inches), from per-hour shares
// (expandAccumSeries), so a day's total is just the sum of its hours.
//
// WHOLE local days — today plus the next six — not "now + 168 hours". A
// rolling 168-hour window cuts the seventh day off partway through and shows a
// fraction of its total as if it were the day's total: verified 2026-09-23 at
// Mount Rainier, where it read 0.17" for a day forecast at 1.17".
function winterDayTotals(grid, tz) {
  const dayKey = (t) => { try { return t.toLocaleDateString('en-CA', { timeZone: tz }); } catch (_) { return t.toISOString().slice(0, 10); } };
  const now = Date.now();
  const keep = new Set();
  for (let i = 0; i < 7; i++) keep.add(dayKey(new Date(now + i * 864e5)));
  const days = new Map();
  const add = (series, field) => {
    for (const { time, value } of (series || [])) {
      const t = time.getTime();
      if (t < now - 3600000 || !value) continue;
      const k = dayKey(time);
      if (!keep.has(k)) continue;
      if (!days.has(k)) days.set(k, { date: k, t, snow: 0, ice: 0 });
      days.get(k)[field] += value / UNIT.MM_PER_IN;
    }
  };
  add(grid?.snowfall, 'snow');
  add(grid?.iceAccum, 'ice');
  return [...days.values()].sort((a, b) => a.t - b.t);
}

async function winterFetch(loc, force) {
  const lat = +(+loc.lat).toFixed(2), lon = +(+loc.lon).toFixed(2);
  const key = lat + ',' + lon;
  if (!force && _winterCache?.key === key && Date.now() - _winterCache.at < WINTER_TTL_MS) return _winterCache.data;

  const [grid, wssiHits, probHits] = await Promise.all([
    getGridpointDataCached().catch(() => null),
    _identify('outlooks/wpc_wssi', Object.keys(WSSI_LAYERS), lat, lon).catch(e => { _warn('wssi', e); return null; }),
    _identify('precip/wpc_prob_winter_precip', Object.values(WPC_PROB_LAYERS).flat(), lat, lon).catch(e => { _warn('wpcProb', e); return null; }),
  ]);

  // WSSI bands are nested — a point in the Moderate area is also inside the
  // Minor and Winter Weather Area rings around it — so take the highest.
  const wssi = { days: {}, comps: [] };
  for (const h of (wssiHits || [])) {
    const spec = WSSI_LAYERS[h.layerId];
    const rank = _wssiRank(h.attributes?.Impact);
    if (!spec || rank < 0) continue;
    if (spec.day != null) {
      const cur = wssi.days[spec.day];
      if (!cur || rank > cur.rank) wssi.days[spec.day] = { rank, valid: h.attributes['Valid Time'] || '' };
    } else {
      const cur = wssi.comps.find(c => c.comp === spec.comp);
      if (!cur) wssi.comps.push({ comp: spec.comp, rank });
      else if (rank > cur.rank) cur.rank = rank;
    }
  }
  wssi.comps.sort((a, b) => b.rank - a.rank);

  const probs = [];   // { day, what, band }
  for (const h of (probHits || [])) {
    const band = _wpcBand(h.attributes?.['Outlook Category'] ?? h.attributes?.outlook);
    if (!band) continue;
    for (const [day, ids] of Object.entries(WPC_PROB_LAYERS)) {
      const i = ids.indexOf(h.layerId);
      if (i < 0) continue;
      const cur = probs.find(p => p.day === +day && p.i === i);
      if (!cur) probs.push({ day: +day, i, what: WPC_THRESH[i], band });
      else if (band.rank > cur.band.rank) cur.band = band;
    }
  }
  probs.sort((a, b) => a.day - b.day || a.i - b.i);

  const tz = typeof _locTZ === 'function' ? _locTZ() : undefined;
  const days = grid ? winterDayTotals(grid, tz) : [];
  const data = {
    days, probs, wssi,
    snowTotal: days.reduce((a, d) => a + d.snow, 0),
    iceTotal: days.reduce((a, d) => a + d.ice, 0),
    failed: !grid && !wssiHits && !probHits,
  };
  _winterCache = { key, at: Date.now(), data };
  return data;
}

// Worth interrupting the Weather screen for? A trace of snow a week out is not.
function winterHasNews(d) {
  if (!d) return false;
  const overall = d.wssi.days['1-3'];
  return (overall && overall.rank >= 0) || d.probs.length > 0 || d.snowTotal >= 0.1 || d.iceTotal > 0;
}

const _inches = (x) => x >= 0.05 ? x.toFixed(1) + '"' : 'Trace';
function _dayName(isoDate, tz) {
  const d = new Date(isoDate + 'T12:00:00');
  try { return d.toLocaleDateString([], { weekday: 'short', timeZone: tz }); } catch (_) { return d.toLocaleDateString([], { weekday: 'short' }); }
}
// Day 1/2/3 as WPC means them (12Z to 12Z), named by the day they mostly cover
// — at the location, not on the phone (_locWeekday), so a location in another
// timezone isn't a day off around midnight.
function _wpcDayName(n) {
  const d = new Date(Date.now() + (n - 1) * 864e5);
  return typeof _locWeekday === 'function' ? _locWeekday(d) : d.toLocaleDateString([], { weekday: 'short' });
}

// ── Weather screen card ──────────────────────────────────────────────────────

function _wssiBadge(level) {
  return `<span class="wtr-badge" data-css-bg="${level.color}" data-css-color="#10151f">${esc(level.label)}</span>`;
}

function winterCardHTML(d) {
  const tz = typeof _locTZ === 'function' ? _locTZ() : undefined;
  const overall = _wssiLevel(d.wssi.days['1-3']?.rank ?? -1);
  const snowDays = d.days.filter(x => x.snow >= 0.05 || x.ice > 0);
  const chips = snowDays.slice(0, 7).map(x => `<span class="wtr-chip">${esc(_dayName(x.date, tz))} <b>${x.snow >= 0.05 ? _inches(x.snow) : ''}${x.ice > 0 ? `${x.snow >= 0.05 ? ' · ' : ''}${_inches(x.ice)} ice` : ''}</b></span>`).join('');
  // The single most useful WPC line: the biggest threshold with a real chance.
  const best = [...d.probs].sort((a, b) => b.i - a.i || b.band.rank - a.band.rank)[0];
  const driver = d.wssi.comps[0] && d.wssi.comps[0].rank >= 1 ? d.wssi.comps[0].comp : '';
  return `<div class="card wtr-card">
    <div class="clbl clbl-link" role="button" tabindex="0" aria-label="Winter weather — open details"
         data-click-action="winterOpen" data-keydown-action="_kbdClick">
      ❄️ WINTER WEATHER${overall ? _wssiBadge(overall) : ''}
      <span class="clbl-more">Details <span class="clbl-chev">›</span></span>
    </div>
    ${d.snowTotal >= 0.05 || d.iceTotal > 0 ? `<div class="wtr-total">${d.snowTotal >= 0.05 ? `<b>${_inches(d.snowTotal)}</b> snow` : ''}${d.iceTotal > 0 ? `${d.snowTotal >= 0.05 ? ' · ' : ''}<b>${_inches(d.iceTotal)}</b> ice` : ''} <span class="wtr-sub">next 7 days · NWS forecast</span></div>` : ''}
    ${chips ? `<div class="wtr-chips">${chips}</div>` : ''}
    ${best ? `<div class="wtr-line">WPC: <b>${esc(best.band.label)}</b> chance of ${esc(best.what)} · ${esc(_wpcDayName(best.day))}</div>` : ''}
    ${driver ? `<div class="wtr-line">Main threat: <b>${esc(driver.toLowerCase())}</b></div>` : ''}
  </div>`;
}

async function renderWinterCard() {
  const el = document.getElementById('wx-winter-card');
  if (!el || typeof activeLocation?.lat !== 'number') return;
  const myGen = typeof _locGen === 'number' ? _locGen : 0;
  let d;
  try { d = await winterFetch(activeLocation); } catch (e) { _warn('winterCard', e); return; }
  if (typeof _locGen === 'number' && _locGen !== myGen) return;
  _setInnerIfChanged(el, winterHasNews(d) ? winterCardHTML(d) : '');
}

// ── Storm Center tab ─────────────────────────────────────────────────────────

function winterPanelHTML(d) {
  const tz = typeof _locTZ === 'function' ? _locTZ() : undefined;
  const place = esc(displayName(activeLocation));
  const dayRows = d.days.filter(x => x.snow >= 0.05 || x.ice > 0).map(x => `
    <div class="trop-pop-row"><span class="trop-pop-k">${esc(_dayName(x.date, tz))} ${esc(x.date.slice(5).replace('-', '/'))}</span>
      <span class="trop-pop-v">${x.snow >= 0.05 ? _inches(x.snow) + ' snow' : ''}${x.ice > 0 ? `${x.snow >= 0.05 ? ' · ' : ''}${_inches(x.ice)} ice` : ''}</span></div>`).join('');

  const wssiRows = [1, 2, 3].map(n => {
    const lv = _wssiLevel(d.wssi.days[n]?.rank ?? -1);
    return `<div class="trop-pop-row"><span class="trop-pop-k">Day ${n} · ${esc(_wpcDayName(n))}</span>
      <span class="trop-pop-v">${lv ? _wssiBadge(lv) : 'None'}</span></div>`;
  }).join('');
  const comps = d.wssi.comps.filter(c => c.rank >= 1).map(c => `${esc(c.comp)}: ${esc(WSSI_LEVELS[c.rank].label.toLowerCase())}`).join(' · ');

  const probRows = [1, 2, 3].map(n => {
    const ps = d.probs.filter(p => p.day === n);
    return `<div class="trop-pop-row"><span class="trop-pop-k">Day ${n} · ${esc(_wpcDayName(n))}</span>
      <span class="trop-pop-v">${ps.length ? ps.map(p => `${esc(p.what)} <b>${esc(p.band.label)}</b>`).join('<br>') : 'Under 10%'}</span></div>`;
  }).join('');

  const quiet = !winterHasNews(d);
  return `
    ${quiet ? `<div class="card spc-empty"><div class="spc-empty-txt">No snow, ice or winter storm impacts in the forecast for ${place}.</div></div>` : ''}
    ${dayRows ? `<div class="card spc-card"><div class="clbl">SNOW &amp; ICE · NEXT 7 DAYS<span class="spc-clbl-tag">NWS</span></div>${dayRows}
      <div class="spc-meta"><span class="ldot"></span>NWS forecast grid for ${place}</div></div>` : ''}
    <div class="card spc-card">
      <div class="clbl">WINTER STORM SEVERITY<span class="spc-clbl-tag">WPC</span></div>
      ${wssiRows}
      ${comps ? `<div class="trop-peak">${comps}</div>` : ''}
      <p class="cpc-note">WPC's Winter Storm Severity Index rates the expected impact on travel, trees and power lines.</p>
      <button class="afd-expand-btn" data-click-action="winterShowOnMap">Show on map ›</button>
      <div class="spc-meta"><span class="ldot"></span>NOAA/NWS Weather Prediction Center</div>
    </div>
    <div class="card spc-card">
      <div class="clbl">ODDS OF A BIG ONE<span class="spc-clbl-tag">WPC</span></div>
      ${probRows}
      <div class="spc-meta"><span class="ldot"></span>NOAA/NWS Weather Prediction Center probabilities</div>
    </div>`;
}

// ── Map overlay: WSSI Days 1–3 ───────────────────────────────────────────────

let winterMapLayer = null;
let _winterMapCache = null;       // { at, features }
let _winterDrawGen = 0;

async function _wssiFeatures(force) {
  if (!force && _winterMapCache && Date.now() - _winterMapCache.at < WINTER_TTL_MS) return _winterMapCache.features;
  const url = `${WINTER_BASE}/outlooks/wpc_wssi/MapServer/4/query?where=1%3D1&outFields=impact,valid_time`
    + '&outSR=4326&maxAllowableOffset=0.02&f=geojson';
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('wssi map HTTP ' + r.status);
  const gj = await r.json();
  const features = (gj.features || []).filter(f => _wssiRank(f.properties?.impact) >= 0)
    // Lowest first, so the worst impact paints on top where rings nest.
    .sort((a, b) => _wssiRank(a.properties.impact) - _wssiRank(b.properties.impact));
  _winterMapCache = { at: Date.now(), features };
  return features;
}

function clearWinterMap() {
  _winterDrawGen++;
  if (winterMapLayer && lmap) lmap.removeLayer(winterMapLayer);
  winterMapLayer = null;
}

async function drawWinterMap(force) {
  if (!lmap || !mapWinterOn) return;
  const gen = ++_winterDrawGen;
  let features;
  try { features = await _wssiFeatures(force); } catch (e) { _warn('drawWinterMap', e); return; }
  if (gen !== _winterDrawGen || !mapWinterOn || !lmap) return;
  // Under the NWS alert polygons (400) and the hurricane cones (380), so taps on
  // either still land on them.
  if (!lmap.getPane('winterArea')) lmap.createPane('winterArea').style.zIndex = 375;
  const group = L.layerGroup();
  for (const f of features) {
    const lv = _wssiLevel(_wssiRank(f.properties.impact));
    L.geoJSON(f, {
      pane: 'winterArea',
      style: { color: lv.color, weight: 1.5, fillColor: lv.color, fillOpacity: 0.35 },
      onEachFeature: (_, layer) => layer.on('click', e => _winterPopup(e.latlng, lv, f.properties.valid_time)),
    }).addTo(group);
  }
  if (gen !== _winterDrawGen || !mapWinterOn || !lmap) return;
  if (winterMapLayer) lmap.removeLayer(winterMapLayer);
  winterMapLayer = group.addTo(lmap);
}

function _winterPopup(latlng, lv, valid) {
  const holder = document.createElement('div');
  holder.innerHTML = `<div class="nws-pop-wrap">
    <div class="nws-pop-hdr" data-css-bg="${lv.color}" data-css-color="#10151f">
      <button class="nws-pop-x" data-click-action="closeMapPopup" aria-label="Close">&times;</button>
      <div class="nws-pop-event">❄️ ${esc(lv.label)}</div>
      <div class="nws-pop-area">Winter Storm Severity Index · Days 1–3</div>
    </div>
    <div class="nws-pop-body">
      <div class="nws-pop-exp">${esc(valid || '')}</div>
      <div class="trop-pop-src">Expected impacts on travel, trees and power lines · NOAA/NWS Weather Prediction Center</div>
    </div>
  </div>`;
  L.popup({ maxWidth: 280, className: 'nws-popup', closeButton: false,
    autoPanPaddingTopLeft: L.point(12, 74), autoPanPaddingBottomRight: L.point(12, 12) })
    .setLatLng(latlng).setContent(holder.firstElementChild).openOn(lmap);
}

function toggleMapWinter(on) {
  mapWinterOn = !!on;
  saveMapPrefs();
  const lbl = document.getElementById('map-wtr-lbl');
  if (lbl) lbl.textContent = mapWinterOn ? 'On' : 'Off';
  if (mapWinterOn) drawWinterMap();
  else clearWinterMap();
}

registerActions({
  toggleMapWinter: (el) => toggleMapWinter(el.checked),
  winterOpen: () => { if (typeof spcOpenTab === 'function') spcOpenTab('winter'); },
  winterShowOnMap: () => {
    if (!mapWinterOn) {
      mapWinterOn = true;
      saveMapPrefs();
      const tog = document.getElementById('map-wtr-tog');
      if (tog) tog.checked = true;
      const lbl = document.getElementById('map-wtr-lbl');
      if (lbl) lbl.textContent = 'On';
    }
    goNav('s-map');
    setTimeout(() => { if (lmap) { lmap.setView([39, -98], 4); drawWinterMap(); } }, 350);
  },
});
