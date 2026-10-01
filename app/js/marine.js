// Marine & extended forecast tab

// ── Sun / Moon ────────────────────────────────────────────────────────────────

// NOAA's solar calculator (Meeus), evaluated for the location's own calendar
// date, with the standard 90.833° zenith — the half-degree of atmospheric
// refraction plus the sun's radius that define sunrise/sunset as NWS and USNO
// publish them. The approximation this replaced ignored refraction and used a
// rough declination/equation of time, putting sunrise 5–8 minutes late and
// sunset 6–10 minutes early across the lower 48 (~15 min in Alaska), checked
// against this algorithm on 2026-09-26.
function _solarEvents(lat, lon, y, m, d) {
  const rad = Math.PI / 180;
  // Julian century at the location's approximate solar noon.
  const noonUtc = Date.UTC(y, m - 1, d, 12) - (lon / 15) * 3600000;
  const T = (noonUtc / 86400000 + 2440587.5 - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const yy = Math.tan(eps / 2 * rad) ** 2;
  const eqTime = 4 / rad * (yy * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad)
    + 4 * e * yy * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
    - 0.5 * yy * yy * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const cosH = (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl))
             / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH < -1) return { polar: 'day' };
  if (cosH > 1)  return { polar: 'night' };
  const H = Math.acos(cosH) / rad;                       // degrees
  const noonMin = 720 - 4 * lon - eqTime;                // minutes after 00:00 UTC
  const base = Date.UTC(y, m - 1, d);
  return { rise: new Date(base + (noonMin - 4 * H) * 60000), set: new Date(base + (noonMin + 4 * H) * 60000) };
}

function calcSunTimes(lat, lon, tz) {
  // Today AT THE LOCATION, not on the phone.
  let y, m, d;
  try {
    [y, m, d] = new Date().toLocaleDateString('en-CA', tz ? { timeZone: tz } : {}).split('-').map(Number);
  } catch (_) {
    const n = new Date(); y = n.getFullYear(); m = n.getMonth() + 1; d = n.getDate();
  }
  const ev = _solarEvents(lat, lon, y, m, d);
  if (ev.polar === 'day')   return { rise: 'Midnight Sun', set: 'Midnight Sun' };
  if (ev.polar === 'night') return { rise: 'Polar Night',  set: 'Polar Night' };
  // Format in the LOCATION's timezone (e.g. NYC sunrise shown in EDT even when
  // the browser is in Pacific time). Falls back to browser-local if no tz known.
  const fmtOpts = { hour: 'numeric', minute: '2-digit' };
  if (tz) fmtOpts.timeZone = tz;
  const fmt = t => {
    try { return t.toLocaleTimeString([], fmtOpts); }
    catch (e) { _warn && _warn('calcSunTimes/tz', e); delete fmtOpts.timeZone; return t.toLocaleTimeString([], fmtOpts); }
  };
  return { rise: fmt(ev.rise), set: fmt(ev.set) };
}

function getMoonPhase() {
  const date = new Date();
  const ref = new Date(2000, 0, 6, 18, 14);
  const phase = ((((date - ref) / (29.53058867 * 86400000)) % 1) + 1) % 1;
  const illum = Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);
  if (phase < 0.034 || phase >= 0.966) return { name: 'New Moon',        icon: '🌑', illum };
  if (phase < 0.134)                   return { name: 'Waxing Crescent',  icon: '🌒', illum };
  if (phase < 0.216)                   return { name: 'First Quarter',    icon: '🌓', illum };
  if (phase < 0.466)                   return { name: 'Waxing Gibbous',   icon: '🌔', illum };
  if (phase < 0.534)                   return { name: 'Full Moon',        icon: '🌕', illum };
  if (phase < 0.784)                   return { name: 'Waning Gibbous',   icon: '🌖', illum };
  if (phase < 0.866)                   return { name: 'Last Quarter',     icon: '🌗', illum };
  return                                      { name: 'Waning Crescent',  icon: '🌘', illum };
}

// ── Gridpoint detailed data ───────────────────────────────────────────────────

// Parse ISO 8601 duration into whole hours. Handles the forms NWS uses:
//   PT1H, PT6H, PT12H (hours only)
//   P1D, P2D          (days only)
//   P1DT6H            (days + hours)
// The old replace(/\D/g,'') approach collapsed "P1DT6H" → "16" (wrong: 30 h).
function _parseIsoHours(dur) {
  const m = (dur || 'PT1H').match(/P(?:(\d+)D)?T?(?:(\d+)H)?/);
  if (!m) return 1;
  return (+(m[1] || 0) * 24) + (+(m[2] || 0)) || 1;
}

function expandGridSeries(values) {
  const result = [];
  for (const v of (values || [])) {
    if (v.value == null) continue;
    const [startStr, durStr] = v.validTime.split('/');
    const start = new Date(startStr);
    const hours = _parseIsoHours(durStr);
    for (let i = 0; i < hours; i++)
      result.push({ time: new Date(start.getTime() + i * 3600000), value: v.value });
  }
  return result;
}

