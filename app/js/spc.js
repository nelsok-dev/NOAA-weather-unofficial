// Storm Center — SPC convective outlooks, mesoscale discussions, and the raw
// NWS text products for the active location's WFO.
//
// Everything here comes from api.weather.gov, which is already in the CSP
// connect-src and already carries a User-Agent via nwsFetch() — no new hosts.
// The SPC products live under the SWO type at pseudo-"locations":
//   /products/types/SWO/locations/DY1|DY2|DY3|D48|MCD
// and the per-office text products under the office's WFO id.
//
// Products are immutable once issued, so product TEXT is cached forever by id;
// only the per-type product LISTS carry a TTL.

// ── Caches ───────────────────────────────────────────────────────────────────
const _spcTextCache = new Map();  // product @id  → productText (immutable)
// Products that failed to load, by @id. Kept apart from the text cache: a
// failure used to be written INTO it as the error sentence, which then stood
// in for the product for the rest of the session. Closing and reopening the
// row tries again.
const _spcTextErrors = new Map();
const _spcListCache = new Map();  // "TYPE/LOC"   → { at, graph }
const SPC_LIST_TTL_MS = 5 * 60 * 1000;

// How many mesoscale discussions to pull text for. SPC can have 50+ on file
// during an outbreak; the recent dozen is what anyone actually reads, and each
// one is a separate request.
const MD_FETCH_LIMIT = 12;

// ── Screen state ─────────────────────────────────────────────────────────────
let _spcTab      = 'outlook';   // outlook | md | products
let _spcDay      = 1;           // 1 | 2 | 3
let _spcProdType = 'HWO';
let _spcNearOnly = false;
let _spcOutlookOpen = false;
const _spcOpenIds = new Set();  // expanded MD / product cards, by @id

// CLI (daily climate report) and RER (record event report) are indexed by
// climate SITE id — the 3-letter airport code, e.g. MIA / OKC — not by the
// WFO that issues them. Querying those by WFO returns nothing almost
// everywhere, so they get resolved through the location's nearest stations
// instead. Every other type below is WFO-keyed.
const SPC_STATION_KEYED = new Set(['CLI', 'RER']);

// RWR is indexed by STATE, not by office or climate site — one product covers
// every reporting station in the state as an hourly observation table. 33 of
// the 50 states file it (the northeast and mid-Atlantic mostly don't); a state
// with none answers 404, which _spcFetchList already treats as "nothing here".
const SPC_STATE_KEYED = new Set(['RWR']);

// How many of the nearest stations to try before giving up on a climate site.
// The nearest ASOS to a rural point often has no CLI on file (e.g. K04W near
// Brainerd MN); the regional airport a few entries down usually does.
const SPC_SITE_CANDIDATES = 5;

// NWS text products worth surfacing, in the order enthusiasts reach for them.
// Codes verified against /products/types.
const SPC_PRODUCT_TYPES = [
  { code: 'HWO', label: 'Hazard Outlook', full: 'Hazardous Weather Outlook' },
  { code: 'LSR', label: 'Storm Reports',  full: 'Local Storm Report' },
  { code: 'SPS', label: 'Special Stmt',   full: 'Special Weather Statement' },
  { code: 'NOW', label: 'Nowcast',        full: 'Short Term Forecast' },
  { code: 'RWR', label: 'Roundup',        full: 'Regional Weather Roundup' },
  { code: 'AFD', label: 'Discussion',     full: 'Area Forecast Discussion' },
  { code: 'ZFP', label: 'Zone Forecast',  full: 'Zone Forecast Product' },
  { code: 'CLI', label: 'Climate',        full: 'Climatological Report (Daily)' },
  { code: 'RER', label: 'Records',        full: 'Record Report' },
  { code: 'WSW', label: 'Winter',         full: 'Winter Weather Watch/Warning/Advisory' },
  { code: 'FWF', label: 'Fire Wx',        full: 'Fire Weather Forecast' },
  { code: 'ESF', label: 'Flood Outlook',  full: 'Flood Potential Outlook' },
];