// For ACCUMULATION fields (quantitativePrecipitation, snowfallAmount,
// iceAccumulation) NWS publishes one total per period — typically "2 inches in
// these 6 hours". expandGridSeries() copies a value into every hour of its
// period, which is right for rates and levels but wrong here: anything that
// then adds the hours up counts each period once per hour. The 24-hour snowfall
// and ice totals did exactly that and read 6x too high (verified 2026-09-23 on a
// live Tampa forecast: 0.54" shown for 0.09" forecast). Spreading each period's
// total evenly over its hours makes every sum — 24 h, a 6 h bucket, a day —
// come out right.
function expandAccumSeries(values) {
  const result = [];
  for (const v of (values || [])) {
    if (v.value == null) continue;
    const [startStr, durStr] = v.validTime.split('/');
    const start = new Date(startStr);
    const hours = _parseIsoHours(durStr);
    for (let i = 0; i < hours; i++)
      result.push({ time: new Date(start.getTime() + i * 3600000), value: v.value / hours });
  }
  return result;
}

function getGridValueAt(series, targetTime) {
  const t = targetTime.getTime();
  for (const item of series)
    if (Math.abs(item.time.getTime() - t) < 1800000) return item.value;
  return null;
}

async function fetchGridpointData() {
  const { wfo, gx, gy } = activeLocation;
  const r = await nwsFetch(`https://api.weather.gov/gridpoints/${wfo}/${gx},${gy}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const p = (await r.json()).properties;
  return {
    windGust:   expandGridSeries(p.windGust?.values),
    skyCover:   expandGridSeries(p.skyCover?.values),
    // Accumulations: per-hour shares, so they can be summed — see expandAccumSeries.
    precipAmt:  expandAccumSeries(p.quantitativePrecipitation?.values),
    snowLevel:  expandGridSeries(p.snowLevel?.values),
    // Percent chance of thunder in this grid box — read by the Storm Center's
    // outlook tab to tie SPC's regional risk to the user's own point.
    thunder:    expandGridSeries(p.probabilityOfThunder?.values),
    // Snow LEVEL is an altitude; snowfall AMOUNT is how much actually lands,
    // which is the number people want in winter. Both mm, zero out of season —
    // the cards that read them suppress themselves when everything is zero.
    snowfall:   expandAccumSeries(p.snowfallAmount?.values),
    iceAccum:   expandAccumSeries(p.iceAccumulation?.values),
    // NWS HeatRisk, 0–4. Not published by every forecast office (absent at
    // Fairbanks when this was added), so every reader must tolerate an empty
    // series rather than assuming it exists.
    heatRisk:   expandGridSeries(p.heatRisk?.values),
    // Smoke/pollution dispersion, read by the Air Quality screen. A low mixing
    // height with light transport wind is what traps pollutants near the
    // ground — it explains a bad AQI rather than just restating it.
    mixingHeight:  expandGridSeries(p.mixingHeight?.values),
    transportSpd:  expandGridSeries(p.transportWindSpeed?.values),
    transportDir:  expandGridSeries(p.transportWindDirection?.values),
    elevationFt: p.elevation?.value != null ? Math.round(p.elevation.value * 3.28084) : 0,
  };
}

// ── Marine forecast (NWS CWF) ─────────────────────────────────────────────────

async function fetchMarineForecast() {
  if (!activeLocation.wfo) throw new Error('No WFO');
  const wfo = activeLocation.wfo.toUpperCase();
  const r = await nwsFetch(`https://api.weather.gov/products/types/CWF/locations/${wfo}`);
  if (!r.ok) throw new Error('No CWF');
  const list = await r.json();
  const latest = list['@graph']?.[0];
  if (!latest) throw new Error('No CWF products');
  const prodR = await nwsFetch(latest['@id']);
  if (!prodR.ok) throw new Error('CWF fetch failed');
  const prod = await prodR.json();
  return {
    text: (prod.productText || '').trim(),
    issued: prod.issuanceTime ? new Date(prod.issuanceTime) : null
  };
}

// ── Tides (NOAA CO-OPS) ───────────────────────────────────────────────────────

// Cached station list — 3,450 tide-prediction stations with lat/lon.
// In-process cache so we hit the network at most once per session, and a
// 30-day localStorage cache so we don't even re-download the ~250 KB JSON on
// every cold start (#19). Stations are added/removed by NOAA on the order of
// months, so a 30-day TTL trades virtually nothing in freshness for a big
// improvement in first-Marine-view latency.
// N57: bump the `_v1` suffix whenever the parsed station shape changes
// (NOAA has reshuffled this endpoint's schema before). The new key
// invalidates every client's stale cache without needing a migration.
const COOPS_STATIONS_KEY    = 'noaa_coops_stations_v1';
const COOPS_STATIONS_TTL_MS = 30 * 24 * 3600 * 1000;
let _coopsStationsPromise = null;
function getCoopsStations() {
  if (_coopsStationsPromise) return _coopsStationsPromise;
  // Defer the localStorage read + JSON.parse off the main thread so the first
  // Details tab open doesn't block with a ~250 KB synchronous parse. The Promise
  // wrapper lets callers await the result exactly as before.
  _coopsStationsPromise = new Promise(resolve => {
    setTimeout(() => {
      try {
        const raw = localStorage.getItem(COOPS_STATIONS_KEY);
        if (raw) {
          const { at, stations } = JSON.parse(raw);
          if (Array.isArray(stations) && stations.length && (Date.now() - at) < COOPS_STATIONS_TTL_MS) {
            return resolve(stations);
          }
        }
      } catch (_) {}
      resolve(null); // cache miss — fall through to network fetch below
    }, 0);
  }).then(cached => {
    if (cached) return cached;
    return fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions')
      .then(r => r.ok ? r.json() : { stations: [] })
      .then(j => {
        const s = j.stations || [];
        try { localStorage.setItem(COOPS_STATIONS_KEY, JSON.stringify({ at: Date.now(), stations: s })); } catch (_) {}
        return s;
      })
      .catch(() => []);
  });
  return _coopsStationsPromise;
}

// Haversine distance now lives in app.js (haversineMi) so this file
// doesn't carry its own copy. See #33.
async function findNearestTideStation(lat, lon) {
  const stations = await getCoopsStations();
  if (!stations.length) return null;
  let best = null, bestD = Infinity;
  for (const s of stations) {
    if (s.lat == null || s.lng == null) continue;
    const d = haversineMi(lat, lon, s.lat, s.lng);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best ? { id: best.id, name: best.name, state: best.state, distMi: bestD } : null;
}

async function fetchTides() {
  const { lat, lon } = activeLocation;
  // Cache the resolved station on the location so we don't re-search every render.
  if (!activeLocation._tideStation) {
    activeLocation._tideStation = await findNearestTideStation(lat, lon);
  }
  const station = activeLocation._tideStation;
  if (!station) throw new Error('No tide station found');
  // Anything more than ~75 mi away is not meaningfully "your" tide.
  if (station.distMi != null && station.distMi > 75) {
    const err = new Error('No nearby tide station');
    err.distMi = Math.round(station.distMi);
    throw err;
  }

  const d = new Date();
  const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${fmt(d)}&range=48&station=${station.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&application=noaa_unofficial&format=json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Tide fetch failed (HTTP ' + r.status + ')');
  const json = await r.json();
  // CO-OPS returns 200 OK with either {error: {message}} (station shut down,
  // bad datum, etc.) or {predictions: []} (station valid but no predictions
  // in window). Surface the API message so the error tile can show *why*
  // instead of a generic "No tide data available." (B8)
  if (json.error?.message) throw new Error('Tide service: ' + json.error.message);
  if (!Array.isArray(json.predictions) || !json.predictions.length) {
    throw new Error('Tide service returned no predictions for ' + station.id);
  }
  return { predictions: json.predictions, station };
}

// ── Buoy / Surf (Open-Meteo Marine — NOAA WaveWatch III model) ────────────────
// NDBC realtime endpoints are all CORS-blocked from browsers, so we use
// Open-Meteo's marine API which redistributes the NOAA WaveWatch III ocean wave
// model with CORS enabled. For inland / sheltered points (e.g. Puget Sound)
// wave_height comes back null — that's accurate, and we surface it as
// "sheltered water" rather than misrepresenting an airport observation.

async function fetchBuoy() {
  const { lat, lon } = activeLocation;
  // Round to 4 dp (~11 m) before sending to the third-party marine API — full
  // precision adds nothing for an offshore wave model and keeps our "location
  // is never stored or shared" promise tight.
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&current=wave_height,wave_direction,wave_period,sea_surface_temperature` +
    `&forecast_days=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Marine fetch failed');
  const j = await r.json();
  if (j.error) throw new Error(j.reason || 'Marine API error');
  const c = j.current || {};
  return {
    source: 'open-meteo',
    station: { name: `${lat.toFixed(2)}, ${lon.toFixed(2)}` },
    wvht: c.wave_height,                                            // metres
    dpd:  c.wave_period,                                            // seconds
    wdir: c.wave_direction,                                         // degrees (from)
    wtmp: c.sea_surface_temperature,                                // Celsius
    // Surface wind isn't part of the marine endpoint — leave null and let
    // the obs tile elsewhere handle near-surface wind. Avoids re-displaying
    // the airport reading here.
    wspd: null, gst: null, atmp: null,
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

// Coastal gate. The Marine section only makes sense near tidal water, so we
// reuse the nearest-tide-station lookup (cached on the location) as the coastal
// signal: within MARINE_COASTAL_MI it's "coastal" and we surface the section;
// otherwise we hide it entirely so inland users don't get a wall of
// "not available" cards. Matches the 75-mi threshold fetchTides() already uses
// to decide a tide is meaningfully "yours".
const MARINE_COASTAL_MI = 75;

async function _nearTidalWater() {
  try {
    if (!activeLocation._tideStation) {
      activeLocation._tideStation = await findNearestTideStation(activeLocation.lat, activeLocation.lon);
    }
    const st = activeLocation._tideStation;
    return (st && st.distMi != null && st.distMi <= MARINE_COASTAL_MI) ? st : null;
  } catch (_) { return null; }
}

// Entry point from goNav(s-forecast). Decides between hidden (inland), a compact
// teaser (coastal, collapsed) or the full section (once the user taps the
// teaser — the flag persists per-location so re-entry stays expanded).
function renderMarine() {
  const body = document.getElementById('marine-body');
  if (!body) return;
  const myGen = (typeof _locGen !== 'undefined') ? _locGen : 0;
  _nearTidalWater().then(station => {
    if (typeof _locGen !== 'undefined' && _locGen !== myGen) return; // switched away mid-lookup
    const cur = document.getElementById('marine-body');
    if (!cur) return;
    if (!station) { cur.innerHTML = ''; cur._lastHtml = ''; return; }   // inland → hidden
    if (activeLocation._marineExpanded) renderMarineFull();
    else renderMarineTeaser(station);
  });
}

// Compact, tappable "Marine & Tides" entry — the affordance that lets coastal
// users discover the section without dumping every card into the Details view.
function renderMarineTeaser(station) {
  const body = document.getElementById('marine-body');
  if (!body) return;
  const dist = station.distMi != null && station.distMi >= 1
    ? `\xb7 ${Math.round(station.distMi)} mi away` : '';
  const html =
    `<div class="card marine-teaser" data-click-action="expandMarine" role="button" tabindex="0" data-keydown-action="_kbdClick" aria-label="Show marine and tides">
       <div class="marine-teaser-ico"><svg width="20" height="20" aria-hidden="true"><use href="#bnav-s-details"/></svg></div>
       <div class="marine-teaser-txt">
         <div class="marine-teaser-title">Marine &amp; Tides</div>
         <div class="marine-teaser-sub">Tides, buoy data &amp; coastal forecast ${dist}</div>
       </div>
       <span class="marine-teaser-chev">&rsaquo;</span>
     </div>`;
  _setInnerIfChanged(body, html);
}

function expandMarine() {
  activeLocation._marineExpanded = true;
  renderMarineFull();
}

// ── Detailed conditions (every location) ─────────────────────────────────────
//
// Sun & moon, hourly conditions, precipitation chance, wind gusts, cloud cover,
// snow level and precip amount. None of it is marine, but all of it used to
// live inside renderMarineFull() — which only runs within MARINE_COASTAL_MI of
// a tide station, so every inland location got an empty Details screen below
// the 7-day forecast. Snow level was the worst of it: gated on proximity to the
// ocean, when it matters most in the mountains.
//
// Rendered unconditionally now, and separately from the marine cards, so the
// coastal check only decides whether *marine* content appears.
function renderConditions() {
  const body = document.getElementById('conditions-body');
  if (!body) return;

  const sun  = calcSunTimes(activeLocation.lat, activeLocation.lon, activeLocation.timeZone);
  const moon = getMoonPhase();

  const html =
    buildSunMoonSection(sun, moon) +
    `<div id="conditions-extended">${spinCard('Loading detailed conditions…')}</div>`;

  // The section itself is only rewritten when it changed, but the detailed
  // cards are recomputed on every visit. They used to share the short-circuit:
  // the header HTML (sun and moon) is identical all day, so the 24-hour snow,
  // ice and rain totals below it stayed as first computed until the date
  // changed. Recomputing is cheap — the gridpoint comes from the shared cache.
  const changed = _setInnerIfChanged(body, html);

  const myGen = _gen();
  getGridpointDataCached().then(v => {
    if (_stale(myGen)) return;
    if (v) { renderExtended(v); return; }
    // Keep cards that are already on screen; only replace the loading state.
    if (changed || document.querySelector('#conditions-extended .spin')) {
      renderSectionError('conditions-extended', '🌡 DETAILED CONDITIONS',
        'Detailed conditions unavailable.', 'retryExtended');
    }
  });
}

function renderMarineFull() {
  const body = document.getElementById('marine-body');
  if (!body) return;

  const _marineHtml =
    `<div id="marine-text-section">${spinCard('Loading marine forecast…')}</div>` +
    `<div id="marine-tides">${spinCard('Loading tide predictions…')}</div>` +
    `<div id="marine-buoy">${spinCard('Loading buoy data…')}</div>` +
    `<div class="_s-252340">
       NOAA/NWS · CO-OPS tides · Open-Meteo Marine (NOAA WaveWatch III)
     </div>`;
  // #18: short-circuit when nothing has changed (same location, same hourly
  // data). Avoids re-firing four parallel API requests on every re-entry.
  if (!_setInnerIfChanged(body, _marineHtml)) return;

  // #12: capture the location generation. These four fetches are slow (CWF
  // product + tide-station search + buoy model), so a location switch can land
  // mid-flight; without this guard the previous location's tides/forecast would
  // render into the new location's view, since the section elements are matched
  // by fixed id. Mirrors fetchWx()/fetchAlerts().
  const myGen = (typeof _locGen !== 'undefined') ? _locGen : 0;

  Promise.allSettled([
    fetchMarineForecast(),
    fetchTides(),
    fetchBuoy()
  ]).then(([mR, tR, bR]) => {
    if (typeof _locGen !== 'undefined' && _locGen !== myGen) return; // user switched mid-flight
    if (mR.status === 'fulfilled') renderMarineText(mR.value);
    else renderSectionError('marine-text-section', '⚓ MARINE FORECAST', 'Forecast not available for this location.', 'retryMarineText');
    if (tR.status === 'fulfilled') renderTides(tR.value);
    else {
      // B8: surface CO-OPS's own error text when present (e.g. "Station 9447130
      // has no predictions for the requested time"). Falls back to the generic
      // message when the failure was network-level (no .message).
      const distMi = tR.reason?.distMi;
      const apiMsg = tR.reason?.message && /^Tide service/.test(tR.reason.message)
        ? tR.reason.message
        : null;
      const msg = distMi
        ? `The nearest tide station is ${distMi} mi away, too far to use for this location.`
        : apiMsg || 'Tide data not available for this location.';
      // Distance-based "no station" is permanent for this location — don't offer retry.
      renderSectionError('marine-tides', '🌊 TIDES', msg, distMi ? null : 'retryTides');
    }
    if (bR.status === 'fulfilled') renderBuoy(bR.value);
    else renderSectionError('marine-buoy', '🏄 SURF & SEAS', 'Buoy data unavailable.', 'retryBuoy');
  });
}

function spinCard(msg) {
  return `<div class="card"><div class="ldg _s-7de244" role="status" aria-live="polite"><div class="spin"></div><div class="_s-6cb285">${msg}</div></div></div>`;
}

// `msg` is escaped here rather than at the call sites because one path feeds it
// a third-party string: fetchTides() rethrows the CO-OPS response body as
// 'Tide service: ' + json.error.message (see fetchTides), and both the
// renderMarineFull and retryTides handlers pass that straight through. Escaping
// centrally means a future caller can't reintroduce the hole by forgetting.
// Checked at the time of writing: all nine call sites pass a plain sentence,
// none passes intentional markup.
//
// `label` and `retryBtn` are deliberately NOT escaped — both are app literals
// (the section headings carry emoji, and retryFnName is an action name from
// this file's own registerActions map).
function renderSectionError(id, label, msg, retryFnName) {
  const el = document.getElementById(id);
  if (!el) return;
  const retryBtn = retryFnName
    ? `<button class="_s-b7c069" data-click-action="${retryFnName}">Retry</button>`
    : '';
  el.innerHTML = `<div class="card"><div class="clbl">${label}</div><div class="_s-a7f2a8">${esc(msg)}</div>${retryBtn}</div>`;
  el._lastHtml = null;   // written directly: the next _setInnerIfChanged must not skip
}

// Per-section retry helpers. Each clears its own slot to the spinner state
// then calls the same fetcher that renderMarine() used originally.
// Snapshot the location generation when a retry starts; if the user switches
// location before the single-section fetch resolves, drop the result instead of
// painting the previous location's data into the new view. Matches renderMarine.
function _gen() { return (typeof _locGen !== 'undefined') ? _locGen : 0; }
function _stale(g) { return typeof _locGen !== 'undefined' && _locGen !== g; }

function retryMarineText() {
  const el = document.getElementById('marine-text-section');
  if (!el || el.querySelector('.spin')) return;
  el.innerHTML = spinCard('Loading marine forecast…');
  const g = _gen();
  fetchMarineForecast().then(v => { if (_stale(g)) return; renderMarineText(v); }).catch(() => {
    if (_stale(g)) return;
    renderSectionError('marine-text-section', '⚓ MARINE FORECAST', 'Forecast not available for this location.', 'retryMarineText');
  });
}
function retryTides() {
  const el = document.getElementById('marine-tides');
  if (!el || el.querySelector('.spin')) return;
  el.innerHTML = spinCard('Loading tide predictions…');
  const g = _gen();
  fetchTides().then(v => { if (_stale(g)) return; renderTides(v); }).catch(err => {
    if (_stale(g)) return;
    // B8: mirror the renderMarine path — surface CO-OPS's own error text.
    const apiMsg = err?.message && /^Tide service/.test(err.message) ? err.message : null;
    const msg = err?.distMi
      ? `The nearest tide station is ${err.distMi} mi away, too far to use for this location.`
      : apiMsg || 'Tide data not available for this location.';
    renderSectionError('marine-tides', '🌊 TIDES', msg, 'retryTides');
  });
}
function retryBuoy() {
  const el = document.getElementById('marine-buoy');
  if (!el || el.querySelector('.spin')) return;
  el.innerHTML = spinCard('Loading buoy data…');
  const g = _gen();
  fetchBuoy().then(v => { if (_stale(g)) return; renderBuoy(v); }).catch(() => {
    if (_stale(g)) return;
    renderSectionError('marine-buoy', '🏄 SURF & SEAS', 'Buoy data unavailable.', 'retryBuoy');
  });
}
function retryExtended() {
  const el = document.getElementById('conditions-extended');
  if (!el || el.querySelector('.spin')) return;
  el.innerHTML = spinCard('Loading extended forecast…');
  el._lastHtml = null;
  const g = _gen();
  fetchGridpointData().then(v => { if (_stale(g)) return; renderExtended(v); }).catch(() => {
    if (_stale(g)) return;
    renderSectionError('conditions-extended', '🌡 EXTENDED', 'Extended forecast unavailable.', 'retryExtended');
  });
}

// Register this module's data-click-action handlers with the app.js
// dispatcher. Without this, the Retry buttons rendered by
// renderSectionError() hit the "no handler" branch and do nothing.
registerActions({
  retryMarineText: () => retryMarineText(),
  retryTides:      () => retryTides(),
  retryBuoy:       () => retryBuoy(),
  retryExtended:   () => retryExtended(),
});

// ── Sun & Moon ────────────────────────────────────────────────────────────────

function buildSunMoonSection(sun, moon) {
  return `<div class="card">
    <div class="clbl">🌅 SUN &amp; MOON</div>
    <div class="sm-grid">
      <div class="sm-item"><div class="sm-lbl">SUNRISE</div><div class="sm-val">🌅 ${sun.rise}</div></div>
      <div class="sm-item"><div class="sm-lbl">SUNSET</div><div class="sm-val">🌇 ${sun.set}</div></div>
      <div class="sm-item"><div class="sm-lbl">MOON PHASE</div><div class="sm-val">${moon.icon} ${moon.name}</div></div>
      <div class="sm-item"><div class="sm-lbl">ILLUMINATION</div><div class="sm-val">${moon.illum}%</div></div>
    </div>
  </div>`;
}

// ── Extended gridpoint sections ───────────────────────────────────────────────

function renderExtended(data) {
  const el = document.getElementById('conditions-extended');
  if (!el) return;
  const h = wxData.hourly.slice(0, 24);
  if (!h.length) { _setInnerIfChanged(el, ''); return; }
  const times = h.map(p => new Date(p.startTime));

  // Daily-resolution and 24-hour-total content only.
  //
  // The hour-by-hour strips this used to render — wind gusts, cloud cover, snow
  // level — duplicated cards the Hourly tab already had, and in two of the three
  // cases through a *second* implementation that had already drifted from it
  // (buildGustRow/buildCloudRow gained day-break separators so the rows scroll
  // in lockstep; these inline copies never did). They now live only on Hourly.
  //
  // The split each screen keeps to: Details answers "what is the week doing",
  // Hourly answers "what are the next 24 hours doing".
  _setInnerIfChanged(el, `
    ${buildHeatRiskSection(data, times)}
    ${buildAccumTotal('❄️ SNOWFALL', data.snowfall, times, '#5AC8FA')}
    ${buildAccumTotal('🧊 ICE ACCUMULATION', data.iceAccum, times, '#C08CFF')}
    ${buildSnowLevelSection(data)}
    <div class="card"><div class="clbl">🌧 PRECIP AMOUNT &middot; NEXT 24 H</div>${buildPrecipAmtBars(h, data.precipAmt, times)}</div>`);
  // _setInnerIfChanged applies the data-css-* attributes itself, and skips the
  // write entirely when a revisit computes the same cards.
}

// Lowest snow level for each of the next 7 days, with the winter cards.
//
// It used to render on the Details screen between the NWS forecast periods and
// the long-range outlook whenever ANY day's snow level was above zero — which is
// nearly every day anywhere in the West, so Denver in September showed a strip
// of 13,000–15,000 ft levels interrupting the forecast. Now it follows the rule
// the per-period ❄️ tags already use: shown only when some day's lowest snow
// level falls below the location's elevation plus the user's snow-level offset
// (Settings), and each day shows its LOWEST level, the one that decides whether
// snow reaches you (the strip showed the highest).
function buildSnowLevelSection(data) {
  if (!data.snowLevel?.length) return '';
  const days = (wxData.forecast || []).filter(p => p.isDaytime).slice(0, 7);
  if (!days.length) return '';

  const rows = days.map(p => {
    const label = (p.name || '')
      .replace(/^This Afternoon$/i, 'Today')
      .replace(/^Afternoon$/i,      'Today')
      .replace(/^This Morning$/i,   'Today');
    const start = new Date(p.startTime).getTime();
    const end   = new Date(p.endTime).getTime();
    const vals = data.snowLevel.filter(e => {
      const t = e.time.getTime();
      return t >= start && t <= end && e.value != null;
    }).map(e => e.value);
    const ft = vals.length ? Math.round(Math.min(...vals) * 3.28084) : null;
    return { label, ft };
  });

  const threshold = (data.elevationFt || 0) + snowLevelOffset;
  if (!rows.some(r => r.ft != null && r.ft < threshold)) return '';

  const cells = rows.map(r => {
    const val   = r.ft != null ? r.ft.toLocaleString() + ' ft' : '--';
    const color = r.ft != null && r.ft < threshold ? '#5AC8FA' : 'rgba(255,255,255,.4)';
    return `<div class="hr">
      <span class="hrt">${esc(r.label)}</span>
      <span class="hrv _s-5e0faa" data-css-color="${color}">${val}</span>
    </div>`;
  }).join('');

  return `<div class="card"><div class="clbl">${clblIcon('si-snow')}SNOW LEVEL &middot; 7 DAY</div>
    <div class="hrs">${cells}</div>
  </div>`;
}

// NWS HeatRisk, 0–4. Wording follows NWS's own category descriptions — this is
// a risk scale, not a temperature, and it accounts for how unusual the heat is
// for this location and date plus how little relief the night brings, which is
// exactly what a heat index can't express.
const HEAT_RISK = [
  { label: 'Little to none', color: 'rgba(255,255,255,.55)', note: 'No heat concern for most people.' },
  { label: 'Minor',   color: '#FFD60A', note: 'Affects those unusually sensitive to heat.' },
  { label: 'Moderate',color: '#FF9F0A', note: 'Affects most heat-sensitive people, especially without cooling or hydration.' },
  { label: 'Major',   color: '#FF453A', note: 'Affects anyone without effective cooling or hydration.' },
  { label: 'Extreme', color: '#FF375F', note: 'Rare, long-lasting heat with little overnight relief. Affects everyone.' },
];

// Absent entirely at some offices, so an empty series means "render nothing",
// never an empty card. Peak over the forecast window rather than "now" — the
// useful question is how bad today gets, not what it is at this minute.
function buildHeatRiskSection(data, times) {
  if (!data.heatRisk?.length) return '';
  const vals = times.map(t => getGridValueAt(data.heatRisk, t)).filter(v => v != null);
  if (!vals.length) return '';
  const peak = Math.max(...vals);
  if (peak <= 0) return '';              // no meaningful heat risk today
  const cat = HEAT_RISK[Math.min(peak, HEAT_RISK.length - 1)];
  return `<div class="card">
    <div class="clbl">🌡 HEAT RISK &middot; NWS</div>
    <div class="sm-grid">
      <div class="sm-item"><div class="sm-lbl">PEAK TODAY</div>
        <div class="sm-val" data-css-color="${cat.color}">${esc(cat.label)}</div></div>
      <div class="sm-item"><div class="sm-lbl">LEVEL</div>
        <div class="sm-val">${peak} of 4</div></div>
    </div>
    <div class="_s-0962aa">${esc(cat.note)}</div>
  </div>`;
}

// Headline 24-hour total for an accumulation series (snowfall, ice). Both are
// mm and both are zero out of season, so the card removes itself entirely
// rather than showing a zero for eight months of the year.
//
// Total only — the hour-by-hour breakdown belongs to the Hourly tab, which
// renders it via buildAccumRow() in app.js off the same gridpoint series.
function buildAccumTotal(label, series, times, color) {
  if (!series?.length) return '';
  const totalMm = times.reduce((a, t) => a + (getGridValueAt(series, t) || 0), 0);
  if (totalMm <= 0) return '';
  const totalIn = totalMm / UNIT.MM_PER_IN;
  // NWS rounds these to the tenth of an inch; below that it's a trace, not a
  // number — printing "0.0"" would read as "none expected".
  const totalTxt = totalIn >= 0.05 ? totalIn.toFixed(1) + '"' : 'Trace';
  return `<div class="card">
    <div class="clbl">${label} &middot; NEXT 24 H</div>
    <div class="sm-grid">
      <div class="sm-item"><div class="sm-lbl">24-HOUR TOTAL</div>
        <div class="sm-val" data-css-color="${color}">${totalTxt}</div></div>
    </div>
  </div>`;
}

function buildPrecipAmtBars(hours, precipSeries, times) {
  const buckets = [];
  for (let i = 0; i < Math.min(hours.length, 24); i += 6) {
    // Sum the bucket's hours. It used to sample one hour and treat it as the
    // 6-hour amount, which only worked while hours held copies of the whole
    // period; with per-hour shares (expandAccumSeries) that would under-read 6x.
    let mm = 0;
    for (let j = i; j < Math.min(i + 6, times.length); j++) mm += getGridValueAt(precipSeries, times[j]) || 0;
    buckets.push({ inches: mm / UNIT.MM_PER_IN, label: fh(hours[i].startTime) });
  }
  if (buckets.every(b => b.inches < 0.01))
    return `<div class="_s-0962aa">No precipitation expected</div>`;
  const maxIn = Math.max(...buckets.map(b => b.inches), 0.01);
  return `<div class="_s-cf19d8">${
    buckets.map(b => {
      const barH = Math.max(4, Math.round((b.inches/maxIn)*60));
      const lbl = b.inches>0.01 ? b.inches.toFixed(2)+'"' : 'trace';
      return `<div class="_s-2990af">
        <div class="_s-a01a5f">${b.inches>0.01?lbl:''}</div>
        <div class="_s-3b6dd8" data-css-height="${barH}px"></div>
        <div class="_s-877d47">${b.label}</div>
      </div>`;
    }).join('')
  }</div>`;
}

// ── Marine forecast text ──────────────────────────────────────────────────────

function renderMarineText(data) {
  const el = document.getElementById('marine-text-section');
  if (!el) return;
  const raw = data.text.replace(/^[\s\S]*?(?=\.(?:PUGET|ADMIRALTY|INLAND|COASTAL|OUTER|SYNOPSIS))/i, '').trim();
  const text = (raw || data.text).slice(0, 2500);
  const issued = data.issued
    ? data.issued.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
    : '';
  // B5: esc the long-form CWF text — it's NWS plain text today but cheap insurance.
  el.innerHTML = `<div class="card">
    <div class="clbl">⚓ MARINE FORECAST · NWS</div>
    <div class="_s-744b50">${esc(text)||'Marine forecast unavailable.'}</div>
    ${issued?`<div class="_s-6d5214">Issued ${esc(issued)}</div>`:''}
  </div>`;
}

// ── Tides ─────────────────────────────────────────────────────────────────────

function renderTides(data) {
  const el = document.getElementById('marine-tides');
  if (!el || !data.predictions.length) { renderSectionError('marine-tides','🌊 TIDES','No tide data available.'); return; }
  const now = new Date();
  const rows = data.predictions.map(p => {
    const t = new Date(p.t), isHigh = p.type==='H', isPast = t<now;
    // Rename: `ft` would shadow the global temperature-formatter ft()
    const raw = parseFloat(p.v);
    const feet = Number.isFinite(raw) ? raw.toFixed(1) + ' ft' : '--';
    const timeStr = t.toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    return `<div class="tide-row${isPast?' tide-past':''}">
      <span class="tide-type${isHigh?' tide-high':' tide-low'}">${isHigh?'▲ HIGH':'▼ LOW'}</span>
      <span class="tide-time">${timeStr}</span>
      <span class="tide-ft">${feet}</span>
    </div>`;
  }).join('');
  const distLine = data.station.distMi != null && data.station.distMi >= 1
    ? ` · ${Math.round(data.station.distMi)} mi away`
    : '';
  el.innerHTML = `<div class="card">
    <div class="clbl">🌊 TIDES · ${esc(data.station.name)}</div>
    <div class="tide-list">${rows}</div>
    <div class="_s-a3b9eb">NOAA CO-OPS · MLLW · Station ${esc(data.station.id)}${distLine}</div>
  </div>`;
}

// ── Buoy / Surf ───────────────────────────────────────────────────────────────

function renderBuoy(data) {
  const el = document.getElementById('marine-buoy');
  if (!el) return;

  // No wave model output at this lat/lon → sheltered/inland point.
  // Show one tidy line rather than a grid of "--".
  if (data.wvht == null) {
    el.innerHTML = `<div class="card">
      <div class="clbl">🏄 SURF &amp; SEAS</div>
      <div class="_s-e64f7b">Sheltered water. No offshore wave data near this location.</div>
      <div class="_s-804a42">Inland and protected-water points (lakes, inlets, Puget Sound, etc.) don't have nearby buoys or open-ocean swell.</div>
      <div class="_s-6d5214">Open-Meteo Marine · NOAA WaveWatch III</div>
    </div>`;
    return;
  }

  const wvhtFt = (data.wvht * UNIT.FT_PER_M).toFixed(1) + ' ft';
  const wvhtM  = data.wvht.toFixed(1) + ' m';
  const period = data.dpd != null ? data.dpd.toFixed(0) + ' sec' : '--';
  const wdir   = degToCompass(data.wdir) || '--';
  const wtmpF  = data.wtmp != null
    ? (uTemp === 'C' ? data.wtmp.toFixed(0) : (data.wtmp * 9 / 5 + 32).toFixed(0)) + '\xb0'
    : '--';
  const seaState =
    data.wvht < 0.5 ? 'Calm / Glassy' :
    data.wvht < 1.0 ? 'Slight ripple' :
    data.wvht < 1.5 ? 'Slight' :
    data.wvht < 2.5 ? 'Moderate' :
    data.wvht < 4.0 ? 'Rough' : 'Very Rough';

  el.innerHTML = `<div class="card">
    <div class="clbl">🏄 SURF &amp; SEAS</div>
    <div class="buoy-grid">
      <div class="buoy-item"><div class="buoy-lbl">WAVE HEIGHT</div><div class="buoy-val">${wvhtFt}</div><div class="buoy-sub">${wvhtM}</div></div>
      <div class="buoy-item"><div class="buoy-lbl">PERIOD</div><div class="buoy-val">${period}</div><div class="buoy-sub">dominant</div></div>
      <div class="buoy-item"><div class="buoy-lbl">SEA STATE</div><div class="buoy-val _s-6cb285">${seaState}</div></div>
      <div class="buoy-item"><div class="buoy-lbl">WAVE DIR</div><div class="buoy-val">${wdir}</div><div class="buoy-sub">${data.wdir!=null?Math.round(data.wdir)+'°':''}</div></div>
      <div class="buoy-item"><div class="buoy-lbl">WATER TEMP</div><div class="buoy-val">${wtmpF}</div><div class="buoy-sub">surface</div></div>
    </div>
    <div class="_s-a3b9eb">Open-Meteo Marine · NOAA WaveWatch III</div>
  </div>`;
}