// SPC categorical risk levels, weakest → strongest. `cls` selects the swatch
// colour in styles.css (SPC's own palette).
const SPC_RISKS = [
  { key: 'HIGH',      label: 'High Risk',       cls: 'risk-high' },
  { key: 'MODERATE',  label: 'Moderate Risk',   cls: 'risk-mdt'  },
  { key: 'ENHANCED',  label: 'Enhanced Risk',   cls: 'risk-enh'  },
  { key: 'SLIGHT',    label: 'Slight Risk',     cls: 'risk-slgt' },
  { key: 'MARGINAL',  label: 'Marginal Risk',   cls: 'risk-mrgl' },
];

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function _spcFetchList(type, location) {
  const key = `${type}/${location}`;
  const hit = _spcListCache.get(key);
  if (hit && Date.now() - hit.at < SPC_LIST_TTL_MS) return hit.graph;
  const r = await nwsFetch(`https://api.weather.gov/products/types/${encodeURIComponent(type)}/locations/${encodeURIComponent(location)}`);
  // A WFO that has never issued this product type answers 404 — that is a
  // legitimate "nothing here", not a failure, so it returns an empty list.
  if (r.status === 404) { _spcListCache.set(key, { at: Date.now(), graph: [] }); return []; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const graph = d['@graph'] || [];
  _spcListCache.set(key, { at: Date.now(), graph });
  return graph;
}

// Nearest station identifiers for the active location, closest first, as
// climate-site ids (the API returns ICAO like "KMIA"; the products index uses
// "MIA"). Cached per gridpoint — the station list never changes.
const _spcStationCache = new Map(); // "WFO/gx,gy" → [siteId, …]

async function _spcNearestSites() {
  const { wfo, gx, gy } = activeLocation;
  if (!wfo || gx == null || gy == null) return [];
  const key = `${wfo}/${gx},${gy}`;
  if (_spcStationCache.has(key)) return _spcStationCache.get(key);
  const r = await nwsFetch(`https://api.weather.gov/gridpoints/${wfo}/${gx},${gy}/stations?limit=${SPC_SITE_CANDIDATES}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const sites = (d.features || [])
    .map(f => f.properties?.stationIdentifier)
    .filter(Boolean)
    .map(id => (id.length === 4 && id[0] === 'K' ? id.slice(1) : id));
  _spcStationCache.set(key, sites);
  return sites;
}

// Walks the nearest stations until one actually has this product on file.
// Returns the site id that hit, plus its product list.
// Two-letter state for the active location, for the state-keyed products.
// `relState` comes from the /points relativeLocation and is the authoritative
// one; the saved-location `subtitle` and the "City, ST" name are fallbacks for
// locations that haven't been through resolveGridpoint yet.
function _spcActiveState() {
  const loc = activeLocation || {};
  const cand = loc.relState || loc.subtitle || (loc.name || '').split(',').pop();
  const st = String(cand || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(st) ? st : null;
}

async function _spcFetchStationKeyed(type) {
  const sites = await _spcNearestSites();
  for (const site of sites) {
    const graph = await _spcFetchList(type, site);
    if (graph.length) return { site, graph };
  }
  return { site: sites[0] || null, graph: [] };
}

async function _spcFetchText(id) {
  if (_spcTextCache.has(id)) return _spcTextCache.get(id);
  const r = await nwsFetch(id);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const text = (d.productText || '').trim();
  _spcTextCache.set(id, text);
  return text;
}

// ── Text parsing ─────────────────────────────────────────────────────────────

// Strip the teleprinter-era header block every NWS product still carries: the
// transmission sequence number, the WMO heading, the AWIPS id, the issuing
// centre's product line, and the UGC zone/expiry line. These are routing
// metadata, not content — they push the actual discussion below the fold.
const _SPC_HEADER_LINES = [
  /^\d{3}$/,                          // transmission sequence ("000")
  /^[A-Z]{4}\d{2} [A-Z]{4} \d{6}$/,   // WMO heading  ("ACUS01 KWNS 040101")
  /^[A-Z]{3,8}\d{0,2}$/,              // AWIPS id     ("SWODY1", "SWOMCD")
  /^(?:SPC|NWS) [A-Z]{2,3} \d{6}$/,   // centre line  ("SPC AC 040059")
  /^[A-Z]{2}[CZ]\d{3}[->].*-\d{6}-$/, // UGC zone/expiry ("MNZ000-040600-")
];

function _spcStripHeader(text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '' || _SPC_HEADER_LINES.some(re => re.test(line))) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Highest categorical risk named in a convective outlook headline. SPC writes
// one "...THERE IS A <CAT> RISK..." headline per category, strongest first.
function _spcParseRisk(text) {
  const head = String(text || '').toUpperCase();
  for (const r of SPC_RISKS) {
    if (new RegExp(`THERE IS A ${r.key} RISK`).test(head)) return r;
  }
  if (/GENERAL THUNDERSTORM/.test(head)) {
    return { key: 'TSTM', label: 'General Thunderstorms', cls: 'risk-tstm' };
  }
  return { key: 'NONE', label: 'No Severe Areas', cls: 'risk-none' };
}

// The ...SUMMARY... block — the two or three sentences that say what the day
// actually looks like.
function _spcParseSummary(text) {
  const m = String(text || '').match(/\.\.\.SUMMARY\.\.\.\s*\n([\s\S]*?)(?=\n\s*\n)/);
  return m ? m[1].replace(/\s*\n\s*/g, ' ').trim() : '';
}

function _spcParseField(text, name) {
  const m = String(text || '').match(new RegExp(`${name}\\.\\.\\.([\\s\\S]*?)(?=\\n\\s*\\n|\\n[A-Z][A-Za-z ]*\\.\\.\\.)`));
  return m ? m[1].replace(/\s*\n\s*/g, ' ').replace(/\.+$/, '').trim() : '';
}

// SPC packs the product's polygon into a LAT...LON block of 8-digit tokens:
// 4 digits of latitude and 4 of west longitude, both ×100. Longitudes past
// 100°W wrap (109.45°W ships as "0945"), so anything implausibly small for the
// CONUS gets 100 added back.
function _spcParseLatLon(text) {
  const m = String(text || '').match(/LAT\.\.\.LON\s+((?:\s*\d{8})+)/);
  if (!m) return null;
  const pts = m[1].trim().split(/\s+/)
    .filter(t => /^\d{8}$/.test(t))
    .map(t => {
      const lat = parseInt(t.slice(0, 4), 10) / 100;
      let lon = parseInt(t.slice(4), 10) / 100;
      if (lon < 40) lon += 100;
      return [lat, -lon];
    });
  return pts.length >= 3 ? pts : null;
}

// Ray-casting point-in-polygon. Used only to badge "near you" — the polygons
// are small enough that planar maths is well within the error anyone cares
// about at this zoom.
function _spcPointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Issuance times are shown in the LOCATION's timezone (via the shared _locTZ()
// helper), so "3 PM" matches the clock time printed inside the product text
// rather than the reader's own zone.
// NWS narrative products are hard-wrapped at ~69 columns and read fine wrapped
// to a phone screen. Tabular ones (CLI's climate table) are the same width but
// turn to mush when wrapped, so they get horizontal scroll with their columns
// intact instead.
//
// Line length can't tell the two apart — both run to ~73 chars. Column gutters
// can: a run of 3+ spaces between non-space characters is ubiquitous in the
// tables and essentially absent from prose (measured: 47% of CLI lines vs 0%
// of AFD/HWO lines).
function _spcProseClass(text) {
  const lines = String(text || '').split('\n').filter(l => l.trim());
  if (!lines.length) return 'spc-prose';
  const gutters = lines.filter(l => /\S {3,}\S/.test(l)).length;
  return gutters / lines.length > 0.2 ? 'spc-prose spc-prose-wide' : 'spc-prose';
}

function _spcTime(iso, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const o = opts || { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const tz = typeof _locTZ === 'function' ? _locTZ() : undefined;
  if (tz) { try { return d.toLocaleString([], { ...o, timeZone: tz }); } catch (e) { _warn('spcTime/tz', e); } }
  return d.toLocaleString([], o);
}

// "3 min ago" / "2 hr ago" — the age matters more than the clock time for
// mesoscale products.
function _spcAge(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' hr ago';
  return Math.round(hrs / 24) + ' d ago';
}

// ── Render: chrome ───────────────────────────────────────────────────────────

function _spcTabsHTML() {
  const tabs = [
    { id: 'outlook',  label: 'Outlook' },
    { id: 'md',       label: 'Discussions' },
    { id: 'products', label: 'Products' },
    { id: 'tropical', label: 'Tropical' },
    { id: 'winter',   label: 'Winter' },
  ];
  return `<div class="spc-tabs">${tabs.map(t => `
    <button class="prbtn${_spcTab === t.id ? ' on' : ''}" data-click-action="spcTab" data-tab="${t.id}">${t.label}</button>`).join('')}</div>`;
}

function _spcLoadingHTML(msg) {
  return `<div class="ldg" role="status" aria-live="polite"><div class="spin"></div><div class="_s-5e0faa">${esc(msg)}</div></div>`;
}

function _spcErrorHTML(msg) {
  return `<div class="card spc-empty">
    <div class="spc-empty-txt">${esc(msg)}</div>
    <button class="afd-expand-btn" data-click-action="spcRetry">Try again ›</button>
  </div>`;
}

// ── Render: thunder probability at this point ────────────────────────────────
// SPC's outlook is regional and categorical — "slight risk across western
// Minnesota" says nothing about your own back yard. The NWS gridpoint carries
// probabilityOfThunder for the user's grid box, so the strip under the risk
// banner answers the question the outlook provokes: what does this mean here?

const POT_HOURS = 12;

// Hourly rows for the next POT_HOURS, from the shared gridpoint series.
function _spcPotRows(series) {
  if (!series || !series.length) return [];
  const rows = [];
  const now = Date.now();
  for (let i = 0; i < POT_HOURS; i++) {
    const t = new Date(now + i * 3600000);
    const v = getGridValueAt(series, t);
    if (v == null) continue;
    rows.push({ time: t, pct: Math.round(v) });
  }
  return rows;
}

function _spcPotHTML(rows) {
  if (!rows.length) return '';   // office publishes no thunder grid — say nothing
  const peak = rows.reduce((a, b) => (b.pct > a.pct ? b : a), rows[0]);
  const nowPct = rows[0].pct;

  // Scale bars to the window's own peak (floor of 20) so a quiet day shows a
  // readable shape rather than 12 slivers — same approach as the UV chart.
  const ceiling = Math.max(peak.pct, 20);
  const cols = rows.map((r, i) => {
    const h = Math.max(2, Math.round((r.pct / ceiling) * 44));
    // Identity, not value — on a plateau several hours share the peak number,
    // and highlighting all of them contradicts a caption that names one hour.
    const isPeak = r === peak && peak.pct > 0;
    return `<div class="pot-col${isPeak ? ' peak' : ''}${i === 0 ? ' now' : ''}">
      <div class="pot-num">${r.pct}</div>
      <div class="pot-bar" data-css-height="${h}px"></div>
      <div class="pot-hr">${i === 0 ? 'Now' : esc(fh(r.time.toISOString()))}</div>
    </div>`;
  }).join('');

  // A flat zero next to a risk banner is real information: the regional threat
  // does not reach this grid box.
  const caption = peak.pct === 0
    ? 'No thunderstorm chance in this grid box for the next 12 hours.'
    : `Peak ${peak.pct}% around ${esc(fh(peak.time.toISOString()))}.`;

  return `
    <div class="spc-pot">
      <div class="spc-pot-hd">
        <span class="spc-pot-lbl">THUNDER CHANCE HERE</span>
        <span class="spc-pot-now">${nowPct}%<span class="spc-pot-unit">now</span></span>
      </div>
      <div class="pot-chart">${cols}</div>
      <div class="spc-pot-cap">${caption} NWS ${esc((activeLocation.wfo || '').toUpperCase())} gridpoint forecast for ${esc(displayName(activeLocation))}.</div>
    </div>`;
}

// ── Render: convective outlook ───────────────────────────────────────────────

function _spcOutlookHTML(state) {
  if (state.error) return _spcErrorHTML(state.error);
  if (!state.text)  return _spcLoadingHTML('Loading SPC outlook…');

  const body    = _spcStripHeader(state.text);
  const risk    = _spcParseRisk(body);
  const summary = _spcParseSummary(body);
  const valid   = (body.match(/Valid\s+(\d{6}Z\s+-\s+\d{6}Z)/) || [])[1] || '';

  const days = [1, 2, 3].map(d => `
    <button class="llbtn${_spcDay === d ? ' active' : ''}" data-click-action="spcDay" data-day="${d}">Day ${d}</button>`).join('');

  return `
    <div class="spc-dayrow">${days}</div>
    <div class="card spc-card">
      <div class="clbl">SPC CONVECTIVE OUTLOOK<span class="spc-clbl-tag">DAY ${_spcDay}</span></div>
      <div class="spc-risk ${risk.cls}">
        <span class="spc-risk-dot"></span>
        <span class="spc-risk-lbl">${esc(risk.label)}</span>
        ${valid ? `<span class="spc-risk-valid">${esc(valid)}</span>` : ''}
      </div>
      ${_spcDay === 1 ? _spcPotHTML(state.pot || []) : ''}
      ${summary ? `<div class="spc-summary">${esc(summary)}</div>` : ''}
      <div class="spc-prose afd-scroll${_spcOutlookOpen ? '' : ' spc-clamp'}">${esc(body)}</div>
      <button class="afd-expand-btn" data-click-action="spcToggleOutlook">${_spcOutlookOpen ? 'Show less ‹' : 'Read full outlook ›'}</button>
      <div class="spc-meta"><span class="ldot"></span>NOAA/NWS Storm Prediction Center · issued ${esc(_spcTime(state.issued))}</div>
    </div>`;
}

// ── Render: mesoscale discussions ────────────────────────────────────────────

function _spcMDCardHTML(md) {
  const open = _spcOpenIds.has(md.id);
  const num  = (md.body.match(/Mesoscale Discussion\s+(\d+)/) || [])[1] || '';
  const areas      = _spcParseField(md.body, 'Areas affected');
  const concerning = _spcParseField(md.body, 'Concerning');
  const summary    = _spcParseField(md.body, 'SUMMARY');
  const watchProb  = (md.body.match(/Probability of Watch Issuance\.\.\.(\d+)\s*percent/i) || [])[1];
  const tor  = _spcParseField(md.body, 'MOST PROBABLE PEAK TORNADO INTENSITY');
  const wind = _spcParseField(md.body, 'MOST PROBABLE PEAK WIND GUST');
  const hail = _spcParseField(md.body, 'MOST PROBABLE PEAK HAIL SIZE');

  const tags = [
    tor  ? `<span class="spc-tag tag-tor">TOR ${esc(tor)}</span>`   : '',
    wind ? `<span class="spc-tag tag-wind">WIND ${esc(wind)}</span>` : '',
    hail ? `<span class="spc-tag tag-hail">HAIL ${esc(hail)}</span>` : '',
  ].join('');

  return `
    <div class="card spc-card spc-md${md.near ? ' spc-md-near' : ''}">
      <div class="clbl">
        MESOSCALE DISCUSSION ${esc(num)}
        ${md.near ? '<span class="spc-near-badge">NEAR YOU</span>' : ''}
        <span class="spc-age">${esc(_spcAge(md.issued))}</span>
      </div>
      ${areas ? `<div class="spc-md-areas">${esc(areas)}</div>` : ''}
      ${concerning ? `<div class="spc-md-concerning">${esc(concerning)}</div>` : ''}
      ${watchProb ? `<div class="spc-watchprob"><span class="spc-watchprob-num">${esc(watchProb)}%</span> probability of watch issuance</div>` : ''}
      ${tags ? `<div class="spc-tags">${tags}</div>` : ''}
      ${summary && !open ? `<div class="spc-summary">${esc(summary)}</div>` : ''}
      ${open ? `<div class="spc-prose afd-scroll">${esc(_spcStripHeader(md.body))}</div>` : ''}
      <button class="afd-expand-btn" data-click-action="spcToggleMD" data-id="${esc(md.id)}">${open ? 'Show less ‹' : 'Read full discussion ›'}</button>
    </div>`;
}

function _spcMDHTML(state) {
  if (state.error) return _spcErrorHTML(state.error);
  if (!state.list)  return _spcLoadingHTML('Loading mesoscale discussions…');

  const nearCount = state.list.filter(m => m.near).length;
  const shown = _spcNearOnly ? state.list.filter(m => m.near) : state.list;

  const filter = `
    <div class="spc-filter">
      <button class="llbtn${_spcNearOnly ? '' : ' active'}" data-click-action="spcNearOnly" data-near="0">All (${state.list.length})</button>
      <button class="llbtn${_spcNearOnly ? ' active' : ''}" data-click-action="spcNearOnly" data-near="1">Near me (${nearCount})</button>
    </div>`;

  if (!state.list.length) {
    return filter + `<div class="card spc-empty"><div class="spc-empty-txt">No active mesoscale discussions. SPC issues these when severe weather looks likely in the next few hours.</div></div>`;
  }
  if (!shown.length) {
    return filter + `<div class="card spc-empty"><div class="spc-empty-txt">None of the ${state.list.length} current discussions cover ${esc(displayName(activeLocation))}.</div></div>`;
  }
  return filter + shown.map(_spcMDCardHTML).join('');
}

// ── Render: WFO text products ────────────────────────────────────────────────

function _spcProductRowHTML(p, text) {
  const open = _spcOpenIds.has(p.id);
  return `
    <div class="card spc-card spc-prod">
      <button class="spc-prod-head" data-click-action="spcToggleProd" data-id="${esc(p.id)}">
        <span class="spc-prod-time">${esc(_spcTime(p.issued))}</span>
        <span class="spc-age">${esc(_spcAge(p.issued))}</span>
        <span class="spc-prod-chev">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? (text
        ? `<div class="${_spcProseClass(_spcStripHeader(text))} afd-scroll">${esc(_spcStripHeader(text))}</div>`
        : _spcTextErrors.has(p.id)
        ? `<div class="spc-prose spc-prose-ldg">${esc(_spcTextErrors.get(p.id))}</div>`
        : `<div class="spc-prose spc-prose-ldg">Loading…</div>`) : ''}
    </div>`;
}

function _spcProductsHTML(state) {
  const chips = SPC_PRODUCT_TYPES.map(t => `
    <button class="prbtn${_spcProdType === t.code ? ' on' : ''}" data-click-action="spcProdType" data-type="${t.code}">${esc(t.label)}</button>`).join('');
  const row = `<div class="prod-row spc-prod-row">${chips}</div>`;
  const meta = SPC_PRODUCT_TYPES.find(t => t.code === _spcProdType);
  const wfo = (activeLocation.wfo || '').toUpperCase();

  const full = meta ? meta.full : _spcProdType;
  // Station-keyed types report the climate site they resolved to; WFO-keyed
  // ones report the office. Either way the user sees whose product this is.
  const src = state.source || wfo;

  if (state.error) return row + _spcErrorHTML(state.error);
  if (!state.list)  return row + _spcLoadingHTML('Loading products…');
  if (!state.list.length) {
    return row + `<div class="card spc-empty"><div class="spc-empty-txt">No ${esc(full)} on file for ${esc(src)} right now.</div></div>`;
  }
  return row
    + `<div class="spc-prod-lbl">${esc(full)} · ${esc(
        SPC_STATION_KEYED.has(_spcProdType) || SPC_STATE_KEYED.has(_spcProdType) ? src : 'NWS ' + src
      )} · ${state.list.length} on file</div>`
    + state.list.map(p => _spcProductRowHTML(p, _spcTextCache.get(p.id))).join('');
}

// ── Screen render + data loading ─────────────────────────────────────────────

// Per-tab view state, rebuilt on location change.
// `tropical` is basin-wide, not tied to the active location, so a location
// switch keeps it (see resetStormCenter).
let _spcState = { outlook: {}, md: {}, products: {}, tropical: {}, winter: {} };

// How long a tab's data is shown before it is fetched again. Each tab used to
// load exactly once — only a location change or the Retry button reset it — and
// iOS keeps the app alive for days, so mesoscale discussions, the outlook and
// NHC advisories could be hours old on the one screen people open when weather
// is changing fast. A stale tab is refetched in the background while the old
// content stays on screen; a refetch that fails keeps it rather than replacing
// good data with an error. Matched to each source's own cadence and cache.
const SPC_TAB_TTL_MS = {
  outlook:  10 * 60 * 1000,
  md:        5 * 60 * 1000,   // = SPC_LIST_TTL_MS; MDs are the fast-moving one
  products:  5 * 60 * 1000,
  tropical: 10 * 60 * 1000,   // = TROP_TTL_MS
  winter:   30 * 60 * 1000,   // = WINTER_TTL_MS
};
function _spcHasData(tab) {
  const st = _spcState[tab] || {};
  return !!(st.text || st.list || st.data);
}

function _spcPaint() {
  const body = document.getElementById('spc-body');
  if (!body) return;
  let inner = '';
  if (_spcTab === 'outlook')       inner = _spcOutlookHTML(_spcState.outlook);
  else if (_spcTab === 'md')       inner = _spcMDHTML(_spcState.md);
  else if (_spcTab === 'tropical') inner = _spcTropicalHTML(_spcState.tropical);
  else if (_spcTab === 'winter')   inner = _spcWinterHTML(_spcState.winter);
  else                             inner = _spcProductsHTML(_spcState.products);
  const source = _spcTab === 'tropical'
    ? 'Hurricane and tropical storm data from the NOAA/NWS National Hurricane Center, retrieved from mapservices.weather.noaa.gov.'
    : _spcTab === 'winter'
    ? 'Snow and ice from the NWS forecast grid (api.weather.gov); winter storm severity and probabilities from the NOAA/NWS Weather Prediction Center (mapservices.weather.noaa.gov).'
    : 'Text products issued by NOAA/NWS and the Storm Prediction Center, retrieved from api.weather.gov.';
  _setInnerIfChanged(body, _spcTabsHTML() + inner
    + `<div class="dv-source">${source} This app is not affiliated with NOAA or the National Weather Service.</div>`);

  const nameEl = document.getElementById('spc-loc-name');
  if (nameEl) nameEl.textContent = displayName(activeLocation);
}

async function _spcLoadOutlook() {
  const myGen = _locGen;
  const day = _spcDay;
  try {
    const graph = await _spcFetchList('SWO', 'DY' + day);
    if (_locGen !== myGen || _spcDay !== day) return;
    const latest = graph[0];
    if (!latest) throw new Error('SPC has not published a Day ' + day + ' outlook right now.');
    const text = await _spcFetchText(latest['@id']);
    if (_locGen !== myGen || _spcDay !== day) return;
    _spcState.outlook = { text, issued: latest.issuanceTime, at: Date.now() };
    _spcPaint();
    // The thunder strip covers the next 12 hours, so it only belongs beside the
    // Day 1 outlook — a "next 12 hours" chart under a Day 3 outlook would be
    // describing a different period than the text above it. Loaded after the
    // text is painted so a slow gridpoint fetch never delays the outlook.
    if (day === 1) {
      const grid = await getGridpointDataCached();
      if (_locGen !== myGen || _spcDay !== day) return;
      _spcState.outlook.pot = _spcPotRows(grid && grid.thunder);
    }
  } catch (e) {
    if (_locGen !== myGen || _spcDay !== day) return;
    _warn('spcLoadOutlook', e);
    if (_spcState.outlook.text) _spcState.outlook.at = Date.now();   // keep what's on screen
    else _spcState.outlook = { error: 'Could not load the SPC Day ' + day + ' outlook.' };
  }
  _spcPaint();
}

async function _spcLoadMDs() {
  const myGen = _locGen;
  try {
    const graph = await _spcFetchList('SWO', 'MCD');
    if (_locGen !== myGen) return;
    const recent = graph.slice(0, MD_FETCH_LIMIT);
    const texts = await Promise.allSettled(recent.map(p => _spcFetchText(p['@id'])));
    if (_locGen !== myGen) return;
    const { lat, lon } = activeLocation;
    const list = [];
    recent.forEach((p, i) => {
      if (texts[i].status !== 'fulfilled') return;
      const body = texts[i].value;
      const poly = _spcParseLatLon(body);
      list.push({
        id: p['@id'],
        issued: p.issuanceTime,
        body,
        near: !!(poly && lat != null && lon != null && _spcPointInPoly(lat, lon, poly)),
      });
    });
    // Anything covering the user's location floats to the top; the rest stay
    // newest-first as SPC ordered them.
    list.sort((a, b) => (b.near - a.near) || (new Date(b.issued) - new Date(a.issued)));
    _spcState.md = { list, at: Date.now() };
  } catch (e) {
    if (_locGen !== myGen) return;
    _warn('spcLoadMDs', e);
    if (_spcState.md.list) _spcState.md.at = Date.now();
    else _spcState.md = { error: 'Could not load mesoscale discussions.' };
  }
  _spcPaint();
}

async function _spcLoadProducts() {
  const myGen = _locGen;
  const type = _spcProdType;
  const wfo = (activeLocation.wfo || '').toUpperCase();
  if (!wfo) { _spcState.products = { error: 'No NWS forecast office is known for this location yet.' }; _spcPaint(); return; }
  try {
    let graph, source;
    if (SPC_STATION_KEYED.has(type)) {
      const res = await _spcFetchStationKeyed(type);
      graph = res.graph;
      source = res.site;
    } else if (SPC_STATE_KEYED.has(type)) {
      const st = _spcActiveState();
      if (!st) {
        _spcState.products = { error: 'No state is known for this location yet.' };
        _spcPaint();
        return;
      }
      graph = await _spcFetchList(type, st);
      source = st;
    } else {
      graph = await _spcFetchList(type, wfo);
      source = wfo;
    }
    if (_locGen !== myGen || _spcProdType !== type) return;
    _spcState.products = {
      source,
      list: graph.slice(0, 15).map(p => ({ id: p['@id'], issued: p.issuanceTime })),
      at: Date.now(),
    };
  } catch (e) {
    if (_locGen !== myGen || _spcProdType !== type) return;
    _warn('spcLoadProducts', e);
    if (_spcState.products.list) _spcState.products.at = Date.now();
    else _spcState.products = { error: 'Could not load ' + type + ' products for NWS ' + wfo + '.' };
  }
  _spcPaint();
}

// ── Tropical (NHC) — data and markup live in tropical.js ─────────────────────

function _spcTropicalHTML(state) {
  if (state.error) return _spcErrorHTML(state.error);
  if (!state.data)  return _spcLoadingHTML('Loading National Hurricane Center data…');
  return tropicalPanelHTML(state.data);
}

async function _spcLoadTropical() {
  try {
    _spcState.tropical = { data: await tropFetch(), at: Date.now() };
  } catch (e) {
    _warn('spcLoadTropical', e);
    if (_spcState.tropical.data) _spcState.tropical.at = Date.now();
    else _spcState.tropical = { error: 'Could not load National Hurricane Center data.' };
  }
  _spcPaint();
}

// ── Winter — data and markup live in winter.js ───────────────────────────────

function _spcWinterHTML(state) {
  if (state.error) return _spcErrorHTML(state.error);
  if (!state.data)  return _spcLoadingHTML('Loading winter outlook…');
  return winterPanelHTML(state.data);
}

async function _spcLoadWinter() {
  const myGen = _locGen;
  try {
    const data = await winterFetch(activeLocation);
    if (_locGen !== myGen) return;
    if (data.failed && _spcState.winter.data) _spcState.winter.at = Date.now();
    else _spcState.winter = data.failed ? { error: 'Could not load the winter outlook.' } : { data, at: Date.now() };
  } catch (e) {
    if (_locGen !== myGen) return;
    _warn('spcLoadWinter', e);
    if (_spcState.winter.data) _spcState.winter.at = Date.now();
    else _spcState.winter = { error: 'Could not load the winter outlook.' };
  }
  _spcPaint();
}

function _spcLoadActiveTab() {
  const tab = _spcTab;
  const st = _spcState[tab] || {};
  // Nothing yet (and no error on screen): load. Loaded but older than the tab's
  // TTL: reload behind the current content. An error stays until Retry.
  const due = _spcHasData(tab)
    ? (st.at && Date.now() - st.at > (SPC_TAB_TTL_MS[tab] || SPC_LIST_TTL_MS))
    : !st.error;
  if (!due) return;
  if (tab === 'winter') _spcLoadWinter();
  else if (tab === 'tropical') _spcLoadTropical();
  else if (tab === 'outlook') _spcLoadOutlook();
  else if (tab === 'md') _spcLoadMDs();
  else _spcLoadProducts();
}

// Called on the app's alert poll and on return to the app: refreshes the open
// tab when it has gone stale, so a Storm Center left on screen keeps up.
function refreshStormCenterIfOpen() {
  if (!document.getElementById('s-spc')?.classList.contains('active')) return;
  _spcLoadActiveTab();
}

// Entry point — called from goNav() when the Storm Center screen opens.
function renderStormCenter() {
  _spcPaint();
  _spcLoadActiveTab();
}

// Dropped when the active location changes so the next open refetches against
// the new WFO. Called from app.js's location-switch path.
function resetStormCenter() {
  // Winter is per-location (it is a point lookup), so it goes; tropical is
  // basin-wide and stays.
  _spcState = { outlook: {}, md: {}, products: {}, tropical: _spcState.tropical, winter: {} };
  _spcOpenIds.clear();
}

// ── Deep link from elsewhere in the app ──────────────────────────────────────

// Opens Storm Center straight onto one text product, rather than dropping the
// user on the Outlook tab to find it themselves. Used by the hourly-roundup
// link on the Weather screen.
function spcOpenProduct(type) {
  if (!type) return;
  _spcTab = 'products';
  if (type !== _spcProdType) {
    _spcProdType = type;
    _spcState.products = {};
  }
  goNav('s-spc');       // renderStormCenter() paints and loads the active tab
}

// Opens Storm Center on a given tab — used by the Weather screen's winter card.
function spcOpenTab(tab) {
  if (!tab) return;
  _spcTab = tab;
  goNav('s-spc');       // renderStormCenter() paints and loads the active tab
}

// True when the active location's state files a Regional Weather Roundup.
// Only 33 of 50 states do, so callers use this to avoid offering a link that
// lands on "none on file". Shares _spcFetchList's cache, so following the link
// afterwards costs nothing.
async function spcRoundupAvailable() {
  if (typeof _spcActiveState !== 'function') return null;
  const st = _spcActiveState();
  if (!st) return null;
  try {
    const graph = await _spcFetchList('RWR', st);
    return graph.length ? { state: st, issued: graph[0].issuanceTime } : null;
  } catch (_) {
    return null;   // best-effort: a failed probe just means no link
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

registerActions({
  spcTab: (el) => {
    _spcTab = el.dataset.tab || 'outlook';
    _spcPaint();
    _spcLoadActiveTab();
  },
  spcDay: (el) => {
    const d = parseInt(el.dataset.day, 10);
    if (!d || d === _spcDay) return;
    _spcDay = d;
    _spcOutlookOpen = false;
    _spcState.outlook = {};
    _spcPaint();
    _spcLoadOutlook();
  },
  spcToggleOutlook: () => { _spcOutlookOpen = !_spcOutlookOpen; _spcPaint(); },
  spcNearOnly: (el) => { _spcNearOnly = el.dataset.near === '1'; _spcPaint(); },
  spcToggleMD: (el) => {
    const id = el.dataset.id;
    if (_spcOpenIds.has(id)) _spcOpenIds.delete(id); else _spcOpenIds.add(id);
    _spcPaint();
  },
  spcProdType: (el) => {
    const t = el.dataset.type;
    if (!t || t === _spcProdType) return;
    _spcProdType = t;
    _spcState.products = {};
    _spcPaint();
    _spcLoadProducts();
  },
  spcToggleProd: async (el) => {
    const id = el.dataset.id;
    if (_spcOpenIds.has(id)) { _spcOpenIds.delete(id); _spcPaint(); return; }
    _spcOpenIds.add(id);
    _spcPaint();                       // paints the row's "Loading…" placeholder
    if (_spcTextCache.has(id)) return;
    _spcTextErrors.delete(id);
    _spcPaint();                       // "Loading…" again if this is a retry
    const myGen = _locGen;
    try { await _spcFetchText(id); } catch (e) {
      _warn('spcToggleProd', e);
      _spcTextErrors.set(id, 'Couldn’t load this product. Close it and try again.');
    }
    if (_locGen !== myGen) return;
    _spcPaint();
  },
  spcRetry: () => {
    if (_spcTab === 'outlook')       _spcState.outlook = {};
    else if (_spcTab === 'md')       _spcState.md = {};
    else if (_spcTab === 'tropical') _spcState.tropical = {};
    else if (_spcTab === 'winter')   _spcState.winter = {};
    else                             _spcState.products = {};
    _spcListCache.clear();
    _spcPaint();
    _spcLoadActiveTab();
  },
});
