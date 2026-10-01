// ─────────────────────────────────────────────────────────────────────────────
// Event-delegation dispatcher
//
// Replaces the inline `onclick="foo()"` pattern so the CSP can drop
// `'unsafe-inline'` from script-src. Every interactive element now uses
//   <button data-click-action="openSettings">
//   <select data-change-action="setPoll">
//   <input  data-input-action="onGlobalSearch" data-focus-action="..." ...>
//   <div    data-touchstart-action="lcTouchStart" data-touchend-action="...">
// — keyed by event type so one element can wire multiple gestures cleanly.
//
// Each action name maps to an entry in the ACTIONS map; the handler signature
// is `(el, event)` where `el` is the matched element (the equivalent of the
// old `this`). Per-action arguments come from `data-*` attributes on `el`.
// ─────────────────────────────────────────────────────────────────────────────
const ACTIONS = {};
function registerActions(map) { Object.assign(ACTIONS, map); }

function _dispatchEvent(e) {
  // closest() walks up from the event target — handles both clicks on a
  // child icon inside a button and direct clicks on the button itself.
  const attr = `data-${e.type}-action`;
  const el = e.target.closest ? e.target.closest(`[${attr}]`) : null;
  if (!el) return;
  const action = el.getAttribute(attr);
  const fn = ACTIONS[action];
  if (!fn) { _warn('dispatch', 'no handler for ' + action); return; }
  fn(el, e);
}

// Bubble-phase delegation for events that bubble. focusin/out are the
// bubbling versions of focus/blur.
//
// touchmove is deliberately NOT in this list — see _bindSwipeTargets() below.
['click', 'input', 'change', 'submit',
 'touchstart', 'touchend', 'touchcancel'].forEach(name => {
  document.addEventListener(name, _dispatchEvent, { passive: true, capture: false });
});

// keydown is registered NON-passive, unlike the rest.
//
// `passive: true` is not free here — it makes preventDefault() a silent no-op,
// and two keyboard handlers depend on it: _kbdClick (Space/Enter on the
// role="button" divs) and onGlobalSearchKey/obSearchKey (Arrow keys walking the
// search dropdown). While keydown was passive, pressing Space on a focused
// location card scrolled the page AND activated the card, and arrowing through
// search results scrolled the page behind the dropdown. Measured both.
//
// There is no scrolling fast-path to give up in exchange: the passive
// optimisation applies to touchstart/touchmove/wheel, which can block scrolling
// while a handler runs. keydown is not one of those, so non-passive costs
// nothing and buys back working keyboard activation.
document.addEventListener('keydown', _dispatchEvent, { passive: false, capture: false });

document.addEventListener('focusin', _dispatchEvent, false);

// ── touchmove: scoped, not document-wide ─────────────────────────────────────
// touchmove used to be registered on `document` with { passive: false }, so
// that the two swipe handlers could call preventDefault. The cost of that is
// paid by every screen: a non-passive touchmove listener on document tells
// WebKit that ANY scroll, anywhere in the app, might be cancelled, so it cannot
// take the fast scrolling path — and every touchmove of every scroll also paid
// a closest() walk that could only ever miss.
//
// data-touchmove-action exists in exactly two places in the whole app: the
// location cards (lcTouchMove, inside #s-loc) and the notification history rows
// (nhTouchMove, inside #notif-list). Binding there instead keeps preventDefault
// working for swipe-to-delete while leaving every other surface passive.
//
// Both containers are static markup that outlives the innerHTML rewrites of
// their contents (#loc-list / the notif rows), so delegation from them survives
// re-renders exactly as the document-level listener did.
//
// This mirrors what both pull-to-refresh implementations already do — see the
// scroller binding in addPullToRefresh() and bindMapPullGestures() in map.js.
//
// It is NOT registered on document as well: a second passive listener there
// would dispatch each swipe twice and log an "Unable to preventDefault inside
// passive event listener" warning on every touchmove of a drag.
//
// Passivity is per-root, because only one of the two handlers needs to cancel:
//   • #s-loc      — lcTouchMove calls e.preventDefault() to stop the horizontal
//                   card swipe turning into a page scroll. Must be non-passive.
//   • #notif-list — nhTouchMove only sets a transform; it never calls
//                   preventDefault. Passive here keeps the fast scrolling path
//                   for the notification list, which scrolls vertically far
//                   more often than it is swiped.
// If nhTouchMove ever needs to cancel, flip its flag — a preventDefault() in a
// passive listener fails silently, which is exactly the trap this maps around.
const SWIPE_ROOTS = Object.freeze({ 's-loc': { passive: false }, 'notif-list': { passive: true } });
function _bindSwipeTargets() {
  for (const [id, opts] of Object.entries(SWIPE_ROOTS)) {
    const el = document.getElementById(id);
    if (!el || el._swipeBound) continue;
    el._swipeBound = true;
    el.addEventListener('touchmove', _dispatchEvent, { passive: opts.passive, capture: false });
  }
}

// onerror doesn't bubble for <img>. Use capture-phase document listener to
// catch all image load failures and dispatch on the markers:
//   data-img-fb   → hide self + reveal next sibling (the imgFb() pattern)
//   data-img-hide → just hide self (the static "this.style.display=none" pattern)
document.addEventListener('error', e => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG') return;
  if (t.hasAttribute('data-img-fb')) {
    t.style.display = 'none';
    const fb = t.nextElementSibling;
    if (fb) fb.style.display = '';
  } else if (t.hasAttribute('data-img-hide')) {
    t.style.display = 'none';
  }
}, true);

// D7 / N55: helper for catches that previously silently swallowed errors.
// Silent on native iOS Capacitor (no easy console access for end users,
// no noise in Xcode) AND on web production (so deployed users don't see
// our internal labels in their DevTools). Logs only when explicitly in
// dev: localhost / 127.0.0.1 / *.local, or window.__DEV is truthy — set
// `window.__DEV = true` in DevTools to opt in on any host.
const __DEV = (() => {
  try {
    if (window.__DEV) return true;
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || h.endsWith('.local');
  } catch (_) { return false; }
})();
function _warn(label, err) {
  if (!__DEV) return;
  try {
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform()) return;
    console.warn('[noaa-wx] ' + label + ':', err);
  } catch (_) {}
}

// D4: timing constants. The ones that already had names (LOAD_WATCHDOG_MS,
// NWS_TIMEOUT_MS, *_TTL_MS, ZONE_BATCH_CHUNK, etc.) stay where they live
// inside their feature module. This block is for the small scattered numbers
// that didn't deserve their own const but were repeated across files.
const TIMINGS = Object.freeze({
  CLOCK_TICK_MS:    30_000,   // wall clock + live-chip refresh interval
  BRIEFING_POLL_MS: 60_000,   // morning-briefing check cadence
  RETURN_REFRESH_MS:60_000,   // visibilitychange: refetch if hidden longer than this
  PTR_HOLD_MS:        900,    // pull-to-refresh "Refreshing…" hold time
  PTR_COLLAPSE_MS:    260,    // pull-to-refresh indicator collapse animation
  PTR_CLICK_SUPPRESS_MS: 350, // block click after a swipe gesture
  SEARCH_DEBOUNCE_MS: 400,    // global search input debounce
  ALERTS_RETRY_BASE_MS: 1500, // alerts.js retry exponential base
  WMS_RETRY_MS:      5_000,   // map.js radar/satellite retry delay
  SKY_BG_RESIZE_MS:     80,   // skyBg resize debounce on window resize
  TOAST_DURATION_MS: 6500,    // how long a notification toast stays visible
  GIBS_LAG_MS:    90 * 60_000, // GIBS satellite data lags real-time by ~90 min
});

// D6: single source of truth for the in-app version string. Keep in sync with
// package.json + MARKETING_VERSION in the Xcode project file.
// Format: MAJOR.MINOR.BUILD (e.g. "1.3.4") — no separate build counter.
// Bump on every TestFlight/App-Store submission.
const APP_VERSION = '1.21.0';
const APP_COPYRIGHT = '© 2025–2026 nelsok';

// ─────────────────────────────────────────────────────────────────────────────
// app.js — entry script. Owns these cross-file globals:
//   • activeLocation, SAVED_LOCS, locPointCache  — location state
//   • wxData                                      — forecast/hourly/alerts data
//   • uTemp / uWind / uVis                        — display unit prefs
//   • pushPerm, minSev                            — notification settings
//   • seenIds, notifLog, unread, pollHandle       — notification history
//   • toastQueue, toastActive                     — in-app toast queue
//   • _locGen                                     — fetch-staleness counter
//   • _gpsLoc                                     — last GPS-resolved loc
//
// Cross-file readers/writers, by file:
//   - alerts.js          reads  wxData, activeLocation, _locGen, mapAlertsOn
//                        writes wxData.alerts
//   - notifications.js   reads/writes seenIds, notifLog, unread, pushPerm,
//                        minSev, toastQueue/Active; reads wxData
//   - map.js             reads/writes lmap, baseTile, overlayTile,
//                        alertsMapLayer, curBase, curProd, curOp, mapAlertsOn
//                        (all declared below alongside activeLocation)
//   - marine.js          reads activeLocation, wxData, unit prefs;
//                        writes activeLocation._tideStation cache only
//
// `App` (window.App) is a thin debug namespace exposing read access to the
// live values via getters. Useful from the devtools console; not used by
// production code. See bottom of file.
// ─────────────────────────────────────────────────────────────────────────────

// ── First-run detection ──────────────────────────────────────────────────────
// Stored in localStorage once onboarding reaches step 2. Also check legacy
// keys so existing users who installed before the onboarding was added are
// never shown it again (they have settings / notification history already).
const ONBOARDED_KEY = 'noaa_onboarded_v1';
const _isFirstRun = (() => {
  try {
    if (localStorage.getItem(ONBOARDED_KEY))           return false;
    if (localStorage.getItem('noaa_settings_v1'))      return false;
    if (localStorage.getItem('noaa_notif_log'))        return false;
    if (localStorage.getItem('noaa_seen_alert_ids'))   return false;
    if (localStorage.getItem('noaa_saved_locs'))       return false;
    return true;
  } catch (_) { return false; }
})();

// D5: app-wide default-location constant. Override in one place for
// re-skinning the app to a different metro. The `wfo/gx/gy/zone` fields are
// the NWS gridpoint pre-resolved so the first fetchWx() doesn't have to
// do a /points/{lat},{lon} lookup before painting; if you change lat/lon
// without updating those, the app self-resolves on first render.
// Oklahoma City: the app previews itself with this location for anyone who
// skips the location step, so it should be somewhere with weather worth looking
// at — OKC sits in the middle of the plains severe-weather corridor, where the
// radar, the storm-tops product and the alert overlay all have something to
// show for most of the year.
const DEFAULT_LOC = Object.freeze({
  id: 'oklahoma-city', name: 'Oklahoma City, OK', subtitle: 'OK',
  lat: 35.4676, lon: -97.5164, wfo: 'OUN', gx: 97, gy: 94, zone: 'OKZ025', isHome: true,
});

// ── Location-card gradients ──────────────────────────────────────────────────
// The card background is the ONE value in this app that reaches
// `data-css-style`, which DYN_CSS_MAP (see below) documents as an unparsed
// cssText sink — the applier assigns it to `el.style.cssText` verbatim.
//
// So locations store a KEY into this frozen table, never a gradient string.
// The value interpolated into the attribute is therefore always one of these
// literals, and the sink is unreachable by construction rather than by
// remembering to escape at the call site.
//
// esc() would not have been enough on its own, which is why this is a table
// and not an esc() call: esc() escapes HTML metacharacters and so protects the
// attribute boundary, but a CSS payload needs none of those —
// "red;position:fixed;top:0;width:100vw;height:100vh;z-index:99999" contains no
// & < > " ' and passes through esc() completely untouched, straight into
// cssText. Verified against the live esc(). The attribute boundary was only
// half the exposure; a lookup closes both halves.
// Null-prototype, not a plain object literal. Both tables are indexed by a
// value out of localStorage, and a plain `{}` inherits Object.prototype — so
// `LOC_GRADIENTS['constructor']` would return the Object function (truthy!)
// and stringify "function Object() { [native code] }" into the cssText sink,
// and `['__proto__']` / `['toString']` likewise. Dropping the prototype means
// a bare `table[key]` lookup can only ever hit an own property or undefined,
// so the `|| default` fallback below actually holds for every possible key.
const LOC_GRADIENTS = Object.freeze(Object.assign(Object.create(null), {
  default:  'linear-gradient(135deg,#002244,#004488)',  // saved + searched locations
  gps:      'linear-gradient(135deg,#002244,#003366)',  // the "Current Location" card
  seattle:  'linear-gradient(135deg,#0D2235,#1A3A55)',
  newYork:  'linear-gradient(135deg,#0A1E40,#142E60)',
  phoenix:  'linear-gradient(135deg,#3D1000,#6A2000)',
}));

// Reverse table, for migrating installs that persisted a raw `grad` string
// before this change. Anything unrecognised falls back to `default`, so a
// tampered or truncated localStorage value can only ever select a literal.
// Null-prototype for the same reason as above — this one is indexed by the
// stored gradient string itself, which is even more directly external.
const _GRAD_TO_KEY = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(Object.entries(LOC_GRADIENTS).map(([key, css]) => [css, key]))
));

// One-way migration: raw `grad` → `gradKey`, then drop `grad` entirely so it
// can't be re-persisted. Safe to call on every load; no-ops once migrated.
function _migrateLocGradient(loc) {
  if (!loc || typeof loc !== 'object') return loc;
  if (!loc.gradKey && typeof loc.grad === 'string') {
    loc.gradKey = _GRAD_TO_KEY[loc.grad] || 'default';
  }
  delete loc.grad;
  return loc;
}

// Bundled "starter" cities — shown alongside the default location in the
// Locations list so a brand-new install isn't empty. The user can remove
// any of these via swipe-to-delete.
const SEED_LOCS = Object.freeze([
  { id: 'seattle',   name: 'Seattle, WA',    subtitle: 'WA', lat: 47.6062, lon: -122.3321, gradKey: 'seattle' },
  { id: 'new-york',  name: 'New York, NY',   subtitle: 'NY', lat: 40.7128, lon: -74.0060,  gradKey: 'newYork' },
  { id: 'phoenix',   name: 'Phoenix, AZ',    subtitle: 'AZ', lat: 33.4484, lon: -112.0740, gradKey: 'phoenix' },
]);

// Active location — mutable, updated when user switches locations.
// Cloned from DEFAULT_LOC so the immutable seed isn't shared across instances.
let activeLocation = { ...DEFAULT_LOC };

// Saved locations list. activeLocation is always SAVED_LOCS[0] at init (#10
// invariant). Seed cities are only added for returning users so a first-run
// install starts with a clean, empty Locations screen instead of presenting
// Seattle/New York/Phoenix to a user in Miami.
const SAVED_LOCS = [
  activeLocation,
  ...(_isFirstRun ? [] : SEED_LOCS.map(l => ({ ...l }))),
];
const locPointCache = {};

// Shared state (accessed by map.js, alerts.js, notifications.js)
// hourlyFailed: true when the NWS hourly endpoint returned an error on the last
// fetch — used to show an "unavailable" notice instead of a blank/spinner.
let wxData = { forecast: [], hourly: [], alerts: [], hourlyFailed: false };
let uTemp = 'F', uWind = 'mph', uVis = 'mi', snowLevelOffset = 2000;
let lmap = null, baseTile = null, overlayTile = null, alertsMapLayer = null;
let curBase = 'radar', curProd = 'bref_raw', curOp = 1.0, mapAlertsOn = true, alertOp = 1.0;
// Declared here, not in tropical.js: map.js restores saved prefs at load time,
// before tropical.js has run, and would hit the temporal dead zone.
let mapTropicalOn = true;
let mapWinterOn = true;      // same reason: winter.js loads after map.js
let mapAlertTiers = { warning: true, watch: true, advisory: true };
let pushPerm = 'default', minSev = 'Moderate';
// seenIds is persisted (capped at ~500 ids) so reloading the app doesn't
// re-fire toast notifications for alerts the user already saw.
// N65: bumped 200 → 500 to cover hurricane-week alert volume (the persisted
// JSON is still <50 KB at the cap so localStorage budget isn't a concern).
let seenIds = new Set();
try {
  const s = JSON.parse(localStorage.getItem('noaa_seen_alert_ids') || '[]');
  if (Array.isArray(s)) seenIds = new Set(s);
} catch (_) {}
function saveSeenIds() {
  try {
    const arr = [...seenIds].slice(-500);
    localStorage.setItem('noaa_seen_alert_ids', JSON.stringify(arr));
  } catch (_) {}
}
// ── Notification row identity ────────────────────────────────────────────────
// Every notifLog entry carries an `nid`, and that — not its timestamp — is what
// the history rows are keyed by in the DOM.
//
// The timestamp is not usable as a key: processIncoming() stamps a whole batch
// inside one synchronous forEach, so alerts arriving together (i.e. during an
// outbreak, when the list matters most) share a `time` to the millisecond.
// Two rows would then answer the same `[data-ntime="…"]` selector, and
// removeNotifItem's array lookup and its DOM lookup each took the FIRST match —
// which need not be the same row. The symptom was "I swiped away one alert and
// a different one disappeared".
//
// `id` alone wouldn't have fixed it either: fireTestNotif and fireBriefingNotif
// build theirs from Date.now(), so two in one millisecond still collide. A
// monotonic counter cannot.
let _notifSeq = 0;
function _nextNotifKey() { return 'n' + (++_notifSeq); }

// notifLog is persisted across reloads (capped at 60 entries) so notification
// history survives a page refresh. `time` is round-tripped through JSON as an
// ISO string — rehydrate to Date so existing date-formatting code works.
let notifLog = [], unread = 0, pollHandle = null;
try {
  const raw = JSON.parse(localStorage.getItem('noaa_notif_log') || '[]');
  if (Array.isArray(raw)) {
    notifLog = raw.map(n => ({ ...n, time: n.time ? new Date(n.time) : new Date() }));
    // Seed the counter above anything already persisted BEFORE backfilling, or
    // a fresh key could duplicate one restored from a previous session.
    for (const n of notifLog) {
      const seq = /^n(\d+)$/.exec(n.nid || '');
      if (seq) _notifSeq = Math.max(_notifSeq, +seq[1]);
    }
    // Entries written by a build that predates this carry no nid.
    for (const n of notifLog) if (!n.nid) n.nid = _nextNotifKey();
    unread = notifLog.filter(n => !n.read).length;
  }
} catch (_) {}
function saveNotifLog() {
  try {
    // Cap at 60 entries (already enforced on insert), but be defensive here too.
    const trimmed = notifLog.slice(0, 60);
    localStorage.setItem('noaa_notif_log', JSON.stringify(trimmed));
  } catch (_) {}
}
let toastQueue = [], toastActive = false;
// Most recent GPS-derived location. Module-scoped so we don't pollute window.
// Used by switchToLocation('gps') to resolve the "gps" pseudo-id.
let _gpsLoc = null;

// ── Settings persistence (#13) ───────────────────────────────────────────────
// Single localStorage record for all user-set toggles/selects so they survive
// reload. The DOM controls don't exist at script-load time (`boot` runs on
// DOMContentLoaded), so we keep an in-memory snapshot and apply both
// directions: load → snapshot → controls, and controls → snapshot → save.
const SETTINGS_KEY = 'noaa_settings_v1';
let _settings = {};
try {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  if (s && typeof s === 'object') _settings = s;
} catch (_) {}

// Set while applyStoredSettings is running so the change-handlers it calls
// (onQuietChange / onBriefingChange / etc.) don't re-write the same values
// back to localStorage. Also future-proofs against a handler that reads then
// writes — partial state can't escape during hydration. (B2)
let _applyingSettings = false;

// Apply stored settings to the DOM (called from boot() after the tree exists).
function applyStoredSettings() {
  _applyingSettings = true;
  const s = _settings;
  const set = (id, val) => { const e = document.getElementById(id); if (e && val != null) {
    if (e.type === 'checkbox') e.checked = !!val; else e.value = String(val);
  }};
  set('master-tog',    s.master);
  set('poll-sel',      s.poll);
  set('quiet-tog',     s.quiet);
  set('q-from',        s.qFrom);
  set('q-to',          s.qTo);
  set('override-tog',  s.override);
  set('briefing-tog',  s.briefing);
  set('briefing-time', s.briefingTime);
  if (s.minSev) {
    minSev = s.minSev;
    document.querySelectorAll('#sev-chips .sev-chip').forEach(b => {
      const isSel = b.classList.contains(s.minSev.toLowerCase());
      b.classList.toggle('sel', isSel);
      b.textContent = b.textContent.replace(' ✓', '') + (isSel ? ' ✓' : '');
    });
  }
  if (s.uTemp) uTemp = s.uTemp;
  if (s.uWind) uWind = s.uWind;
  if (s.uVis)  uVis  = s.uVis;
  if (s.snowLevelOffset != null) snowLevelOffset = s.snowLevelOffset;
  const sloSel = document.getElementById('snow-level-offset-sel');
  if (sloSel) sloSel.value = snowLevelOffset;
  // Reflect unit chips
  const flag = (id, on) => { const e = document.getElementById(id); if (e) e.classList.toggle('sel', on); };
  flag('uchip-F',    uTemp === 'F'); flag('uchip-C', uTemp === 'C');
  flag('uchip-mph',  uWind === 'mph'); flag('uchip-kmh', uWind === 'kmh');
  flag('uchip-mi',   uVis === 'mi');   flag('uchip-km',  uVis === 'km');
  // Reflect dependent rows (opacity / pointer-events)
  onQuietChange();
  onBriefingChange();
  _applyingSettings = false;
}

// Save current DOM + module state. Cheap and called from every setting handler.
function saveSettings() {
  // B2: during applyStoredSettings the handlers we call indirectly trigger
  // saveSettings — short-circuit those re-saves so we don't write the same
  // record back 5-10 times on every boot, and so a partial state read can't
  // escape mid-hydration.
  if (_applyingSettings) return;
  try {
    const get = (id, fb) => {
      const e = document.getElementById(id); if (!e) return fb;
      return e.type === 'checkbox' ? !!e.checked : e.value;
    };
    // `+v || fallback` would turn a legitimate 0 into the fallback — and 0 is
    // Midnight in the quiet-hours "from" list, which therefore silently came
    // back as 10 PM on every relaunch (and was synced to the relay that way).
    const num = (v, fb) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; };
    const s = {
      master:       get('master-tog', true),
      poll:        num(get('poll-sel', 10), 10),
      minSev,
      quiet:        get('quiet-tog', false),
      qFrom:       num(get('q-from', 22), 22),
      qTo:         num(get('q-to', 7), 7),
      override:     get('override-tog', true),
      briefing:     get('briefing-tog', false),
      briefingTime: num(get('briefing-time', 7), 7),
      uTemp, uWind, uVis, snowLevelOffset,
    };
    _settings = s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (_) {}
}

// ── Data freshness indicator ─────────────────────────────────────────────────
// Must be declared before tickClock() runs (which is invoked at script load),
// otherwise the freshness-refresh callback hits a TDZ on `_lastWxUpdate`.
let _lastWxUpdate = null;
// The "normal" NWS office text for the weather screen status strip.
// Stored here so refreshLiveChips() can restore it when coming back from stale.
let _baseStripText = '';
// Stale threshold: 15 min. NWS observations update every ~10 min so 15 min
// gives headroom before alerting the user (and the poll timer refreshes
// weather every 5-30 min, so this mostly fires after network failures).
const STALE_THRESHOLD_MIN = 15;

// ── Clock ────────────────────────────────────────────────────────────────────
function tickClock() {
  refreshLiveChips();
}
let _clockHandle = setInterval(tickClock, TIMINGS.CLOCK_TICK_MS);

// Option C freshness indicator:
//   • Chips always read "LIVE" — only the dot changes (pulsing red → static amber)
//   • The weather screen status strip swaps to "UPDATED X MIN AGO · TAP TO REFRESH"
//     when stale, and restores the NWS office text when fresh again.
function refreshLiveChips() {
  const chips = document.querySelectorAll('.live-chip');
  if (!chips.length) return;

  let stale = false;
  let ageMin = 0;
  if (_lastWxUpdate) {
    ageMin = Math.floor((Date.now() - _lastWxUpdate) / 60000);
    stale = ageMin >= STALE_THRESHOLD_MIN;
  }

  // Chips — text is always "LIVE"; .stale class controls dot color/animation
  chips.forEach(chip => {
    if (chip._lastStale === stale) return; // #24: skip no-op writes
    chip._lastStale = stale;
    const dot = chip.querySelector('.live-dot');
    chip.textContent = '';
    if (dot) chip.appendChild(dot);
    chip.appendChild(document.createTextNode('LIVE'));
    chip.classList.toggle('stale', stale);
  });

  // Status strip — swap text on the weather screen only
  const stripEl = document.getElementById('hdr-strip-txt');
  if (!stripEl) return;
  if (stale) {
    const msg = 'UPDATED ' + ageMin + ' MIN AGO \xb7 TAP TO REFRESH';
    if (stripEl._staleMsg !== msg) {
      stripEl._staleMsg = msg;
      stripEl.textContent = msg;
      stripEl.style.cursor = 'pointer';
    }
  } else if (stripEl._staleMsg) {
    // Coming back from stale — restore the NWS office text
    stripEl._staleMsg = null;
    if (_baseStripText) stripEl.textContent = _baseStripText;
    stripEl.style.cursor = '';
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────

function openSettings() {
  // Settings is a tab — the ⚙️ header buttons on every screen call this.
  goNav('s-settings', null);
}

// Bottom-nav definition — 4 top-level tabs (items 11–13).
// Screens removed from the nav bar:
//   • s-forecast — the "Details" screen, accessed via "Details ›" on the
//                  Weather screen; also hosts the Marine & Tides section.
//   • s-loc      — accessed by tapping the location name in any header
// Locations promoted to 5th tab — switching cities is a daily power-user
// action that deserves a nav slot. Settings is still reachable via the ⚙️
// gear icon present in every screen header. Hourly replaced Marine in the nav —
// the hourly forecast is one of the most-checked views in any weather app,
// while marine conditions now live one tap deeper inside the Details screen.
const BNAV_ITEMS = [
  { screen: 's-wx',       label: 'Weather'   },
  { screen: 's-map',      label: 'Map'       },
  { screen: 's-hourly',   label: 'Hourly'    },
  { screen: 's-alerts',   label: 'Alerts',   badge: true },
  { screen: 's-loc',      label: 'Locations' },
];

// Screens not in BNAV_ITEMS still need a parent tab to highlight when visited.
// Maps child screenId → the tab that should appear "active" in the nav.
const BNAV_PARENT = {
  's-forecast': 's-wx', // Details (7-day forecast + Marine) — highlight Weather
  's-air':      's-wx', // Air Quality, opened from the Weather tile — highlight Weather
  's-uv':       's-wx', // UV Index, opened from the Weather tile — highlight Weather
  's-spc':      's-wx', // Storm Center (SPC + text products) — highlight Weather
  's-settings': 's-loc', // Settings accessed via gear — highlight Locations tab
};

// Sprite injected once at boot. Hidden via aria-hidden + 0×0 size so it
// doesn't take up layout space.
const _BNAV_SPRITE = `
<svg class="_s-bb6a43" width="0" height="0" aria-hidden="true">
  <defs>
    <symbol id="bnav-s-wx" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="10" cy="7" r="3"/><path d="M10 2v1M10 11v1M5.5 4.5l.7.7M13.8 4.5l-.7.7M3 7h1M16 7h1"/><path d="M9 18.5H7a4.5 4.5 0 0 1-.5-9 5 5 0 0 1 9.5 1 3 3 0 0 1 2.5 3 3 3 0 0 1-3 3H9"/>
    </symbol>
    <symbol id="bnav-s-map" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
    </symbol>
    <symbol id="bnav-s-alerts" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.3 3.5 2.2 17.5A2 2 0 0 0 4 20.5h16a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/>
    </symbol>
    <symbol id="bnav-s-details" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 8c.6.5 1.2 1 2.5 1C7 9 7 7 9.5 7c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 14c.6.5 1.2 1 2.5 1C7 15 7 13 9.5 13c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 20c.6.5 1.2 1 2.5 1C7 21 7 19 9.5 19c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>
    </symbol>
    <symbol id="bnav-s-hourly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
    </symbol>
    <symbol id="bnav-s-settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </symbol>
    <symbol id="bnav-s-loc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/>
    </symbol>
    <symbol id="si-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </symbol>
    <symbol id="si-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </symbol>
    <symbol id="si-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </symbol>
    <symbol id="si-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </symbol>
    <symbol id="si-alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </symbol>
    <symbol id="si-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </symbol>
    <!-- ── Metric-tile icons — same stroke language as the nav/settings set above.
         Replaces the emoji that used to label the weather tiles (item #13). ── -->
    <symbol id="si-wind" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 8h10.5a2.5 2.5 0 1 0-2.5-2.6"/><path d="M3 12h15.5a2.6 2.6 0 1 1-2.6 2.6"/><path d="M3 16h8a2 2 0 1 1-2 2.1"/>
    </symbol>
    <symbol id="si-uv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4.2"/><line x1="12" y1="1.5" x2="12" y2="3.6"/><line x1="12" y1="20.4" x2="12" y2="22.5"/><line x1="4.3" y1="4.3" x2="5.8" y2="5.8"/><line x1="18.2" y1="18.2" x2="19.7" y2="19.7"/><line x1="1.5" y1="12" x2="3.6" y2="12"/><line x1="20.4" y1="12" x2="22.5" y2="12"/><line x1="4.3" y1="19.7" x2="5.8" y2="18.2"/><line x1="18.2" y1="5.8" x2="19.7" y2="4.3"/>
    </symbol>
    <symbol id="si-precip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 15.5a3.8 3.8 0 0 1-.5-7.57 5 5 0 0 1 9.65-1.2A3.5 3.5 0 0 1 17 13.5"/><line x1="8.5" y1="18" x2="7.5" y2="21"/><line x1="12.5" y1="18" x2="11.5" y2="21.5"/><line x1="16.5" y1="18" x2="15.5" y2="21"/>
    </symbol>
    <symbol id="si-humidity" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2.7s6 6.4 6 10.8a6 6 0 0 1-12 0c0-4.4 6-10.8 6-10.8z"/>
    </symbol>
    <symbol id="si-thermo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0z"/>
    </symbol>
    <symbol id="si-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>
    </symbol>
    <symbol id="si-air" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7h11.5a2.4 2.4 0 1 0-2.4-2.5"/><path d="M3 12h16a2.6 2.6 0 1 1-2.6 2.6"/><path d="M3 17h8.5a2.1 2.1 0 1 1-2.1 2.1"/>
    </symbol>
    <symbol id="si-dew" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3.5s5 5.4 5 9.1a5 5 0 0 1-10 0C7 8.9 12 3.5 12 3.5z"/><line x1="4.5" y1="20.8" x2="19.5" y2="20.8"/>
    </symbol>
    <symbol id="si-snow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="2.5" x2="12" y2="21.5"/><line x1="3.8" y1="7.2" x2="20.2" y2="16.8"/><line x1="20.2" y1="7.2" x2="3.8" y2="16.8"/>
    </symbol>
    <symbol id="si-cloud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 18a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.32A3.75 3.75 0 0 1 17.25 18z"/>
    </symbol>
    <symbol id="si-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20.3 4.6 13a4.7 4.7 0 0 1 6.6-6.7l.8.78.8-.78A4.7 4.7 0 0 1 19.4 13z"/>
    </symbol>
  </defs>
</svg>`;

// Small inline icon for the weather metric-tile labels. Pulls from the sprite
// above so the tiles speak the same stroke-icon language as the rest of the UI
// instead of mixed emoji (item #13).
function detlIcon(id) {
  return `<svg class="detl-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;
}

// Section-header / inline weather glyph from the shared si-* SVG sprite. Used so
// the Hourly tab's labels match the line-icon language used everywhere else in
// the app instead of emoji. `cls` defaults to the clbl header size.
function clblIcon(id, cls) {
  return `<svg class="${cls || 'clbl-ico'}" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function _injectBnavSprite() {
  if (document.getElementById('bnav-s-wx')) return; // already injected
  const holder = document.createElement('div');
  holder.innerHTML = _BNAV_SPRITE;
  document.body.appendChild(holder.firstElementChild);
}

function bnavHTML(activeScreen) {
  // Sub-screens (s-hourly, s-forecast, s-loc) are not in BNAV_ITEMS but should
  // highlight their parent tab (Weather) so the nav always shows one active item.
  const activeForNav = BNAV_PARENT[activeScreen] || activeScreen;
  return BNAV_ITEMS.map(it => {
    const isActive = it.screen === activeForNav;
    // N15: aria-current="page" tells screen readers which tab is currently selected.
    return `<button class="nbtn${isActive ? ' active' : ''}"${isActive ? ' aria-current="page"' : ''} data-click-action="goNav" data-screen="${it.screen}">
    <span class="nb-ico"><svg width="24" height="24" aria-hidden="true"><use href="#bnav-${it.screen}"/></svg></span>${it.badge ? '<span class="nav-badge"></span>' : ''}<span class="nl">${it.label}</span>
  </button>`;
  }).join('');
}

function buildBottomNavs() {
  _injectBnavSprite();
  const activeId = document.querySelector('.screen.active')?.id || 's-wx';
  document.querySelectorAll('.bnav').forEach(nav => {
    const screenId = nav.closest('.screen')?.id || activeId;
    nav.innerHTML = bnavHTML(screenId);
  });
}

// #27: the same search row used to be inlined into six screens of index.html.
// It now lives here once and is rendered into every `.global-search-row`
// placeholder at boot. 6.2 KB shaved off the static HTML; nothing else changes.
const _GSR_HTML = `
  <div class="gsr-inner">
    <svg class="gsr-srch-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input class="gsr-input" type="search" inputmode="search" autocomplete="off" placeholder="City, State or ZIP…" aria-label="Search city, state, or ZIP" data-input-action="onGlobalSearch" data-keydown-action="onGlobalSearchKey" data-focusin-action="onGlobalSearchFocus"/>
    <button class="gsr-gps" data-click-action="useGPS" title="Use current location" aria-label="Use current location"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/></svg></button>
  </div>
  <div class="gsr-drop" role="listbox" aria-label="Search suggestions"></div>`;
function renderSearchRows() {
  document.querySelectorAll('.global-search-row').forEach(el => {
    if (el.children.length) return; // already populated
    el.innerHTML = _GSR_HTML;
  });
}

function goNav(id, btn) {
  // Pause radar/sat animation when leaving the Map screen
  if (document.getElementById('s-map')?.classList.contains('active') && id !== 's-map'
      && typeof pauseAnimForBackground === 'function') {
    pauseAnimForBackground();
  }
  // Alerts pinned from the map are for the screen you're on, not the app —
  // drop them the moment you leave.
  if (id !== 's-alerts' && typeof clearPinnedMapAlerts === 'function') clearPinnedMapAlerts();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const _screenEl = document.getElementById(id);
  if (_screenEl) _screenEl.classList.add('active');
  // Activate the matching button within the now-visible screen's own bnav
  // (each screen has its own bnav, so we scope to the destination screen).
  const destNav = document.querySelector(`#${id} .bnav`);
  if (destNav) {
    destNav.querySelectorAll('.nbtn').forEach(b => {
      b.classList.remove('active');
      b.removeAttribute('aria-current');   // N15: clear stale a11y state
    });
    // Use data-screen + BNAV_PARENT to find the correct tab to highlight.
    // Previously used getAttribute('onclick') which broke with data-attribute nav.
    const navTarget = BNAV_PARENT[id] || id;
    const target = btn && destNav.contains(btn)
      ? btn
      : [...destNav.querySelectorAll('.nbtn')].find(b => b.dataset.screen === navTarget);
    if (target) { target.classList.add('active'); target.setAttribute('aria-current', 'page'); }
  }
  if (id === 's-map') {
    requestAnimationFrame(() => requestAnimationFrame(initMap));
    // Phase 3 (iPad): paint the side forecast pane from already-fetched data.
    // No-op on phones/portrait (guarded by _mapDetailMQ inside).
    renderMapDetail();
    // Resume animation when returning to the Map screen
    if (typeof resumeAnimAfterBackground === 'function') resumeAnimAfterBackground();
  }
  // renderAlerts() too: the cards outlive the screen, so without it a map alert
  // pinned on a previous visit is still on screen after the pin was dropped.
  // _setInnerIfChanged() makes the no-change case a no-op.
  if (id === 's-alerts') { renderAlerts(); renderNotifList(); markRead(); }
  if (id === 's-settings') renderPermBanner();
  if (id === 's-loc') renderLocations();
  if (id === 's-hourly') renderHourly();
  // Details screen stacks three sections: the 7-day forecast, Detailed
  // Conditions (every location), and Marine & Tides (coastal only).
  if (id === 's-forecast') { renderExtendedForecast(); renderConditions(); renderMarine(); }
  if (id === 's-air') renderAirQuality();
  if (id === 's-uv') renderUVIndex();
  if (id === 's-spc') renderStormCenter();
  // Badge state may have changed (e.g. on s-alerts markRead zeroes unread).
  if (typeof syncNotifBadge === 'function') syncNotifBadge();
  try { sessionStorage.setItem(SCREEN_KEY, id); } catch (_) {}
}

// When iOS kills the WebView's content process (memory pressure, often while
// a radar loop runs), Capacitor reloads the page and the app used to come
// back on the Weather tab, which reads as a crash. sessionStorage survives
// that reload but not a fresh launch, so only an unplanned reload (or a
// browser refresh on the web build) returns to the screen that was open.
const SCREEN_KEY = 'noaa_screen';
function _restoreScreen() {
  let id;
  try { id = sessionStorage.getItem(SCREEN_KEY); } catch (_) { return; }
  if (id && id !== 's-wx' && /^s-[a-z]+$/.test(id) && document.getElementById(id)) goNav(id, null);
}

// ── Utilities ────────────────────────────────────────────────────────────────
// Great-circle distance between two lat/lon points, in statute miles.
// Shared by fetchCurrentObs (station→user distance) and marine.js
// (station-finder loop). #33: previously duplicated in both places.
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Escape strings before interpolating into innerHTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Location-switch generation counter ───────────────────────────────────────
// Every call to setActiveLocation() bumps this. Long-running fetchers capture
// the current value at start; if it has moved by the time the fetch resolves,
// the response is for a previous location and we must not mutate the UI.
// (Issue #12 — without this, switching locations mid-fetch races and the new
// screen briefly displays the previous location's data.)
let _locGen = 0;
function _bumpLocGen() { return ++_locGen; }

// ─────────────────────────────────────────────────────────────────────────────
// CSP-safe dynamic-style applier
//
// With style-src dropping 'unsafe-inline', a template like
//   <div style="background:${col}">
// would be blocked at parse time. Instead we emit
//   <div data-css-bg="${col}">
// and the applier walks the rendered subtree and sets the style via
// `el.style.setProperty(...)` — CSSOM assignments are explicitly allowed by
// CSP. Supported attributes are listed in DYN_CSS_MAP; each maps to a CSS
// property name. `data-css-style` is the catch-all for multi-property snippets
// (we keep those rare).
// ─────────────────────────────────────────────────────────────────────────────
// N24: frozen so the matching `_DYN_CSS_SELECTOR` below — computed once at
// script-load — stays accurate. New attributes must be added here at edit
// time, not mutated in at runtime, or `applyDynamicStyles` won't see them.
const DYN_CSS_MAP = Object.freeze({
  'data-css-bg':        'background',
  'data-css-color':     'color',
  'data-css-display':   'display',
  'data-css-width':     'width',
  'data-css-height':    'height',
  'data-css-left':      'left',
  'data-css-top':       'top',
  'data-css-transform': 'transform',
  'data-css-fontsize':  'font-size',
  // Raw cssText fragment, appended verbatim via el.style.cssText.
  // SECURITY: this is the one attribute here that is not a single escaped
  // value — it is an unparsed CSS sink. Only ever feed it literals authored in
  // this codebase (or values computed from them, e.g. a gradient string).
  // Never interpolate anything derived from an API response, a saved location
  // name, or any other external input: CSP blocks script from CSS, but a
  // crafted fragment can still reposition or overlay UI, and a `url()` inside
  // it becomes a fetch. Everything data-driven belongs in one of the typed
  // attributes above, which go through setProperty as a single value.
  'data-css-style':     null,
});
const _DYN_CSS_SELECTOR = Object.keys(DYN_CSS_MAP).map(a => `[${a}]`).join(',');

function applyDynamicStyles(root) {
  if (!root) return;
  const apply = el => {
    if (!el.attributes) return;
    for (const attr of el.attributes) {
      if (!(attr.name in DYN_CSS_MAP)) continue;
      const prop = DYN_CSS_MAP[attr.name];
      const v = attr.value;
      if (prop === null) {
        // Append raw cssText (CSSOM cssText assignment is allowed by CSP).
        el.style.cssText = (el.style.cssText ? el.style.cssText + ';' : '') + v;
      } else {
        el.style.setProperty(prop, v);
      }
    }
  };
  apply(root);
  if (root.querySelectorAll) root.querySelectorAll(_DYN_CSS_SELECTOR).forEach(apply);
}

// Roots processed synchronously by _setInnerIfChanged this tick. The
// MutationObserver checks this set so it doesn't re-apply styles to nodes
// that applyDynamicStyles already handled — eliminating the double-pass.
const _recentRoots = new Set();

// MutationObserver safety net for content the renderers don't route through
// _setInnerIfChanged — Leaflet popups, marine sub-section direct innerHTML
// writes, dynamically created elements.
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver(records => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Skip if this node is inside a root that _setInnerIfChanged just
        // processed — applyDynamicStyles already covered the whole subtree.
        let ancestor = node.parentElement, skip = false;
        while (ancestor) {
          if (_recentRoots.has(ancestor)) { skip = true; break; }
          ancestor = ancestor.parentElement;
        }
        if (!skip) applyDynamicStyles(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

// Assign innerHTML only if it differs from the last value we wrote into this
// element. Identical assignments still tear down + recreate the subtree, force
// layout/paint, and reload <img> sources — so poll-induced no-op renders used
// to be surprisingly expensive (#18). The check itself is a string equality
// against a stashed copy, which is cheap relative to the DOM work it avoids.
function _setInnerIfChanged(el, html) {
  if (!el) return false;
  if (el._lastHtml === html) return false;
  el._lastHtml = html;
  el.innerHTML = html;
  // Apply data-css-* on the new subtree synchronously (avoids the microtask
  // flicker where new DOM has the attrs but no style yet).
  applyDynamicStyles(el);
  // Mark root so the MutationObserver skips re-processing its children.
  _recentRoots.add(el);
  requestAnimationFrame(() => _recentRoots.delete(el));
  return true;
}

// ── Keyboard activation helper for click-divs (Enter / Space) ────────────────
// Inline `onclick` is hard to make keyboard-accessible without bringing in
// jQuery-style delegation. This helper lets us add a single onkeydown to any
// click-div so screen-reader and keyboard users can activate it (issue #16).
// `el` is the element carrying data-keydown-action, handed to us by
// _dispatchEvent. It is NOT e.currentTarget: the dispatcher listens on
// `document`, so currentTarget is always the document during the handler, and
// `document.click()` is not a function — this used to throw on every Space or
// Enter, which is why keyboard activation of the role="button" divs (location
// cards, day rows, metric tiles, the marine teaser) never actually worked.
function _kbdClick(e, el) {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    const target = el || e.currentTarget;
    if (target && typeof target.click === 'function') target.click();
  }
}

// Image with a sibling fallback element revealed if the image fails to load.
// The onerror handler is STATIC (no template interpolation) so the fallback
// text never has to be safe for both HTML and a JS string literal — it goes
// through esc() into a normal DOM node. Pass an empty/null url to render only
// the fallback (visible).
function imgFb(url, fbText, imgCls, fbCls, imgStyle, fbStyle) {
  // CSP: dynamic styles are emitted as data-css-style attributes which the
  // CSSOM applier (top of file) translates to el.style.cssText.
  const safe = esc(fbText);
  if (!url) {
    const c = fbCls ? ` class="${fbCls}"` : '';
    const s = fbStyle ? ` data-css-style="${fbStyle}"` : '';
    return `<span${c}${s}>${safe}</span>`;
  }
  const ic = imgCls   ? ` class="${imgCls}"` : '';
  const is = imgStyle ? ` data-css-style="${imgStyle}"` : '';
  const fc = fbCls    ? ` class="${fbCls}"` : '';
  // Fallback span starts hidden; data-img-fb's error handler reveals it.
  const fs = fbStyle ? `${fbStyle};display:none` : 'display:none';
  // data-img-fb is picked up by the capture-phase error listener at the top
  // of this file — it hides this img and reveals the next sibling span.
  return `<img${ic}${is} src="${esc(url)}" loading="lazy" data-img-fb/>`
    + `<span${fc} data-css-style="${fs}">${safe}</span>`;
}

// fetch() wrapper for api.weather.gov. Use this for every api.weather.gov call.
//
// ── Where the NWS User-Agent actually comes from ─────────────────────────────
// NWS asks all clients to identify themselves in the User-Agent so they can
// reach out about abusive traffic. We do identify ourselves — but NOT via the
// header set below, which never reaches them on any platform:
//
//   * Web/PWA: `User-Agent` is a forbidden header name, so the browser silently
//     drops the override and sends its own. Measured, not assumed: a fetch with
//     a sentinel UA arrives at a local echo server carrying the browser's real
//     UA, while the `Accept` header on the same request arrives verbatim.
//   * Native iOS: same outcome, by a longer route. CapacitorHttp (enabled in
//     capacitor.config.json) replaces window.fetch, and in Capacitor 8 a GET is
//     re-pointed at a same-origin interceptor URL and issued with the REAL
//     fetch — so WebKit strips the header before the native layer ever sees it,
//     and WebViewAssetHandler.swift then copies urlSchemeTask.request verbatim.
//     native-bridge.js does carry a header-preservation workaround, but it is
//     gated on `platform === 'android'`.
//
// What genuinely reaches api.weather.gov is `appendUserAgent` in
// capacitor.config.json, which appends our identifier to the WebView-wide UA —
// that string is on urlSchemeTask.request and survives the whole path. It also
// covers the map's <img> tile loads, which can carry no per-request header at
// all. So: to change how we identify to NWS, edit capacitor.config.json and
// rebuild. Editing NWS_USER_AGENT alone changes nothing on device.
//
// The constant and the header assignment are kept anyway — they cost nothing,
// they document the intent in the place a reader looks for it, and they would
// carry if this ever runs somewhere `User-Agent` isn't forbidden. Just don't
// mistake them for the mechanism.
//
// `Accept` is the half of this wrapper that does travel, on both platforms.
//
// C3: every call gets an AbortSignal.timeout(10000) so a flaky-4G stall can't
// hang the UI forever. Callers that pass their own `signal` still win — we
// only inject the timeout when no signal was provided.
//
// NWS asks for an app version + a contact (email or URL) so they can reach out
// about problematic traffic. We use the public project URL rather than a
// personal email so nothing personal ships in the bundle or headers.
//
// The version lives in BOTH strings and they are kept in step by tooling:
// `release-sync.mjs set-version` rewrites appendUserAgent alongside this file,
// and `release-sync.mjs check` fails the build if they drift or if the UA loses
// its version segment. (Before that, appendUserAgent carried no version at all
// — so the version NWS asks for had never actually been sent, because the only
// string carrying it was the one that gets dropped.)
const NWS_USER_AGENT = 'NOAAWeatherUnofficial/' + APP_VERSION
  + ' (Capacitor iOS PWA; +https://nelsok-dev.github.io/noaa-weather-privacy/)';
const NWS_TIMEOUT_MS = 10_000;
// Identical GET requests that overlap share one network call. renderWx() runs
// three times during a cold start (cached paint, fresh forecast, alerts), and
// each run kicks off the UV, AQI, AFD, nowcast, climate and winter fetches,
// whose caches only fill once a response lands. Measured on 2026-10-01: 45
// requests at boot, most of them sent two or three times. Each caller gets its
// own clone of the response. A successful response is also reused for
// DEDUPE_HOLD_MS after it lands, because the next render's request often
// starts a few ms after the previous one finished, before the caller's own
// cache is written. Polls run minutes apart, so they still go to the network,
// and a failure is never held: a retry always goes out again. Nothing in the
// app aborts a request by hand (only AbortSignal.timeout), so sharing the first
// caller's signal cannot cancel anyone else's request early.
const DEDUPE_HOLD_MS = 3000;
function _dedupeFetch(baseFetch) {
  const inflight = new Map();
  return function (input, init) {
    const method = (init?.method || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    if (method !== 'GET' || !url || init?.body) return baseFetch(input, init);
    const key = url + '\n' + JSON.stringify(init?.headers || {});
    let p = inflight.get(key);
    if (!p) {
      p = baseFetch(input, init);
      inflight.set(key, p);
      const drop = () => { if (inflight.get(key) === p) inflight.delete(key); };
      p.then(r => { if (r && r.ok) setTimeout(drop, DEDUPE_HOLD_MS); else drop(); }, drop);
    }
    return p.then(r => r.clone());
  };
}
if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
  window.fetch = _dedupeFetch(window.fetch.bind(window));
}

function nwsFetch(url, opts) {
  const o = opts ? { ...opts } : {};
  o.headers = { ...(o.headers || {}), 'User-Agent': NWS_USER_AGENT, 'Accept': 'application/geo+json,application/json;q=0.9,*/*;q=0.5' };
  if (!o.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    o.signal = AbortSignal.timeout(NWS_TIMEOUT_MS);
  }
  return fetch(url, o);
}

// Conversion constants — used app-wide so they live in one place.
const UNIT = {
  KMH_PER_MPH: 1.60934,
  M_PER_MI:    1609.344,
  M_PER_FT:    0.3048,
  FT_PER_M:    3.28084,
  MM_PER_IN:   25.4,
};

// Resolve a user-facing display name for a location.
// Prefers the user's chosen `name`; falls back to NWS reference city/state
// when the name is generic (e.g. "Current Location" from GPS).
function displayName(loc) {
  const n = (loc?.name || '').trim();
  const isGeneric = !n || /current location/i.test(n);
  if (!isGeneric) return n;
  if (loc?.relCity && loc?.relState) return loc.relCity + ', ' + loc.relState;
  return n;
}

// Full state/territory names → their USPS two-letter codes. The geocoders spell
// states out ("Seattle, Washington"); the NWS relativeLocation path already
// gives "WA". Keyed lowercase so either casing matches.
const US_STATE_ABBR = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'district of columbia': 'DC', 'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI',
  'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME',
  'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
  'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE',
  'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX',
  'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
  'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
  // Territories NWS forecasts cover (see GEO_COUNTRIES).
  'puerto rico': 'PR', 'virgin islands': 'VI', 'united states virgin islands': 'VI',
  'u.s. virgin islands': 'VI', 'us virgin islands': 'VI', 'guam': 'GU',
  'american samoa': 'AS', 'northern mariana islands': 'MP',
  'commonwealth of the northern mariana islands': 'MP',
};

// "Seattle, Washington" → "Seattle, WA". Used where the label has to fit a
// notification banner rather than a screen — iOS truncates a push body hard,
// and the spelled-out state was eating the room the forecast itself needs.
// Only the trailing comma-separated segment is abbreviated, so a bare state
// name stays spelled out ("WA" alone reads as a code, not a place) and a name
// that already ends in a two-letter code passes through untouched.
function abbrevState(name) {
  const s = String(name || '').trim();
  const i = s.lastIndexOf(',');
  if (i < 0) return s;
  const head = s.slice(0, i).trim();
  const tail = s.slice(i + 1).trim();
  const abbr = US_STATE_ABBR[tail.toLowerCase()];
  return abbr && head ? `${head}, ${abbr}` : s;
}

// The location label as the Day Ahead briefing should say it — short, because
// it shares a single banner line with the high, low, conditions and wind.
// Both briefing paths use it: fireBriefingNotif() for the in-app/web copy and
// _briefingSettings() for the `loc_name` the relay puts in the real push, so
// the two keep reading identically.
function briefingPlaceName(loc) {
  return abbrevState(displayName(loc));
}

// Shorten verbose NWS station names — "Seattle, Seattle-Tacoma International Airport"
// becomes "Seattle-Tacoma Intl Apt".
function shortenStationName(raw) {
  const parts = (raw || '').split(',');
  let n = (parts.length > 1 ? parts.slice(1).join(',') : raw || '').trim();
  return n
    .replace(/\bInternational\b/gi, 'Intl')
    .replace(/\bRegional\b/gi, 'Reg')
    .replace(/\bAirport\b/gi, 'Apt')
    .replace(/\bMunicipal\b/gi, 'Muni')
    .replace(/\s+/g, ' ').trim();
}

// NWS draws the chance of precipitation INTO the icon image from the number in
// its URL ("…/night/rain,30?size=medium" renders "30%"). Split periods carry
// two halves ("rain,30/rain,50"), and only one is kept to avoid a cramped
// "30%50%" composite. It used to keep the FIRST half blindly, so the image said
// 30% while the text beside it gave the period's chance, 50% (Seattle and
// Oklahoma City, 2026-09-25). Now it keeps the half carrying the precipitation
// and stamps it with the number the app displays (popMention), so the picture
// and the text can never disagree. A chance the app doesn't mention (under 20%)
// is dropped from the image too.
function nwsIconUrl(p, sz) {
  if (!p || !p.icon) return null;
  const base = p.icon.replace(/[?&]size=\w+/, '');
  const m = base.match(/^(.*\/(?:day|night)\/)(.+)$/);
  if (!m) return base + '?size=' + (sz || 'medium');
  const halves = m[2].split('/');
  let pick = halves[0], pickN = -1;
  for (const h of halves) {
    const n = parseInt(h.split(',')[1], 10);
    if (Number.isFinite(n) && n > pickN) { pick = h; pickN = n; }
  }
  const cond = pick.split(',')[0];
  const pop = popMention(p.probabilityOfPrecipitation?.value);
  // Only on a half NWS itself labelled with a chance — never on "few" or "bkn".
  const label = pickN >= 0 && pop != null ? ',' + pop : '';
  return m[1] + cond + label + '?size=' + (sz || 'medium');
}

function iconFb(sf, d) {
  const f = (sf || '').toLowerCase();
  if (f.includes('thunder')) return '⛈';
  if (f.includes('rain')) return '🌦';
  if (f.includes('snow') || f.includes('blizzard')) return '🌨';
  if (f.includes('fog')) return '🌫';
  if (f.includes('mostly cloudy') || f.includes('overcast')) return d ? '🌥' : '☁️';
  if (f.includes('partly')) return d ? '⛅' : '🌙';
  if (f.includes('sunny') || f.includes('clear')) return d ? '☀️' : '🌙';
  return d ? '🌤' : '🌙';
}

function alertNWSIcon(ev) {
  const e = (ev || '').toLowerCase();
  if (e.includes('tornado')) return 'https://api.weather.gov/icons/land/day/tornado?size=small';
  if (e.includes('thunder')) return 'https://api.weather.gov/icons/land/day/tsra?size=small';
  if (e.includes('flood')) return 'https://api.weather.gov/icons/land/day/flood?size=small';
  if (e.includes('wind')) return 'https://api.weather.gov/icons/land/day/wind_bkn?size=small';
  if (e.includes('snow') || e.includes('winter') || e.includes('blizzard')) return 'https://api.weather.gov/icons/land/day/blizzard?size=small';
  if (e.includes('ice')) return 'https://api.weather.gov/icons/land/day/sleet?size=small';
  if (e.includes('fog')) return 'https://api.weather.gov/icons/land/day/fog?size=small';
  if (e.includes('heat')) return 'https://api.weather.gov/icons/land/day/hot?size=small';
  return null;
}

function sg(sf, d) {
  const f = (sf || '').toLowerCase();
  if (!d) return 'linear-gradient(180deg,#000D1A,#001428,#00203A)';
  if (f.includes('thunder')) return 'linear-gradient(180deg,#0A1520,#182535,#263548)';
  if (f.includes('rain')) return 'linear-gradient(180deg,#082033,#123048,#1E4560)';
  if (f.includes('cloudy') || f.includes('overcast')) return 'linear-gradient(180deg,#1A2D40,#253E55,#30506A)';
  if (f.includes('partly')) return 'linear-gradient(180deg,#002244,#004080,#0060AA)';
  return 'linear-gradient(180deg,#001A44,#003388,#0055BB)';
}

function ft(t) {
  if (t == null) return '--\xb0';
  if (uTemp === 'C') return Math.round((t - 32) * 5 / 9) + '\xb0';
  return Math.round(t) + '\xb0';
}

function fmtWind(s) {
  if (!s) return '--';
  if (uWind === 'kmh') return s.replace(/(\d+)/g, n => Math.round(+n * UNIT.KMH_PER_MPH)).replace(/\s*mph/gi, ' km/h');
  return s;
}

// ── Location-timezone helpers ────────────────────────────────────────────────
// Hour/day labels are rendered in the ACTIVE LOCATION's timezone (resolved by
// resolveGridpoint into activeLocation.timeZone), not the device's — so a
// Pacific-time user viewing New York sees ET hour labels that line up with
// the ET sunrise/sunset times from calcSunTimes. Falls back to device-local
// when the zone isn't resolved yet (first paint) or Intl rejects it.
function _locTZ() {
  return (typeof activeLocation !== 'undefined' && activeLocation?.timeZone) || undefined;
}

// Calendar-day key (YYYY-MM-DD) in the location's timezone — for "same day?"
// comparisons. en-CA gives the ISO date format.
function _locDayKey(d) {
  try { return d.toLocaleDateString('en-CA', { timeZone: _locTZ() }); }
  catch (_) { return d.toDateString(); }
}

function _locWeekday(d) {
  try { return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: _locTZ() }); }
  catch (_) { return d.toLocaleDateString([], { weekday: 'short' }); }
}

// Current hour (0-23) at the active location.
function _locHour() {
  try { return +new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: _locTZ() }) % 24; }
  catch (_) { return new Date().getHours(); }
}

function fh(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  try {
    // "3 PM" in the location's timezone. Newer ICU inserts a narrow no-break
    // space before AM/PM — normalize to a plain space.
    return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: _locTZ() })
            .replace(/[  ]/g, ' ');
  } catch (_) {
    let h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ' ' + ap;
  }
}

function agoStr(d) {
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function sevOrder(s) { return { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 }[s] || 0; }

const _nwsEventColorCache = new Map();
function nwsEventColor(ev) {
  if (_nwsEventColorCache.has(ev)) return _nwsEventColorCache.get(ev);
  const col = _nwsEventColorImpl(ev);
  _nwsEventColorCache.set(ev, col);
  return col;
}
function _nwsEventColorImpl(ev) {
  const e = (ev || '').toLowerCase();
  if (e.includes('tornado warning'))                return '#FF0000';
  if (e.includes('tornado watch'))                  return '#FFFF00';
  if (e.includes('severe thunderstorm warning'))    return '#FFA500';
  if (e.includes('severe thunderstorm watch'))      return '#DB7093';
  if (e.includes('flash flood warning'))            return '#8B0000';
  if (e.includes('flash flood watch'))              return '#2E8B57';
  if (e.includes('flash flood'))                    return '#8B0000';
  // Coastal before plain flood: "coastal flood warning" contains "flood
  // warning", so in the other order these two could never match and coastal
  // products wore the river-flood colours.
  if (e.includes('coastal flood warning'))          return '#228B22';
  if (e.includes('coastal flood watch'))            return '#008B8B';
  if (e.includes('flood warning'))                  return '#00FF00';
  if (e.includes('flood watch'))                    return '#2E8B57';
  if (e.includes('flood advisory') || e.includes('flood statement')) return '#00FA9A';
  if (e.includes('flood'))                          return '#00FF00';
  if (e.includes('blizzard warning'))               return '#FF4500';
  if (e.includes('ice storm'))                      return '#8B008B';
  if (e.includes('winter storm warning'))           return '#FF69B4';
  if (e.includes('winter storm watch'))             return '#4169E1';
  if (e.includes('winter weather advisory'))        return '#7B68EE';
  if (e.includes('freezing rain') || e.includes('sleet')) return '#9400D3';
  if (e.includes('freeze warning'))                 return '#6495ED';
  if (e.includes('freeze watch'))                   return '#00CED1';
  if (e.includes('frost advisory'))                 return '#6495ED';
  if (e.includes('snow') || e.includes('winter'))  return '#87CEEB';
  if (e.includes('high wind warning'))              return '#8B4513';
  if (e.includes('high wind watch'))                return '#B8860B';
  if (e.includes('wind advisory'))                  return '#D2B48C';
  if (e.includes('wind'))                           return '#D2B48C';
  // NWS renamed Excessive Heat to Extreme Heat in 2025; both spellings are
  // warnings and must not fall through to the advisory colour below.
  if (e.includes('excessive heat warning') || e.includes('extreme heat warning')) return '#C71585';
  if (e.includes('excessive heat watch') || e.includes('extreme heat watch'))     return '#800000';
  if (e.includes('heat advisory'))                  return '#FF7F50';
  if (e.includes('heat'))                           return '#FF7F50';
  if (e.includes('dense fog'))                      return '#708090';
  if (e.includes('red flag warning'))               return '#FF1493';
  if (e.includes('fire weather watch'))             return '#FFDEAD';
  if (e.includes('fire'))                           return '#FF1493';
  if (e.includes('tsunami warning'))                return '#FD6347';
  if (e.includes('tsunami watch'))                  return '#FF7F50';
  if (e.includes('avalanche warning'))              return '#1E90FF';
  if (e.includes('avalanche watch'))                return '#F4A460';
  if (e.includes('special marine warning'))         return '#FFA500';
  if (e.includes('warning'))                        return '#FF0000';
  if (e.includes('watch'))                          return '#FFFF00';
  if (e.includes('advisory'))                       return '#00FFFF';
  return '#5AC8FA';
}

function nwsEventSeverity(ev) {
  const e = (ev || '').toLowerCase();
  if (e.includes('warning'))  return 'warning';
  if (e.includes('watch'))    return 'watch';
  if (e.includes('advisory')) return 'advisory';
  return 'statement';
}

// The coloured label on alert cards and history rows. The TYPE comes from the
// event name — the NWS hierarchy is warning > watch > advisory > statement — and
// NWS's CAP severity only sharpens a warning. It used to come from severity
// alone, and NWS rates many watches "Severe": Hilo's Hurricane Watch and Flood
// Watch (2026-09-25) were both labelled "SEVERE WARNING".
function alertLabel(event, severity) {
  const tier = nwsEventSeverity(event);
  if (tier === 'warning') {
    return severity === 'Extreme' ? 'EXTREME WARNING' : severity === 'Severe' ? 'SEVERE WARNING' : 'WARNING';
  }
  return { watch: 'WATCH', advisory: 'ADVISORY' }[tier] || 'STATEMENT';
}

function alertEmoji(ev) {
  const e = (ev || '').toLowerCase();
  if (e.includes('tornado')) return '🌪';
  if (e.includes('thunder')) return '⛈';
  if (e.includes('flood')) return '🌊';
  if (e.includes('wind')) return '💨';
  if (e.includes('snow') || e.includes('winter')) return '❄️';
  return '⚠️';
}

// ── Severe-weather tags ──────────────────────────────────────────────────────
// NWS attaches machine-readable tags to convective warnings in
// `alert.properties.parameters` — hail size, wind gust, and crucially whether
// the threat was RADAR INDICATED or OBSERVED (a spotter saw it). Enthusiasts
// read the tag before the prose; until now the app dropped all of it.
//
// Only tornado / severe thunderstorm / flash flood warnings carry these. Every
// other event type (heat, air quality, small craft — the vast majority) has no
// tags, so alertTags() returns an empty array and the row renders nothing.

// Values arrive as arrays of strings: parameters.maxHailSize === ["1.00"].
function _alertParam(props, key) {
  const v = props?.parameters?.[key];
  return Array.isArray(v) ? (v[0] || '').trim() : (typeof v === 'string' ? v.trim() : '');
}

// Offices don't agree on formatting: Omaha sends maxHailSize "1.00" while Des
// Moines sends "Up to .75" — same hour, same product type. Pull the number out
// and re-render it ourselves so the badge never reads `Up to .75"`.
function _alertMeasure(raw, unit) {
  if (!raw) return '';
  const m = raw.match(/(\d*\.?\d+)/);
  if (!m) return raw.toUpperCase();
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return raw.toUpperCase();
  const approx = /up to/i.test(raw) ? 'TO ' : '';
  const val = unit === '"' ? n.toFixed(2) : String(Math.round(n));
  return `${approx}${val}${unit}`;
}

// Storm motion: "2026-08-05T05:34:00-00:00...storm...268DEG...27KT...40.83,-96.05"
// → "Moving east at 31 mph". Bearing is the direction the storm comes FROM in
// NWS convention, so it's flipped to a heading before naming the compass point.
const _COMPASS = ['north','northeast','east','southeast','south','southwest','west','northwest'];
function alertMotion(props) {
  const raw = _alertParam(props, 'eventMotionDescription');
  if (!raw) return '';
  const deg = raw.match(/(\d{1,3})DEG/);
  const kt  = raw.match(/(\d{1,3})KT/);
  if (!deg || !kt) return '';
  const heading = (parseInt(deg[1], 10) + 180) % 360;
  const dir = _COMPASS[Math.round(heading / 45) % 8];
  const mph = Math.round(parseInt(kt[1], 10) * 1.15078);
  if (!mph) return `Nearly stationary, moving ${dir}`;
  return `Moving ${dir} at ${mph} mph`;
}

// Ordered strongest-threat-first so the most alarming tag leads the row.
// `cls` selects the badge treatment in styles.css; `loud` marks the tags that
// mean someone has eyes on it, which get the filled, unmissable style.
function alertTags(props) {
  if (!props) return [];
  const tags = [];
  const push = (text, cls, loud) => { if (text) tags.push({ text, cls, loud: !!loud }); };

  const torDet = _alertParam(props, 'tornadoDetection').toUpperCase();
  if (torDet) push('TORNADO ' + torDet, 'at-tor', torDet === 'OBSERVED');
  const torDmg = _alertParam(props, 'tornadoDamageThreat').toUpperCase();
  if (torDmg) push('DAMAGE THREAT: ' + torDmg, 'at-tor', true);

  const ffDmg = _alertParam(props, 'flashFloodDamageThreat').toUpperCase();
  if (ffDmg) push('DAMAGE THREAT: ' + ffDmg, 'at-flood', true);
  const ffDet = _alertParam(props, 'flashFloodDetection').toUpperCase();
  if (ffDet) push('FLASH FLOOD ' + ffDet, 'at-flood', ffDet === 'OBSERVED');

  const tsDmg = _alertParam(props, 'thunderstormDamageThreat').toUpperCase();
  if (tsDmg) push('DAMAGE THREAT: ' + tsDmg, 'at-tor', true);

  const hail = _alertMeasure(_alertParam(props, 'maxHailSize'), '"');
  if (hail) push('HAIL ' + hail, 'at-hail');
  const gust = _alertMeasure(_alertParam(props, 'maxWindGust'), ' MPH');
  if (gust) push('WIND ' + gust, 'at-wind');

  // Detection source applies to the hail/wind pair; show it once rather than
  // repeating "RADAR INDICATED" on both badges.
  const src = _alertParam(props, 'hailThreat').toUpperCase()
           || _alertParam(props, 'windThreat').toUpperCase();
  if (src && !torDet) push(src, 'at-src', src === 'OBSERVED');

  return tags;
}

// True when a tag says a human has eyes on the threat (tornado OBSERVED) or
// NWS has escalated the damage wording. Both Weather-tab banners key off this,
// so they can't drift apart.
function alertIsConfirmed(props) {
  return alertTags(props).some(t => t.loud);
}

function alertTagsHTML(props) {
  const tags = alertTags(props);
  if (!tags.length) return '';
  return `<div class="ac-tags">${tags.map(t =>
    `<span class="ac-tag ${t.cls}${t.loud ? ' at-loud' : ''}">${esc(t.text)}</span>`).join('')}</div>`;
}

// ── Alert times ──────────────────────────────────────────────────────────────
// `ends` is when the weather event stops; `expires` is only the deadline for
// the issuing office to refresh the product. They differ for 121 of the 177
// VTEC alerts in a typical national feed — a Heat Advisory running through
// Friday 8 PM can carry an `expires` of Wednesday 4 PM. Reading `expires` first
// (which the alert popup used to do) therefore understated how long alerts run,
// by up to 54 hours in the sample. Prefer `ends`, fall back to `expires` for
// the products that carry no `ends` at all (Air Quality, Special Weather
// Statement).
function alertEndsAt(props) {
  return props?.ends || props?.expires || '';
}

// ── Area lists ───────────────────────────────────────────────────────────────
// A statewide advisory names every county it covers — an Oklahoma Heat Advisory
// currently lists 62 — which buried both the map popup and the alert cards.
// Show the first few, then "+N more locations" as a tap target that reveals the
// rest in place. `toggleAreaList` is the registered action.
const AREA_PREVIEW_COUNT = 3;

function alertAreaList(areaDesc) {
  return (areaDesc || '').split(';').map(s => s.trim()).filter(Boolean);
}

// NWS emits areaDesc, geocode.UGC and affectedZones in the same order (verified
// against live alerts: a 56-county Heat Advisory matched index-for-index across
// all three). That parallelism is what lets a zone code or a zone polygon
// identify which name in the list is the one the reader cares about.
function _alertAreaIsParallel(props) {
  const ugc = props?.geocode?.UGC;
  return Array.isArray(ugc) && ugc.length === alertAreaList(props?.areaDesc).length;
}

// Index of the location the reader is actually standing in / tapped on, so the
// preview can lead with it. Without this an Oklahoma City tap on a statewide
// Heat Advisory previewed "Harper · Woods · Alfalfa" — three counties in the
// far northwest corner, 150 miles away — because that's the order NWS lists
// them in. Returns -1 when the zone isn't in the alert or the arrays don't line
// up, in which case the NWS order stands.
function alertAreaLeadByZone(props, zone) {
  if (!zone || !_alertAreaIsParallel(props)) return -1;
  return props.geocode.UGC.indexOf(zone);
}

// `cls` styles the block for its surface (popup header vs alert card).
// `leadIdx` (optional) is hoisted to the front of the list.
function areaListHTML(areaDesc, cls, leadIdx) {
  let all = alertAreaList(areaDesc);
  if (!all.length) return '';
  if (leadIdx > 0 && leadIdx < all.length) {
    all = [all[leadIdx], ...all.slice(0, leadIdx), ...all.slice(leadIdx + 1)];
  }
  const klass = `area-list${cls ? ' ' + cls : ''}`;
  if (all.length <= AREA_PREVIEW_COUNT + 1) {
    // Never hide a single extra location behind "+1 more" — that costs a tap to
    // reveal less text than the toggle itself.
    return `<div class="${klass}">${esc(all.join(' \xb7 '))}</div>`;
  }
  const shown = all.slice(0, AREA_PREVIEW_COUNT).join(' \xb7 ');
  const rest  = all.slice(AREA_PREVIEW_COUNT).join(' \xb7 ');
  const n     = all.length - AREA_PREVIEW_COUNT;
  return `<div class="${klass}" data-more="${n}">
    <span class="area-head">${esc(shown)}</span><span class="area-rest"> \xb7 ${esc(rest)}</span>
    <button class="area-more" data-click-action="toggleAreaList"
            aria-expanded="false">+${n} more location${n === 1 ? '' : 's'}</button>
  </div>`;
}

// Expands/collapses one area list. Stops the click from reaching an enclosing
// card — opening the county list shouldn't also toggle the alert it sits in.
function toggleAreaList(btn, e) {
  const box = btn.closest('.area-list');
  if (!box) return;
  e?.stopPropagation?.();
  const open = box.classList.toggle('area-open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const n = +box.dataset.more || 0;
  btn.textContent = open ? 'Show fewer' : `+${n} more location${n === 1 ? '' : 's'}`;
  // The map popup is sized to its content and has to re-run Leaflet's layout.
  if (typeof _refreshOpenAlertPopup === 'function') _refreshOpenAlertPopup();
}

// One id for an alert, whichever shape it arrives in. A GeoJSON feature's own
// `id` is the full API URL ("https://api.weather.gov/alerts/urn:oid:…") while
// `properties.id` is the bare URN — reading feature.id first meant an alert
// identified from the map (which only ever has properties) never matched the
// same alert in wxData.alerts, and it showed up twice.
function alertFeatureId(f) {
  return f?.properties?.id || f?.id || '';
}

// "8:47 PM CDT" today, "Wed 11:00 AM CDT" this week, "Aug 20, 11:00 AM CDT"
// beyond it.
//
// Alert times are rendered in the READER'S time zone, not the issuing office's.
// That's right for your own alerts and wrong-looking for everyone else's: the
// map shows every alert in the country, so a Tennessee warning ending
// 23:45 -04:00 read as "until 8:45 PM" on a Pacific device — silently off by
// three hours for someone checking a warning where family live. The zone
// abbreviation removes the ambiguity without moving the times out of the zone
// the reader actually lives in.
//
// `timeZoneName: 'short'` gives the familiar abbreviation (CDT, PST) where the
// runtime knows one and falls back to a GMT offset where it doesn't — either
// way the reading is unambiguous.
function fmtAlertTime(iso, withZone = true) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleString([], {
    hour: 'numeric', minute: '2-digit',
    ...(withZone ? { timeZoneName: 'short' } : {}),
  });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const days = (d - now) / 86400000;
  if (days > -1 && days < 6) return d.toLocaleString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

// The zone is carried by the "until" time only. Both times are formatted in the
// same zone, so stamping it twice on one line is noise — and "until" is the one
// people act on. DST is the exception: when an alert is issued on one side of a
// changeover and ends on the other the abbreviations genuinely differ, so the
// issued time labels itself too rather than inheriting a zone it isn't in.
function alertIssuedLabel(props, untilZone) {
  const iso = props?.sent || props?.effective;
  const t = fmtAlertTime(iso, untilZone ? _alertZoneAbbr(iso) !== untilZone : true);
  return t ? 'Issued ' + t : '';
}

function alertUntilLabel(props) {
  const t = fmtAlertTime(alertEndsAt(props));
  return t ? 'until ' + t : '';
}

// Bare zone abbreviation for an instant, e.g. "CDT".
function _alertZoneAbbr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat([], { hour: 'numeric', timeZoneName: 'short' })
    .formatToParts(d);
  return (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
}

// The pair as the UI shows it: issued (bare unless its zone differs) then until
// (always zone-stamped).
function alertTimeLabels(props) {
  const untilZone = _alertZoneAbbr(alertEndsAt(props));
  return [alertIssuedLabel(props, untilZone), alertUntilLabel(props)];
}

// ── Collapsing re-transmissions ──────────────────────────────────────────────
// About a third of the national active feed is the *same* product sent again.
// NWS offices re-issue a running advisory every few hours (NWS Anchorage sends
// each Small Craft Advisory with every coastal waters forecast; NWS Boise
// relayed one Idaho DEQ smoke advisory five times), each transmission gets a
// fresh alert id, and none of them cancel or reference the earlier ones — so
// /alerts/active carries all of them until they lapse, and both the map popup
// and the Alerts tab listed the same advisory five times over.
//
// The key has to be P-VTEC, not the event name and area. NWS Tucson had two
// Flash Flood Warnings whose event, office and areaDesc ("Cochise, AZ") were
// byte-identical but which were different warnings — ETN 0127 and 0128. VTEC
// tells them apart; nothing else in the payload does.
//
//   /O.CON.KTWC.FF.W.0128.000000T0000Z-260812T0615Z/
//      ^action ^office ^phenomenon ^significance ^event tracking number
//
// Same office+phenomenon+significance+ETN = same weather event, so only the
// newest transmission is kept. Different ETN = different event, always kept.
const _VTEC_RE = /\/[OTEX]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./;

function alertGroupKey(p) {
  const v = p?.parameters?.VTEC?.[0];
  const m = v && _VTEC_RE.exec(v);
  if (m) return `v:${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  // Special Weather Statements and Air Quality Alerts carry no VTEC. They're
  // also the informational tier — nothing life-threatening lands here, because
  // every warning-grade product is VTEC-tagged — so falling back to
  // event+office+area is safe in a way it would not be for the feed at large.
  return `n:${p?.event}|${p?.senderName}|${p?.areaDesc}`;
}

// VTEC catches most re-transmissions, but not NWS Anchorage's marine products:
// PAFC stamps every Small Craft Advisory `NEW` with a random event number
// (9999, 8233, 6615, 9663 for one stretch of the Aleutians), so four copies of
// one advisory look like four separate events.
//
// What gives them away is `expires`: it's the deadline for the office to
// refresh the product. A transmission whose `expires` has already lapsed *and*
// that has a newer transmission for the same event, office and area is the copy
// that was refreshed — the newer one is the refresh. Nothing is dropped on the
// strength of a guess: NWS has to have marked it past its own expiry, and a
// fresher alert for the same ground has to exist.
function _dropLapsedTransmissions(entries, now) {
  const byArea = new Map();
  for (const e of entries) {
    const p = e.props;
    const k = `${p.event}|${p.senderName}|${p.areaDesc}`;
    if (!byArea.has(k)) byArea.set(k, []);
    byArea.get(k).push(e);
  }
  const kept = [];
  for (const grp of byArea.values()) {
    if (grp.length === 1) { kept.push(grp[0]); continue; }
    grp.sort((a, b) => new Date(b.props.sent || 0) - new Date(a.props.sent || 0));
    const newest = grp[0];
    kept.push(newest);
    for (const e of grp.slice(1)) {
      const exp = Date.parse(e.props.expires || '');
      // Still within its own expiry — a genuinely separate live alert.
      if (!isFinite(exp) || exp > now) { kept.push(e); continue; }
      newest.versions += e.versions;
    }
  }
  return kept;
}

// Drawing the map wants a stricter key than listing does: collapse a
// re-transmission only when it covers exactly the same ground. Two segments of
// one VTEC event can be active over different zone groups at once (a Winter
// Storm Warning continued over three counties and extended over two others),
// and dropping either would erase that ground from the map — whereas in a list
// they're the same event and one row is right.
function alertGroupAreaKey(p) {
  return alertGroupKey(p) + '|' + (p?.areaDesc || '');
}

// Collapses `{props, versions}` entries by `keyFn`, keeping the newest
// transmission of each and accumulating the counts.
function regroupAlertEntries(entries, now = Date.now(), keyFn = alertGroupKey) {
  const groups = new Map();
  for (const e of entries) {
    if (!e || !e.props) continue;
    const key = keyFn(e.props);
    const cur = groups.get(key);
    if (!cur) { groups.set(key, { props: e.props, versions: e.versions || 1 }); continue; }
    cur.versions += e.versions || 1;
    if (new Date(e.props.sent || 0) > new Date(cur.props.sent || 0)) cur.props = e.props;
  }
  return _dropLapsedTransmissions([...groups.values()], now);
}

// Takes alert `properties` objects, returns `{props, versions}` — one entry per
// distinct weather event, newest transmission kept, `versions` counting how
// many transmissions were folded into it so callers can say so rather than
// silently dropping them.
function groupAlertTransmissions(propsList, now = Date.now(), keyFn = alertGroupKey) {
  return regroupAlertEntries(
    (propsList || []).filter(Boolean).map(props => ({ props, versions: 1 })), now, keyFn);
}

// Same collapse over GeoJSON features, for wxData.alerts. The surviving feature
// is returned as-is with `_versions` attached, matching the existing
// `_gpsOrigin` convention, so every consumer (cards, hero banner, nav badge,
// share text) counts weather events rather than transmissions.
function dedupeAlertFeatures(features) {
  const list = (features || []).filter(f => f && f.properties);
  if (list.length < 2) return list.map(f => Object.assign(f, { _versions: 1 }));
  const byProps = new Map();
  const order = new Map();
  list.forEach((f, i) => { byProps.set(f.properties, f); if (!order.has(f.properties)) order.set(f.properties, i); });
  return groupAlertTransmissions([...byProps.keys()])
    .map(({ props, versions }) => Object.assign(byProps.get(props), { _versions: versions }))
    // Most serious first — callers treat alerts[0] as the headline one (the
    // Weather banner, the top of the Alerts screen). The feed's own order is
    // newest-first, which let a routine statement bury a warning: Hilo,
    // 2026-09-25, led with a Tropical Cyclone Local Statement issued six
    // minutes after the Hurricane Watch and Tropical Storm Warning it was
    // describing. Ties keep the feed's order, so newest still wins within a tier.
    .sort((a, b) => alertPriority(a.properties) - alertPriority(b.properties)
      || order.get(a.properties) - order.get(b.properties));
}

// Warnings, then watches, then advisories, then statements — the NWS
// hierarchy, read from the event name (see nwsEventSeverity) — and within a
// tier by the CAP severity NWS assigns. Lower sorts first.
const _ALERT_TIER_RANK = { warning: 0, watch: 1, advisory: 2, statement: 3 };
const _ALERT_SEV_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
function alertPriority(p) {
  const tier = _ALERT_TIER_RANK[nwsEventSeverity(p?.event)] ?? 3;
  const sev = _ALERT_SEV_RANK[p?.severity] ?? 4;
  return tier * 10 + sev;
}

// ── Stale-while-revalidate wx cache ──────────────────────────────────────────
// Persist the last successful wx payload to localStorage so boot() can paint
// real weather data immediately — before the first network round-trip — giving
// an instant perceived load on every subsequent open. Max age: 4 hours (stale
// enough to show something useful, fresh enough to not be misleading).
const _WX_CACHE_KEY    = 'noaa_wx_cache_v1';
const _WX_CACHE_MAX_MS = 4 * 60 * 60 * 1000;

function _saveWxCache() {
  try {
    localStorage.setItem(_WX_CACHE_KEY, JSON.stringify({
      locId:    activeLocation.id,
      forecast: wxData.forecast,
      hourly:   wxData.hourly,
      ts:       Date.now(),
    }));
  } catch (_) {}
}

function _loadWxCache() {
  try {
    const d = JSON.parse(localStorage.getItem(_WX_CACHE_KEY) || 'null');
    if (!d || d.locId !== activeLocation.id) return null;
    if (Date.now() - d.ts > _WX_CACHE_MAX_MS)  return null;
    return d;
  } catch (_) { return null; }
}

// ── Conditions-changed in-app alerts ─────────────────────────────────────────
// Fires a toast when upcoming hourly data shows a significant shift — rain
// arriving, a big temperature drop, or wind picking up. Runs on every poll
// AFTER the first successful fetch (so a cold start never fires spuriously).
// Each alert type is silenced for 1 hour after firing to prevent spam.
let _wxBaselineSet = false;
const _condLastFired = {};
const _COND_COOLDOWN_MS = 60 * 60 * 1000;

function _checkConditionsChanged(hourly) {
  if (!hourly || hourly.length < 3) return;
  if (typeof masterOn === 'function' && !masterOn()) return;
  if (typeof isQuiet  === 'function' && isQuiet())   return;

  const _fire = (key, emoji, event, headline) => {
    if (Date.now() - (_condLastFired[key] || 0) < _COND_COOLDOWN_MS) return;
    _condLastFired[key] = Date.now();
    if (typeof queueToast === 'function') queueToast({ emoji, event, headline, area: '' });
  };

  const now  = hourly[0];
  const h1   = hourly[1] || now;
  const h2   = hourly[2] || h1;

  // Thresholds compare NWS-rounded values so "50%" here means the same 50%
  // NWS would publish — a raw 49 counts, exactly as their forecast reads it.
  const nowPop  = popPct(now.probabilityOfPrecipitation?.value) ?? 0;
  const soonPop = Math.max(popPct(h1.probabilityOfPrecipitation?.value) ?? 0,
                           popPct(h2.probabilityOfPrecipitation?.value) ?? 0);
  if (nowPop < POP_MENTION_MIN && soonPop >= 50) {
    _fire('rain', '🌧', 'Rain arriving soon',
      `${soonPop}% chance in the next 2 hours`);
  }

  const nowTemp  = now.temperature ?? null;
  const soonTemp = h2.temperature  ?? null;
  if (nowTemp !== null && soonTemp !== null && (nowTemp - soonTemp) >= 10) {
    _fire('temp_drop', '🥶', 'Temperature dropping',
      `Falling ${Math.round(nowTemp - soonTemp)}° · Down to ${ft(soonTemp)}`);
  }

  const nowWind  = parseWindSpd(now.windSpeed ?? '');
  const soonWind = Math.max(parseWindSpd(h1.windSpeed ?? ''), parseWindSpd(h2.windSpeed ?? ''));
  if (nowWind < 15 && soonWind >= 25) {
    const spd  = uWind === 'kmh' ? Math.round(soonWind * UNIT.KMH_PER_MPH) : Math.round(soonWind);
    const unit = uWind === 'kmh' ? 'km/h' : 'mph';
    _fire('wind', '💨', 'Wind picking up', `Up to ${spd} ${unit} expected`);
  }
}

// ── Weather fetch & render ───────────────────────────────────────────────────
async function fetchWx() {
  const { wfo, gx, gy } = activeLocation;
  const myGen = _locGen;  // #12: bail if user switches locations mid-flight
  try {
    // Run both fetches in parallel. Forecast is required; hourly is treated as
    // optional — the NWS hourly endpoint has a history of returning 500 while
    // the main forecast endpoint is healthy. If hourly fails we still render
    // the hero, metric tiles, AFD, and 7-day forecast normally; only the
    // hourly strip and Hourly tab are left empty until the next successful poll.
    const [fResult, hResult] = await Promise.allSettled([
      nwsFetch(`https://api.weather.gov/gridpoints/${wfo}/${gx},${gy}/forecast`),
      nwsFetch(`https://api.weather.gov/gridpoints/${wfo}/${gx},${gy}/forecast/hourly`)
    ]);
    if (_locGen !== myGen) return;

    // Forecast failure is fatal — nothing meaningful to display without it.
    const fR = fResult.status === 'fulfilled' ? fResult.value : null;
    if (!fR || !fR.ok) throw new Error('Forecast HTTP ' + (fR?.status ?? 'failed'));

    // Hourly failure is graceful — log it and continue with an empty array.
    const hR = hResult.status === 'fulfilled' && hResult.value.ok ? hResult.value : null;
    if (!hR) _warn('fetchWx/hourly', hResult.reason ?? 'HTTP ' + hResult.value?.status);

    const fd = await fR.json();
    if (_locGen !== myGen) return;
    const hd = hR ? await hR.json().catch(() => null) : null;
    if (_locGen !== myGen) return;

    wxData.forecast     = fd?.properties?.periods || [];
    wxData.hourly       = hd?.properties?.periods || [];
    // Track whether the hourly endpoint succeeded so the UI can show an
    // "unavailable" notice instead of a blank strip or perpetual spinner.
    wxData.hourlyFailed = !hR || !(hd?.properties?.periods?.length);
    _lastWxUpdate = Date.now();
    renderWx();
    // renderHourly is intentionally outside the error-display path: if it throws
    // (e.g. a rendering edge-case), we must not overwrite the weather content that
    // renderWx() just successfully painted into wx-body.
    try { renderHourly(); } catch (e) { _warn('renderHourly', e); }
    refreshLiveChips();
    // Persist for instant perceived load on next open.
    _saveWxCache();
    // Fire conditions-changed toasts on subsequent polls (skip cold start).
    if (_wxBaselineSet) _checkConditionsChanged(wxData.hourly);
    else _wxBaselineSet = true;
  } catch (e) {
    if (_locGen !== myGen) return;
    _warn('fetchWx', e);
    // Only replace wx-body with the error/retry UI when the fetch itself failed
    // (wxData.forecast is still empty). If renderWx() already ran successfully,
    // wxData.forecast.length > 0 and we leave the displayed weather alone.
    if (!wxData.forecast.length) {
      // Distinguish "no connection" from a server-side error so the user knows
      // whether to check their network or just retry. navigator.onLine===false
      // is reliable for the offline case; we don't trust a true value to mean
      // "definitely online", so anything else falls through to the API message.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const msg = offline
        ? 'You’re offline. Reconnect to load the latest forecast.'
        : esc(e.message);
      document.getElementById('wx-body').innerHTML = `<div class="ldg"><div>${msg}</div><button class="retry-btn" data-click-action="fetchWx">Retry</button></div>`;
    }
  }
}

// The Weather screen's forecast card renders the full run (NWS returns
// day/night pairs, so 14 periods ≈ 7 days) but caps the list's height in CSS
// (.dlist) so it scrolls inside the card instead of pushing the Area Forecast
// Discussion off the page. Every day stays reachable without leaving the tab.
// 14 half-day periods = 7 forecast days. NWS always returns exactly 14
// (verified live across OUN/SEW/OKX), one day + one night per day, so the list
// is 7 days regardless of when it's fetched. The label said "8 days" because an
// evening fetch starts at "Tonight" and touches 8 calendar dates — but only 7
// of them have a daytime period, and NWS itself calls this the 7-day forecast.
const WX_DAY_PERIODS = 14;

// Reveals the hourly-roundup link once we know the product exists for this
// state, and stamps it with how fresh the latest one is. Stays hidden for the
// 17 states that don't file it — offering a link that lands on "none on file"
// is worse than not offering one. Best-effort: any failure leaves it hidden.
async function _syncRoundupEntry() {
  const el = document.getElementById('rwr-entry');
  if (!el || typeof spcRoundupAvailable !== 'function') return;
  const myGen = _locGen;
  let res = null;
  try { res = await spcRoundupAvailable(); } catch (_) { /* stays hidden */ }
  if (_locGen !== myGen) return;              // user switched location mid-probe
  const el2 = document.getElementById('rwr-entry');
  if (!el2) return;                            // wx-body re-rendered underneath us
  if (!res) { el2.hidden = true; return; }
  // The link itself stays two words; which state and how fresh go in the
  // accessible name, where there's room for them.
  const age = typeof _spcAge === 'function' ? _spcAge(res.issued) : '';
  const detail = `Hourly roundup: observations across ${res.state}${age ? ', updated ' + age : ''}`;
  el2.setAttribute('aria-label', detail);
  el2.setAttribute('title', detail);
  el2.hidden = false;
}

// Last live station reading, kept across re-renders.
//
// renderWx() rebuilds #tile-temp from scratch every time it runs — including on
// every alerts poll — so without this the hero snaps back to the forecast value
// and has to wait on a fresh two-request round-trip to be corrected again.
// Keyed by location id so switching cities never shows the previous city's
// reading.
let _obsTemp = { locId: null, tempF: null, at: 0 };
const OBS_TEMP_TTL_MS = 90 * 60 * 1000; // stations report ~hourly

// The whole observation payload, not just the temperature — so a re-render can
// repaint every obs-backed tile without re-hitting the network.
//
// renderWx() calls fetchCurrentObs() unconditionally, and renderWx() runs on
// every ALERTS poll as well as every weather poll (_applyAlerts refreshes the
// hero alert banner through it). fetchCurrentObs had no TTL of its own, so each
// poll cycle re-ran the full chain — a /stations lookup plus up to five
// SEQUENTIAL /observations/latest requests — up to three times over, for a
// reading that changes about once an hour.
//
// The fetch TTL is deliberately NOT OBS_TEMP_TTL_MS. That 90 minutes governs how
// long a cached temperature is acceptable as a *seed* for the hero when nothing
// fresher exists; reusing it here would let wind, humidity and visibility go 90
// minutes stale, which they never were before. 10 minutes collapses the
// redundant chains (the ones fired seconds apart within one poll cycle) while
// keeping every tile at least as fresh as the user's chosen poll interval.
const OBS_FETCH_TTL_MS = 10 * 60 * 1000;
let _obsCache = { locId: null, at: 0, stationId: '', stationName: '', distStr: '', props: null };

// Explicit "refresh now" gestures have to bypass the TTL, or pull-to-refresh
// would silently stop refreshing the observation tiles.
function invalidateObsCache() { _obsCache.at = 0; }

// The temperature to show as "now", best source first.
//
// wxData.forecast[0].temperature is NOT a current reading: NWS gives each
// period a single number that is the HIGH for a daytime period and the LOW for
// an overnight one. Seeding the hero with it is why the big number could sit
// several degrees off — showing tomorrow's high at 8am, or tonight's low at
// noon — until (and only if) the observation patch below landed.
function heroTempF(now) {
  if (_obsTemp.tempF != null && _obsTemp.locId === activeLocation?.id
      && Date.now() - _obsTemp.at < OBS_TEMP_TTL_MS) return _obsTemp.tempF;
  // /forecast/hourly period 0 is the current hour — an actual hourly
  // temperature, not a period extreme. Already fetched before this render.
  const h0 = wxData.hourly?.[0];
  if (h0?.temperature != null) return h0.temperature;
  return now.temperature;
}


// ── App Store review prompt ──────────────────────────────────────────────────
// Deliberately conservative. The listing carries very few ratings, and the way
// to fix that is to ask engaged users at a good moment — not to ask everyone at
// launch. Every gate below exists to protect the rating we would get, not just
// to be polite.
//
// iOS itself allows at most three prompts per app per 365 days and may show
// nothing at all, silently. That budget is scarce, so the app must not spend an
// attempt on a user who is unlikely to be positive or is busy with something
// else. Nothing here can observe whether the sheet appeared or what was chosen
// — Apple exposes neither — so every record below is "we asked", never
// "they rated".
const REVIEW_KEY = 'noaa_review_v1';   // { sessions, lastAskedAt, askedVersion }
// Six, down from twelve (1.12.7). At twelve the prompt almost never fired: the
// listing sat at 8 ratings, and ratings volume is the single biggest input to
// App Store search rank. Six still lands after the feedback card (five, or two
// for an engaged user) and the one-week gap below still holds, so the order —
// feedback first, rating second — is unchanged.
const REVIEW_MIN_SESSIONS = 6;         // engaged, and asked for feedback first
// A return after this long away counts as a new session, not just a cold boot.
// iOS keeps the WebView resident for days, so cold boots alone undercounted the
// heaviest users by an order of magnitude — the people most likely to rate were
// the last ever asked. Thirty minutes separates "came back to check the weather
// again" from "glanced at a text and swiped back".
const SESSION_RESUME_GAP_MS = 30 * 60_000;
const REVIEW_REASK_DAYS = 120;         // well clear of iOS's own 365/3 budget

function _reviewState() {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}');
    return {
      sessions: +raw.sessions || 0,
      lastAskedAt: +raw.lastAskedAt || 0,
      askedVersion: raw.askedVersion || '',
    };
  } catch (_) {
    return { sessions: 0, lastAskedAt: 0, askedVersion: '' };
  }
}

function _saveReviewState(st) {
  try { localStorage.setItem(REVIEW_KEY, JSON.stringify(st)); } catch (_) {}
}

// Counted once per cold boot AND once per return after SESSION_RESUME_GAP_MS
// away (see the visibilitychange handler), never per render or quick app
// switch — "sessions" has to mean "came back to the app again", which is the
// thing that actually signals the app earned a place on their phone.
function noteAppSession() {
  const st = _reviewState();
  st.sessions += 1;
  _saveReviewState(st);
}

// Called after a successful forecast paint. Returns nothing; failure is silent
// by design — a rating prompt is the least important thing the app does.
async function maybeAskForReview() {
  // Native only. There is no web equivalent, and a link out to the App Store
  // from a browser is worse than not asking.
  if (!(window.Capacitor?.isNativePlatform?.())) return;
  const plugin = window.Capacitor?.Plugins?.NOAAEnv;
  if (typeof plugin?.requestReview !== 'function') return;

  const st = _reviewState();

  // Not yet engaged. A first-session prompt is how listings collect one-star
  // ratings from people who have not seen the app work.
  if (st.sessions < REVIEW_MIN_SESSIONS) return;

  // The feedback card gets the earlier slot (five sessions; this one waits for
  // six), so anyone with a complaint has already had somewhere to put it
  // that is not a public one-star review — and a week has passed since they
  // were asked, so the two never land together.
  //
  // This is a check on TIMING, never on what they said. Apple forbids asking
  // how someone feels and routing only the happy ones to the App Store, so the
  // rating sheet must not care whether they wrote in, declined, or ignored it.
  // offeredAt covers a card that is on the page but not yet scrolled to: the
  // week runs from when it was first offered, so someone who never scrolls
  // down still gets the rating sheet, just not before the card had its turn.
  const fb = _feedbackState();
  const fbLast = Math.max(fb.shownAt, fb.offeredAt);
  if (fbLast && Date.now() - fbLast < FEEDBACK_AFTER_REVIEW_DAYS * 864e5) return;

  // Already asked recently, or already asked on this exact version. The second
  // check matters after an update: a user who declined on 1.12.2 should not be
  // asked again the moment 1.12.3 lands.
  if (st.askedVersion === APP_VERSION) return;
  if (st.lastAskedAt && Date.now() - st.lastAskedAt < REVIEW_REASK_DAYS * 864e5) return;

  // Never during severe weather. Someone who opened this app because there is a
  // warning over their house is doing something urgent, and interrupting that
  // with a rating sheet is both rude and the fastest way to earn one star.
  if ((wxData.alerts || []).length > 0) return;

  // Only from the Weather screen, and only with a forecast actually on it —
  // this is the moment the app has just done its job.
  if (document.querySelector('.screen.active')?.id !== 's-wx') return;
  if (!wxData.forecast.length) return;

  // Nothing else competing for attention. Both are LIVE checks on purpose:
  // _isFirstRun is a snapshot taken at script load, so it stays true for the
  // whole session even after the user finishes onboarding — using it here would
  // have been a stale answer to a question about right now. It is also
  // redundant, since anyone with five sessions has already been onboarded.
  if (document.getElementById('toast')?.classList.contains('show')) return;
  if (document.getElementById('onboarding-overlay')?.classList.contains('show')) return;
  if (_updateCardShowing()) return;

  // Record BEFORE asking, not after. If the call throws halfway, or iOS shows
  // the sheet and the WebView is torn down before the promise settles, the
  // wrong failure is asking again tomorrow — not skipping one cycle.
  st.lastAskedAt = Date.now();
  st.askedVersion = APP_VERSION;
  _saveReviewState(st);

  try {
    await plugin.requestReview();
  } catch (e) {
    // Backgrounded, no window scene, or the plugin is from an older build.
    // Deliberately does NOT roll back the record above.
    _warn('requestReview', e);
  }
}

// ── Feedback prompt ──────────────────────────────────────────────────────────
//
// The only way to reach the developer used to be "Report a Bug / Contact" at
// the bottom of Settings, which nobody goes looking for — so the app heard from
// users only when something was broken enough to hunt for an address.
//
// This asks instead, from the bottom of the Weather screen: a card the user
// can answer or dismiss, never a modal and never anything that covers the
// forecast. Since 1.12.7 it offers BOTH ways to respond, side by side and with
// equal weight: "Rate on App Store" and "Send feedback". Anyone who would have
// left a bad review sees a private channel right next to the public one.
//
// Both buttons are shown to everyone, with no "are you enjoying it?" question
// in front of them. That is the line Apple draws: offering both is fine;
// asking about sentiment first and showing only the matching button is review
// gating, and the app can be rejected for it.
//
// It goes FIRST, at five sessions, with the rating sheet held back to six and
// a week behind it.
// The system sheet is the scarcer ask — iOS allows three a year and may show
// nothing at all — and a rating is public and permanent, so someone who is
// annoyed by a bug should meet a mail composer before they meet the App Store.
//
// It is still NOT a pre-screen for the rating prompt. Apple forbids asking how
// someone feels and routing only the happy ones to rate, so maybeAskForReview()
// looks at WHEN this card appeared and never at what the user did with it:
// write in, decline, or ignore it, and the rating sheet behaves identically.
// The one exception is tapping "Rate on App Store": that user is already on
// the rating page, so the system sheet counts as asked for this cycle rather
// than asking the same person twice.
//
// "Asked" here means "the card was rendered", the same honesty the review
// prompt keeps: nothing can observe whether a mail client actually opened or a
// message was ever sent.
const APP_STORE_ID = '6771460673';
const FEEDBACK_KEY = 'noaa_feedback_v1';   // { shows, shownAt, offeredAt, closedAt, closedWhy }
const FEEDBACK_MIN_SESSIONS = 5;           // first ask; the rating sheet waits for 6
const FEEDBACK_ENGAGED_SESSIONS = 2;       // ...unless they are plainly already invested

// Sessions used to count only COLD BOOTS (long returns count too since
// 1.12.7, see SESSION_RESUME_GAP_MS), which systematically undercounted the
// heaviest users: someone who leaves the app resident and swipes back to it
// all day could take weeks to reach five, while someone who force-quits out of
// habit got there in a day. Waiting on that number alone means the people with the most
// to say are asked last.
//
// So look for evidence of investment the counter cannot see. All four already
// exist in storage — nothing new is recorded to answer this question:
//
//   * notification permission granted — they went through the system prompt
//     and told the relay where they are, which nobody does casually
//   * more than one saved location — they curated past the default
//   * a few received alerts in the log — the app has been working for them
//   * already asked to rate — they passed the old five-session bar before the
//     two asks swapped order
//
// Any one of those drops the bar to two sessions. Two, not one: the first boot
// after an update is not the moment to ask, and a restored backup can arrive
// with locations already in it.
function _looksEngaged() {
  try {
    if (localStorage.getItem('pushRegState') === 'granted') return true;
    const locs = JSON.parse(localStorage.getItem('noaa_saved_locs') || '[]');
    if (Array.isArray(locs) && locs.length >= 2) return true;
    const log = JSON.parse(localStorage.getItem('noaa_notif_log') || '[]');
    if (Array.isArray(log) && log.length >= 3) return true;
    if (_reviewState().lastAskedAt) return true;
  } catch (_) {}
  return false;
}
const FEEDBACK_REASK_DAYS   = 45;          // "No thanks" or ignored: ask again later
const FEEDBACK_MAX_SHOWS    = 3;           // then stop asking, forever
const FEEDBACK_AFTER_REVIEW_DAYS = 7;      // and the two asks stay a week apart

function _feedbackState() {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}');
    return {
      shows: +raw.shows || 0,
      shownAt: +raw.shownAt || 0,
      // When the card was first put on the page in the current cycle but not
      // yet scrolled into view. Cleared once it is seen (shownAt takes over).
      offeredAt: +raw.offeredAt || 0,
      closedAt: +raw.closedAt || 0,
      closedWhy: raw.closedWhy || '',
      pending: !!raw.pending,
      // Which card this state belongs to: 3 = shows counted only when seen
      // (1.21.1+); 2 = the rate-or-feedback card counted on render
      // (1.12.7–1.21.0); absent = the feedback-only card of 1.12.5–1.12.6.
      card: +raw.card || 0,
    };
  } catch (_) {
    return { shows: 0, shownAt: 0, offeredAt: 0, closedAt: 0, closedWhy: '', pending: false, card: 0 };
  }
}

function _saveFeedbackState(st) {
  try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(st)); } catch (_) {}
}

// Additive and silent, like the climate card: the slot stays empty until every
// condition below holds, and any failure just leaves it empty.
function _renderFeedbackCard() {
  const el = document.getElementById('wx-feedback-card');
  if (!el) return;
  el.innerHTML = '';
  _unwatchFeedbackCard();

  const st = _feedbackState();

  // One-time reset for the OLD card. 1.12.5–1.12.6 showed a feedback-only card
  // with no way to rate; 1.12.7 replaced it with rate-or-feedback, but kept its
  // state — so anyone who had seen or dismissed the old card inherited its
  // 45-day re-ask wait and would not see the new one until November. Those are
  // the most engaged users, the ones most likely to rate, and reaching them was
  // the point of 1.12.7 (found 2026-09-24: the card never appeared after the
  // update). The new card is a new question, so their old answer is cleared once.
  //
  // A second one-time reset for shows that may never have been seen. Up to
  // 1.21.0 a show was counted when the card was rendered at the bottom of the
  // screen, scrolled to or not (see _watchFeedbackCard), so a stored show with
  // no answer may be one the user never laid eyes on. Those are cleared once.
  // A show the user answered (rated, wrote in, or said no thanks) was seen for
  // certain, so its answer stands.
  if (st.card < 3) {
    if (st.card < 2 && (st.shownAt || st.closedAt || st.pending)) {
      st.shows = 0; st.shownAt = 0; st.closedAt = 0; st.closedWhy = ''; st.pending = false;
    } else if (!st.closedAt && !st.pending) {
      st.shows = 0; st.shownAt = 0;
    }
    st.offeredAt = 0;
    st.card = 3;
    _saveFeedbackState(st);
  }

  // Composer was opened and the user came back. Whether a message was actually
  // sent is unknowable — mailto reports nothing, and on a phone with no mail
  // account configured it opens Apple Mail's setup screen and nothing is sent
  // at all. So the card stays, now carrying the address itself, until the user
  // says they are done with it. Before this, tapping Send closed the card for
  // good, which meant anyone without Mail set up lost both the composer and any
  // way back to the address.
  if (st.pending && !st.closedAt) { el.innerHTML = _feedbackSentHTML(); return; }

  // Rated: the only final answer. Everything else (1.12.7) just hides the card
  // until the re-ask window below passes, up to FEEDBACK_MAX_SHOWS in all:
  //   * "No thanks" is a not-now, not a never.
  //   * Wrote in: someone who reported a bug may be glad to rate once it is
  //     fixed, so the card comes back with both buttons.
  // (Anyone who only ever answered the old feedback-only card is reset above.)
  if (st.closedWhy === 'rated') return;

  // Already up this session: renderWx() runs again on every alerts poll, and
  // the stored shownAt would fail the re-ask window below and quietly delete a
  // card the user was in the middle of reading. Once shown, it stays until the
  // user answers it or leaves.
  if (_fbkShownThisSession) { el.innerHTML = _feedbackCardHTML(); return; }

  // One ask at a time. An update card on screen goes first — rating an old
  // version helps nobody — and this waits, without spending one of its shows.
  if (_updateCardShowing()) return;

  if (st.shows >= FEEDBACK_MAX_SHOWS) return;

  // Engaged enough to have an opinion worth reading, and early enough to catch
  // a problem before the rating sheet at six sessions.
  const bar = _looksEngaged() ? FEEDBACK_ENGAGED_SESSIONS : FEEDBACK_MIN_SESSIONS;
  if (_reviewState().sessions < bar) return;

  // Never during severe weather, for the same reason the rating prompt isn't:
  // someone with a warning over their house is busy.
  if ((wxData.alerts || []).length > 0) return;

  // Not in the same week as the rating sheet. This normally cannot fire now
  // that the feedback card asks first, but it still holds for a user who
  // upgraded mid-cycle and was asked to rate under the old ordering.
  const lastReview = _reviewState().lastAskedAt;
  if (lastReview && Date.now() - lastReview < FEEDBACK_AFTER_REVIEW_DAYS * 864e5) return;

  // Shown already this cycle: wait out the re-ask window. "No thanks" and
  // ignoring the card are both soft noes, so each costs 45 days rather than
  // closing the door.
  if (st.shownAt && Date.now() - st.shownAt < FEEDBACK_REASK_DAYS * 864e5) return;

  // Nothing else competing for attention (live checks, not load-time snapshots).
  if (document.getElementById('toast')?.classList.contains('show')) return;
  if (document.getElementById('onboarding-overlay')?.classList.contains('show')) return;

  el.innerHTML = _feedbackCardHTML();

  // On the page is not the same as seen. The card sits at the bottom of the
  // Weather screen, below Storm Center, and counting it the moment it was
  // rendered spent a show (and started the 45-day wait) on launches where the
  // user never scrolled that far (found 2026-09-30: the card never appeared
  // on a phone that met every condition). So the show is recorded only once
  // half the card has been on screen; until then it waits at the bottom on
  // every launch, re-checking the gates above each time.
  //
  // offeredAt is stamped on the first render of the cycle, so the rating
  // sheet can still keep its week behind the card for someone who never
  // scrolls down, instead of waiting on them forever. Stamped as card 3 so
  // the one-time resets above never fire for it.
  if (!st.offeredAt) {
    st.offeredAt = Date.now();
    st.card = 3;
    _saveFeedbackState(st);
  }
  _watchFeedbackCard(el.firstElementChild);
}

let _fbkShownThisSession = false;
let _fbkObserver = null;

function _unwatchFeedbackCard() {
  if (_fbkObserver) { _fbkObserver.disconnect(); _fbkObserver = null; }
}

// Records the show when the card is at least half on screen. renderWx()
// replaces the whole Weather body whenever its HTML changes, so each render
// observes the new node and drops the old observer.
function _watchFeedbackCard(card) {
  _unwatchFeedbackCard();
  if (!card) return;
  if (typeof IntersectionObserver !== 'function') { _recordFeedbackShow(); return; }
  _fbkObserver = new IntersectionObserver((entries) => {
    if (!entries.some(e => e.isIntersecting)) return;
    _unwatchFeedbackCard();
    _recordFeedbackShow();
  }, { threshold: 0.5 });
  _fbkObserver.observe(card);
}

function _recordFeedbackShow() {
  if (_fbkShownThisSession) return;
  _fbkShownThisSession = true;
  const st = _feedbackState();
  st.shows += 1;
  st.shownAt = Date.now();
  st.offeredAt = 0;
  st.card = 3;
  _saveFeedbackState(st);
}

// Assembled at runtime rather than sitting in the bundle as a literal, which
// stops the crudest address scrapers and nothing else — anyone who opens the
// composer sees it, as they must.
function _feedbackAddress() {
  return ['nelsokdev', 'gmail.com'].join('@');
}

function _feedbackSentHTML() {
  const addr = _feedbackAddress();
  return `<div class="card fbk-card">
    <div class="fbk-title">Thanks</div>
    <p class="fbk-text">If your mail app didn’t open, there’s no mail account set
      up on this device. You can copy the address and send from anywhere:
      <span class="fbk-addr">${esc(addr)}</span></p>
    <div class="fbk-actions">
      <button class="fbk-btn" data-click-action="copyFeedbackAddress">Copy address</button>
      <button class="fbk-btn fbk-btn-alt" data-click-action="doneFeedback">Done</button>
    </div>
  </div>`;
}

function _feedbackCardHTML() {
  return `<div class="card fbk-card">
    <div class="fbk-title">Help keep this app going</div>
    <p class="fbk-text">This app is made by one person. Ratings help other people
      find it, and I read every message.</p>
    <div class="fbk-actions">
      <button class="fbk-btn" data-click-action="rateApp">★ Rate on App Store</button>
      <button class="fbk-btn" data-click-action="sendFeedback">Send feedback</button>
    </div>
    <div class="fbk-actions">
      <button class="fbk-btn fbk-btn-alt" data-click-action="dismissFeedback">No thanks</button>
    </div>
  </div>`;
}

// Only "rated" closes the card for good; "sent" and "declined" (No thanks)
// hide it until the re-ask window passes — see _renderFeedbackCard.
// execCommand fallback: navigator.clipboard is unavailable on some WKWebView
// builds and rejects without a user gesture on others.
function _copyFallback(text, done, onFail) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'fbk-copy-sink';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);   // iOS ignores select() on its own
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) { done(); return; }
  } catch (_) {}
  onFail();
}

function _closeFeedbackCard(why) {
  // A tap is proof it was seen, even if the observer never saw half of it.
  _unwatchFeedbackCard();
  _recordFeedbackShow();
  const st = _feedbackState();
  st.closedAt = Date.now();
  st.closedWhy = why;
  st.pending = false;
  _saveFeedbackState(st);
  _fbkShownThisSession = false;
  const el = document.getElementById('wx-feedback-card');
  if (el) el.innerHTML = '';
}

// ── Update-available card ────────────────────────────────────────────────────
//
// iOS updates apps automatically by default, so most people are on the latest
// version within a day or two. This is for the rest — auto-update off, or a
// phone that rarely charges on Wi-Fi — who would otherwise keep running a
// version with a known-wrong number in it (1.12.7 overstated snowfall up to
// sixfold until 1.20.0).
//
// A pop-up over the top of the Weather screen, but never a block: one tap
// anywhere outside it closes it, it never opens while an alert is active (and
// gets out of the way if one arrives), and it sits under the alert toast — a
// weather app must not stand between someone and a warning to sell them an
// update. It waits UPDATE_GRACE_DAYS after the release, so the people
// auto-update is about to reach never see it; "Not now" hides it until the
// next version, "Update" until the next session.
//
// The store's version comes from Apple's public lookup API. The request
// carries only the app's own App Store ID — nothing about the user or where
// they are — and runs at most once a day. Apple caches that answer for up to
// a day as well, so the card can trail a release; it never leads one.
const UPDATE_KEY = 'noaa_update_v1';  // { checkedAt, triedAt, version, released, minOs, notes, dismissed }
const UPDATE_CHECK_MS = 24 * 3600e3;  // once a day on success...
const UPDATE_RETRY_MS = 3600e3;       // ...hourly after a failure
const UPDATE_GRACE_DAYS = 2;          // let automatic updates go first
const UPDATE_LOOKUP_URL = `https://itunes.apple.com/lookup?id=${APP_STORE_ID}&country=us`;

// Numeric, part by part: '1.20.0' is newer than '1.12.7', which a string
// comparison gets backwards. Missing parts count as 0 ('1.2' == '1.2.0').
// Returns >0 when a is newer, <0 when b is, 0 when equal or unparseable.
function compareVersions(a, b) {
  const pa = String(a || '').split('.'), pb = String(b || '').split('.');
  if (!/^\d+(\.\d+)*$/.test(String(a || '')) || !/^\d+(\.\d+)*$/.test(String(b || ''))) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (+pa[i] || 0) - (+pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The iOS version from the WebView's user agent ("CPU iPhone OS 17_5 like Mac
// OS X"), or '' when it can't be read. Used only to avoid offering an update
// this device can't install — the App Store would show the old version.
function _deviceIosVersion(ua) {
  const m = /\bOS (\d+)_(\d+)(?:_(\d+))?\b/.exec(ua || '');
  return m ? [m[1], m[2], m[3] || '0'].join('.') : '';
}

// The first few "What's New" lines from the store listing, as plain text.
// Bullets and blank lines are stripped; the caller escapes.
function _updateNoteLines(notes, max = 3) {
  return String(notes || '').split(/\r?\n/)
    .map(l => l.replace(/^\s*[•\-*·]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function _updateState() {
  try {
    const raw = JSON.parse(localStorage.getItem(UPDATE_KEY) || '{}');
    return {
      checkedAt: +raw.checkedAt || 0,
      triedAt: +raw.triedAt || 0,
      version: raw.version || '',
      released: +raw.released || 0,
      minOs: raw.minOs || '',
      notes: raw.notes || '',
      dismissed: raw.dismissed || '',
    };
  } catch (_) {
    return { checkedAt: 0, triedAt: 0, version: '', released: 0, minOs: '', notes: '', dismissed: '' };
  }
}

function _saveUpdateState(st) {
  try { localStorage.setItem(UPDATE_KEY, JSON.stringify(st)); } catch (_) {}
}

// Should the card show, given this state? Pure, so the rules are testable.
function updateCardDue(st, now, appVersion, iosVersion) {
  if (!st.version || compareVersions(st.version, appVersion) <= 0) return false;
  if (st.dismissed === st.version) return false;
  if (st.released && now - st.released < UPDATE_GRACE_DAYS * 864e5) return false;
  // Can't install it here: the store would offer nothing, and the card would
  // be a promise the phone can't keep. Unknown iOS version → don't block.
  if (st.minOs && iosVersion && compareVersions(st.minOs, iosVersion) > 0) return false;
  return true;
}

let _updateCheckInFlight = false;

async function _checkForUpdate() {
  if (_updateCheckInFlight) return;
  const st = _updateState();
  const now = Date.now();
  if (st.checkedAt && now - st.checkedAt < UPDATE_CHECK_MS) return;
  if (st.triedAt && now - st.triedAt < UPDATE_RETRY_MS) return;
  _updateCheckInFlight = true;
  st.triedAt = now;
  _saveUpdateState(st);
  try {
    const r = await fetch(UPDATE_LOOKUP_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const a = (await r.json())?.results?.[0];
    if (!a?.version) throw new Error('no version in lookup');
    const next = _updateState();
    next.checkedAt = Date.now();
    next.version = String(a.version);
    next.released = Date.parse(a.currentVersionReleaseDate) || 0;
    next.minOs = String(a.minimumOsVersion || '');
    next.notes = String(a.releaseNotes || '').slice(0, 2000);
    _saveUpdateState(next);
    _renderUpdatePopup();
  } catch (e) {
    _warn('update check', e);
  } finally {
    _updateCheckInFlight = false;
  }
}

// Opens the pop-up over the top of the Weather screen when an update is due,
// then refreshes the stored answer in the background if it is a day old.
// Runs on every Weather render; opening is idempotent, so a poll re-render
// never flickers or re-animates a pop-up that is already up.
let _updPopClosedThisSession = false;

function _renderUpdatePopup() {
  // Native only: the web build is always the latest thing the server has.
  if (!(window.Capacitor?.isNativePlatform?.())) return;
  const pop = document.getElementById('upd-pop');
  if (!pop) return;

  const st = _updateState();
  const due = updateCardDue(st, Date.now(), APP_VERSION, _deviceIosVersion(navigator.userAgent));

  // Never during severe weather: someone with a warning over their house is
  // busy, and the warning is what the screen is for. A pop-up already up when
  // an alert arrives gets out of the way (closed, not dismissed).
  if ((wxData.alerts || []).length) { _closeUpdatePopup(); _checkForUpdate(); return; }

  if (due && !_updPopClosedThisSession && !_updateCardShowing()
      && document.querySelector('.screen.active')?.id === 's-wx'
      && !document.getElementById('toast')?.classList.contains('show')
      && !document.getElementById('onboarding-overlay')?.classList.contains('show')) {
    document.getElementById('upd-pop-card').innerHTML = _updateCardHTML(st);
    pop.classList.add('show');
    pop.setAttribute('aria-hidden', 'false');
  }

  _checkForUpdate();
}

function _closeUpdatePopup() {
  const pop = document.getElementById('upd-pop');
  if (!pop?.classList.contains('show')) return;
  pop.classList.remove('show');
  pop.setAttribute('aria-hidden', 'true');
  _updPopClosedThisSession = true;
}

function _updateCardHTML(st) {
  const lines = _updateNoteLines(st.notes);
  const notes = lines.length
    ? `<ul class="upd-notes">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '';
  return `<div class="fbk-title" id="upd-pop-title">Version ${esc(st.version)} is available</div>
    <p class="fbk-text">You're on ${esc(APP_VERSION)}. New in this update:</p>
    ${notes}
    <div class="fbk-actions">
      <button class="fbk-btn" data-click-action="openUpdate">Update</button>
      <button class="fbk-btn fbk-btn-alt" data-click-action="dismissUpdate">Not now</button>
    </div>`;
}

function _updateCardShowing() {
  return !!document.getElementById('upd-pop')?.classList.contains('show');
}

function renderWx() {
  const p = wxData.forecast, h = wxData.hourly;
  if (!p.length) return;
  const now = p[0];
  const nowTempF = heroTempF(now);

  document.getElementById('skyBg').style.background = sg(now.shortForecast, now.isDaytime);

  // Update active location's card in the locations list.
  // _at marks "fresh enough" so renderLocations doesn't refetch this card
  // immediately (see LOC_SUMMARY_TTL_MS).
  activeLocation._cond = now.shortForecast;
  activeLocation._temp = ft(heroTempF(now));
  activeLocation._icon = nwsIconUrl(now, 'medium');
  activeLocation._at   = Date.now();
  const condEl = document.getElementById('lcc-' + activeLocation.id);
  if (condEl) condEl.textContent = now.shortForecast + ' \xb7 ' + ft(now.temperature);
  const imgEl = document.getElementById('lci-' + activeLocation.id);
  if (imgEl && activeLocation._icon) { imgEl.src = activeLocation._icon; imgEl.style.display = 'block'; }

  // Hero H/L from the first day+night pair. At night (first period not daytime)
  // the "high" is actually tomorrow's high — label distinguishes the two cases
  // so users don't think the high is "today's already-passed peak".
  const pair = (p[0] && p[1])
    ? { hi: p[0].isDaytime ? p[0].temperature : p[1].temperature,
        lo: p[0].isDaytime ? p[1].temperature : p[0].temperature,
        nightFirst: !p[0].isDaytime }
    : null;

  const hrsHTML = h.slice(0, 12).map((hh, i) => {
    const url = nwsIconUrl(hh, 'small');
    const fb = iconFb(hh.shortForecast, hh.isDaytime);
    return `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(hh.startTime)}</span>
      ${imgFb(url, fb, 'hr-img', 'hr-fb')}
      <span class="hrv">${ft(hh.temperature)}</span>
    </div>`;
  }).join('');

  // Weather screen shows only the next 4 periods (≈2 days). The full 7-day run
  // lives on the Details screen, one tap away via the card's "7 days ›" button.
  // Keeping all 14 here made the card 919px tall on a 414×896 phone, which
  // pushed the Area Forecast Discussion ~820px below the fold.
  const dayHTML = p.slice(0, WX_DAY_PERIODS).map(period => {
    const url = nwsIconUrl(period, 'small');
    const fb = iconFb(period.shortForecast, period.isDaytime);
    const isNight = !period.isDaytime;
    // Normalise same-day period names: "This Afternoon" / "Afternoon" → "Today"
    const label = (period.name || '')
      .replace(/^This Afternoon$/i, 'Today')
      .replace(/^Afternoon$/i, 'Today')
      .replace(/^This Morning$/i, 'Today')
      .replace(/^Today Night$/i, 'Tonight');
    // One summary line, not two. NWS's detailedForecast always opens with the
    // shortForecast wording ("Clear" → "Clear, with a low around 54. …"), so
    // rendering both put a redundant one-word line above the sentence that
    // already contained it. Prefer the detailed prose, falling back to
    // shortForecast only if the detailed text is missing.
    //
    // No character cap: .dshort clips with text-overflow:ellipsis, so the line
    // fills whatever width the device actually has instead of a fixed 50 chars
    // that left a gap on wide phones and got double-clipped on narrow ones.
    const detail  = String(period.detailedForecast || '').trim();
    const summary = detail || period.shortForecast || '';
    return `<div class="drow${isNight ? ' drow-night' : ''}" role="button" tabindex="0" aria-expanded="false" aria-label="${esc((isNight ? 'Night, ' : 'Day, ') + (period.name || '') + ' — tap for details')}" data-click-action="toggleDayDetail" data-keydown-action="_kbdClick">
      <div class="dperiod-col">
        <span class="dnm dperiod"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${isNight ? 'drow-night-ico' : 'drow-day-ico'}"><use href="#${isNight ? 'si-moon' : 'si-sun'}"/></svg> ${esc(label)}</span>
        <span class="dshort" title="${esc(detail || period.shortForecast || '')}">${esc(summary)}</span>
      </div>
      ${imgFb(url, fb, 'd-img', 'd-fb')}
      <span class="dtemp">${ft(period.temperature)}</span>
      <span class="dchev" aria-hidden="true">›</span>
    </div>`;
  }).join('');

  // #8: UV is genuinely ~0 outside peak-sun hours, so we can label those
  // honestly up front. During daylight we DON'T guess a value from the forecast
  // text — that fabricated number eroded trust. Instead the tile shows a loading
  // shimmer until fetchUVIndex() patches in the real EPA reading (or "No data").
  const _uvHour = _locHour();
  const uvDaylight = now.isDaytime && _uvHour >= 9 && _uvHour < 17;
  const heroFb = iconFb(now.shortForecast, now.isDaytime);
  const h0 = wxData.hourly[0] || {};
  const feelsLike = calcFeelsLike(h0.temperature ?? now.temperature, parseWindSpd(h0.windSpeed ?? now.windSpeed ?? ''), h0.relativeHumidity?.value ?? 60);
  const feelsDiff = feelsLike - (h0.temperature ?? now.temperature);
  const feelsSub = feelsDiff <= -3 ? 'Wind chill' : feelsDiff >= 3 ? 'Heat index' : 'Actual temp';
  const dewpointC = h0.dewpoint?.value;
  const dewpointF = dewpointC != null ? Math.round(dewpointC * 9 / 5 + 32) : null;
  const dpComfort = dewpointF == null ? '' : dewpointF >= 70 ? 'Oppressive' : dewpointF >= 60 ? 'Humid' : dewpointF >= 50 ? 'Comfortable' : 'Dry';

  const aIcon = wxData.alerts?.length ? alertNWSIcon(wxData.alerts[0].properties?.event) : null;
  // Escalate the hero banner when a threat is confirmed on the ground — see
  // alertIsConfirmed(). This is the banner users actually see at the top of the
  // Weather tab; the one inside the 24-hour card below gets the same treatment.
  const aHeroLoud = wxData.alerts?.length && alertIsConfirmed(wxData.alerts[0].properties);
  const alertBanner = wxData.alerts?.length ? `
    <div class="abanner${aHeroLoud ? ' abanner-loud' : ''}" data-click-action="goNav" data-screen="s-alerts">
      ${imgFb(aIcon, '⚠️', 'ab-img', null, null, 'font-size:18px')}
      <span class="_s-9954c3">${esc(wxData.alerts[0].properties?.headline || 'Active weather alert')}</span>
      <span class="_s-9d0c00">NWS</span>
    </div>` : '';

  // Forecast location text for the obs credit details
  const fcstTxt = activeLocation.relCity
    ? `NWS ${esc(activeLocation.wfo)} \xb7 ${esc(activeLocation.relCity)}, ${esc(activeLocation.relState)}${activeLocation.relDistMi ? ' \xb7 ' + esc(activeLocation.relDistMi) + ' mi' : ''}`
    : `NWS ${esc(activeLocation.wfo)} \xb7 Grid ${esc(activeLocation.gx)},${esc(activeLocation.gy)}`;

  const _wxHtml = `
    <div class="wx-top">
      <div class="hero">
        <div class="hero-loc">
          <span class="hero-loc-nm">${esc(displayName(activeLocation))}</span>
          <button class="hero-share-btn" data-click-action="shareWeather" aria-label="Share weather">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
          </button>
        </div>
        <div class="hero-main">
          <span class="hero-icon-fb">${heroFb}</span>
          <div class="temp-big" id="tile-temp">${ft(nowTempF)}</div>
        </div>
        <div class="hero-cond">${esc(now.shortForecast)}</div>
        <div class="temp-rng">${pair?.nightFirst
          ? `Tonight L:${ft(pair.lo)}&nbsp;&nbsp;Tmrw H:${ft(pair.hi)}`
          : `H:${ft(pair?.hi)}&nbsp;&nbsp;L:${ft(pair?.lo)}`}</div>
        <!-- Hourly roundup. A text link in the hero rather than a card of its
             own — it's a sideways link to a text product, not something that
             earns a full row above the forecast. Hidden until
             _syncRoundupEntry() confirms the state files one (33 of 50 do). -->
        <button class="hero-link" id="rwr-entry" data-click-action="openRoundup" hidden>
          Hourly roundup <span class="clbl-chev">›</span>
        </button>
      </div>
      <div class="detg-side">
        <div class="detc">
          <div class="detl">${detlIcon('si-wind')} WIND</div>
          <div class="detv" id="tile-wind">${esc(fmtWind(now.windSpeed))}</div>
          <div class="dets" id="tile-wind-dir">${esc(now.windDirection || '')}</div>
        </div>
        <div class="detc detc-tap" role="button" tabindex="0" aria-label="UV index — tap for details"
             data-click-action="goNav" data-screen="s-uv" data-keydown-action="_kbdClick">
          <div class="detl">${detlIcon('si-uv')} UV INDEX<span class="detc-chev">&rsaquo;</span></div>
          <div class="detv" id="tile-uv">${uvDaylight ? '<span class="tile-skel"></span>' : '0'}</div>
          <div class="uvbar"><div class="uvdot" id="tile-uv-dot" data-css-left="0%"></div></div>
          <div class="dets" id="tile-uv-lbl">${uvDaylight ? '' : 'Low'}</div>
        </div>
        <div class="detc">
          <div class="detl">${detlIcon('si-precip')} PRECIP.</div>
          <div class="detv">${popPct(now.probabilityOfPrecipitation?.value) != null ? popPct(now.probabilityOfPrecipitation.value) + '%' : '--'}</div>
          <div class="dets">Chance</div>
        </div>
        <div class="detc">
          <div class="detl">${detlIcon('si-humidity')} HUMIDITY</div>
          <div class="detv" id="tile-humid">${h0.relativeHumidity?.value != null ? Math.round(h0.relativeHumidity.value) + '%' : '--'}</div>
          <div class="dets">Relative</div>
        </div>
      </div>
    </div>
    <div class="detg">
      <div class="detc">
        <div class="detl">${detlIcon('si-thermo')} FEELS LIKE</div>
        <div class="detv" id="tile-feels">${ft(feelsLike)}</div>
        <div class="dets" id="tile-feels-sub">${feelsSub}</div>
      </div>
      <div class="detc">
        <div class="detl">${detlIcon('si-eye')} VISIBILITY</div>
        <div class="detv" id="tile-vis"><span class="tile-skel"></span></div>
        <div class="dets" id="tile-vis-sub">${uVis === 'km' ? 'km' : 'mi'}</div>
      </div>
      <div class="detc detc-tap" role="button" tabindex="0" aria-label="Air quality — tap for details"
           data-click-action="goNav" data-screen="s-air" data-keydown-action="_kbdClick">
        <div class="detl">${detlIcon('si-air')} AIR QUAL.<span class="detc-chev">&rsaquo;</span></div>
        <div class="detv" id="tile-aqi"><span class="tile-skel"></span></div>
        <div class="dets" id="tile-aqi-sub">US AQI</div>
      </div>
      <div class="detc">
        <div class="detl">${detlIcon('si-dew')} DEW POINT</div>
        <div class="detv">${dewpointF != null ? ft(dewpointF) : '--'}</div>
        <div class="dets">${esc(dpComfort)}</div>
      </div>
    </div>
    <div id="wx-nowcast"></div>
    ${alertBanner}
    <div id="wx-winter-card"></div>
    <div class="card">
      <!-- The whole header is the link, not just the "24h ›" button — the card
           title is what people aim at. The nested button keeps its own action;
           the dispatcher's closest() walk resolves to whichever was hit. -->
      <div class="clbl clbl-link" role="button" tabindex="0" aria-label="Hourly forecast — open"
           data-click-action="goNav" data-screen="s-hourly" data-keydown-action="_kbdClick">
        <img class="clbl-img" src="https://api.weather.gov/icons/land/day/few?size=small" loading="lazy" data-img-hide/>
        HOURLY FORECAST
        <button class="clbl-more" data-click-action="goNav" data-screen="s-hourly">24h <span class="clbl-chev">›</span></button>
      </div>
      ${hrsHTML
        ? `<div class="hrs">${hrsHTML}</div>`
        : `<div class="api-unavailable-msg">Hourly data temporarily unavailable from api.weather.gov</div>`}
    </div>
    <div class="card">
      <div class="clbl clbl-link" role="button" tabindex="0" aria-label="7-day forecast — open"
           data-click-action="goNav" data-screen="s-forecast" data-keydown-action="_kbdClick">
        <img class="clbl-img" src="https://api.weather.gov/icons/land/day/sct?size=small" loading="lazy" data-img-hide/>
        7-DAY FORECAST
        <button class="clbl-more" data-click-action="goNav" data-screen="s-forecast">Details <span class="clbl-chev">›</span></button>
      </div>
      <div class="dscroll"><div class="dlist">${dayHTML}</div></div>
      <button class="afd-expand-btn" id="day-expand-btn" data-click-action="toggleDayList">Show all 7 days &rsaquo;</button>
    </div>
    <div id="wx-clim-card"></div>
    <div class="_s-fa9415">
      <div class="clbl _s-fdf33f">
        AREA FORECAST DISCUSSION
        <span class="_s-5b34da">NWS</span>
      </div>
      <div id="discussion-body" class="afd-scroll _s-759dd7 afd-collapsed" data-click-action="expandAFD"><div class="spin _s-7555c6"></div></div>
      <button class="afd-expand-btn" id="afd-expand-btn" data-click-action="toggleAFD">Read full discussion ›</button>
      <div class="_s-111f6a">
        <span class="ldot"></span><span id="afd-meta">NWS ${esc(activeLocation.wfo)} \xb7 Area Forecast Discussion \xb7 api.weather.gov</span>
      </div>
    </div>
    <button class="card sc-entry" data-click-action="goNav" data-screen="s-spc">
      <div class="sc-entry-txt">
        <div class="sc-entry-title">STORM CENTER</div>
        <div class="sc-entry-sub">SPC outlooks, mesoscale discussions &amp; NWS text products</div>
      </div>
      <span class="clbl-chev sc-entry-chev">›</span>
    </button>
    <div id="wx-feedback-card"></div>
    <div class="obs-details" id="obs-station-credit">
      <div class="obs-summary">Data sources</div>
      <div class="_s-e23d53">
        <div class="_s-5e31b1">
          <span class="_s-0a05d5">Obs:</span>
          <span class="_s-380d63" id="obs-station-txt">Loading…</span>
        </div>
        <div class="_s-5e31b1">
          <span class="_s-0a05d5">Fcst:</span>
          <span class="_s-380d63" id="forecast-loc-txt">${fcstTxt}</span>
        </div>
      </div>
    </div>`;
  // #18: skip the DOM write when the HTML is identical to last render.
  // This is the common case on every alerts poll, which calls renderWx() to
  // refresh the alert banner even when forecast data hasn't moved.
  const wxBodyChanged = _setInnerIfChanged(document.getElementById('wx-body'), _wxHtml);
  // The async side-effects below patch their own slots, so they're cheap to
  // call regardless — but only re-run if the DOM actually changed (the
  // fetchAFD result is cached for 30 min in-process anyway).
  fetchAFD();
  fetchCurrentObs();
  fetchUVIndex();
  fetchAQI();
  _syncRoundupEntry();

  // Stretch skyBg to cover the hero + metric tiles.
  // Recompute on viewport resize / orientation change so the gradient stays
  // aligned when the user rotates or font-scales.
  // #25: drop the synchronous pre-rAF call; rAF runs after layout commit so
  // skyBg is sized to the new content without forcing an extra reflow.
  if (wxBodyChanged) requestAnimationFrame(() => { _sizeSkyBg(); _syncDayListFade(); });

  // #17: if onboarding is still up when the first forecast lands, refresh the
  // personalized conditions chip / copy on steps 2–3 with real data.
  if (document.getElementById('onboarding-overlay')?.classList.contains('show')) _obPersonalize();

  // Phase 3 (iPad): keep the map-screen forecast pane in sync with the same
  // data. No-op on phones (the pane only renders on wide landscape).
  renderMapDetail();

  // The forecast is now on screen — the one moment the app has demonstrably
  // done what it was opened for. Every other condition is checked inside;
  // deferred a beat so the paint lands before any system sheet can cover it.
  setTimeout(() => { maybeAskForReview(); }, 1500);

  // Climate headline. Async and additive — the card is absent until it has
  // something true to say.
  _renderClimateCard();

  // Update available: a pop-up over the hero. Opened before the feedback ask,
  // which stands aside while it shows — see _renderFeedbackCard.
  _renderUpdatePopup();

  // Feedback ask. Also additive, and gated on its own state — see above.
  _renderFeedbackCard();

  // Next two hours of precipitation. Silent unless there is some.
  _renderNowcast();

  // Snow, ice and winter storm severity for the next days. Silent unless there
  // is something to say (winterHasNews) — which is most of the year.
  if (typeof renderWinterCard === 'function') renderWinterCard();
}

// ── iPad Phase 3: forecast detail pane beside the map (wide landscape only) ──
// The pane (#map-detail-pane) is display:none except on wide landscape iPads,
// where #s-map becomes a two-pane master-detail. It is populated from the same
// wxData the Weather screen uses, so it needs no extra fetching and stays in
// sync. Guarded by _mapDetailMQ so it does zero work on phones/portrait — the
// iPhone map screen is unaffected.
const _mapDetailMQ = window.matchMedia('(min-width:1024px) and (orientation:landscape)');

function renderMapDetail() {
  const pane = document.getElementById('map-detail-pane');
  if (!pane || !_mapDetailMQ.matches) return;
  const p = wxData.forecast;
  if (!p || !p.length) { pane.innerHTML = ''; return; }
  const now = p[0];
  const pair = (p[0] && p[1])
    ? { hi: p[0].isDaytime ? p[0].temperature : p[1].temperature,
        lo: p[0].isDaytime ? p[1].temperature : p[0].temperature,
        nightFirst: !p[0].isDaytime }
    : null;
  const heroFb = iconFb(now.shortForecast, now.isDaytime);
  const rows = p.slice(0, 8).map(period => {
    const url = nwsIconUrl(period, 'small');
    const fb = iconFb(period.shortForecast, period.isDaytime);
    const label = (period.name || '')
      .replace(/^This Afternoon$/i, 'Today').replace(/^Afternoon$/i, 'Today')
      .replace(/^This Morning$/i, 'Today').replace(/^Today Night$/i, 'Tonight');
    return `<div class="mdp-row${period.isDaytime ? '' : ' mdp-night'}">
      <span class="mdp-rlabel">${esc(label)}</span>
      ${imgFb(url, fb, 'mdp-rimg', 'mdp-rfb')}
      <span class="mdp-rtemp">${ft(period.temperature)}</span>
    </div>`;
  }).join('');
  pane.innerHTML = `
    <div class="mdp-now">
      <div class="mdp-loc">${esc(displayName(activeLocation))}</div>
      <div class="mdp-templine">
        <span class="mdp-temp">${ft(now.temperature)}</span>
        ${imgFb(nwsIconUrl(now, 'small'), heroFb, 'mdp-now-img', 'mdp-now-fb')}
      </div>
      <div class="mdp-cond">${esc(now.shortForecast)}</div>
      <div class="mdp-hilo">${pair ? (pair.nightFirst
        ? `Tonight L:${ft(pair.lo)} \xb7 Tmrw H:${ft(pair.hi)}`
        : `H:${ft(pair.hi)} \xb7 L:${ft(pair.lo)}`) : ''}</div>
    </div>
    <div class="mdp-hd">FORECAST</div>
    <div class="mdp-list">${rows}</div>
    <button class="mdp-more" data-click-action="goNav" data-screen="s-wx">Full weather ›</button>`;
}

// When the breakpoint flips (rotate / Split View / resize), re-render the pane
// and let Leaflet recompute its size now that the map's width changed.
_mapDetailMQ.addEventListener('change', () => {
  renderMapDetail();
  if (document.getElementById('s-map')?.classList.contains('active') &&
      typeof lmap !== 'undefined' && lmap) {
    setTimeout(() => lmap.invalidateSize(), 60);
  }
});

// The .dscroll bottom fade says "there's more below". Hide it when the list is
// scrolled to the end, and when the forecast is short enough that the list
// doesn't scroll at all — a fade over a complete list reads as clipped data.
function _syncDayListFade(list) {
  const el = list || document.querySelector('#wx-body .dlist');
  if (!el || !el.parentElement) return;
  const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  el.parentElement.classList.toggle('dscroll-end', atEnd);
}

// Scroll events don't bubble, so this listens in the capture phase: the day
// list is recreated by every renderWx() innerHTML write, which would otherwise
// mean re-binding a listener on each render.
document.addEventListener('scroll', e => {
  const el = e.target;
  if (el?.classList?.contains('dlist')) _syncDayListFade(el);
}, true);

// ── Hourly screen: keep every row on the same hours ──────────────────────────
// Each card on the Hourly screen owns its own horizontal scroller, so panning
// one used to leave the rest behind and you'd be reading 3 PM wind against
// 9 AM humidity. Scrolling any one of them now drives all the others.
//
// The `.hrs` rows share identical geometry — same 24-hour slice, same .hr cell
// width, same day-break separators at the same indices (buildGustRow /
// buildCloudRow had to be fixed to emit those in their empty-series branch) —
// so they take the source's scrollLeft verbatim and line up exactly.
//
// The precipitation chart is the exception: it's an SVG laid out at 38px per
// hour against the rows' ~58px cells, so a verbatim scrollLeft would actively
// misalign it. It gets mapped by scroll fraction instead, which pins both ends
// and stays within about half a column in between.
const _HR_CHART = '_s-b3bc9e'; // precip chart's scroll wrapper
// The horizontal grid every hour strip on the Hourly screen is laid out on,
// mirrored from styles.css (.hr min-width, .hrs gap, .hr-daybreak min-width) so
// buildPrecipChart can put each point directly over its hour cell.
// tests/static.test.mjs fails if these and the CSS drift apart.
const HR_CELL_PX = 56, HR_GAP_PX = 2, HR_BREAK_PX = 30;
let _hrSyncing = false;

// The scroll handler below used to run a getElementById + a querySelectorAll on
// every scroll event — i.e. per frame for the whole length of a drag — to
// rebuild a node list that only changes when the screen re-renders. Both are
// cached here instead.
//
// The list is rebuilt LAZILY on the next scroll after an invalidation rather
// than captured eagerly in renderHourly(). That is not incidental: when
// renderHourly() writes its HTML, the gust and cloud rows are still empty
// placeholders, and the three seasonal cards (snow level / snowfall / ice) have
// not been filled or removed yet — all of that happens later, in the
// getGridpointDataCached() callback. A list captured at write time would
// therefore be missing every gridpoint-backed row, and those rows would quietly
// stop scrolling in lockstep with the rest.
let _hrBody = null;
function _hourlyBody() {
  // Re-lookup if we have never looked, or if the node was replaced.
  if (!_hrBody || !_hrBody.isConnected) _hrBody = document.getElementById('hourly-body');
  return _hrBody;
}
function _hourlySyncEls(body) {
  if (!body._syncEls) body._syncEls = [...body.querySelectorAll('.hrs, .' + _HR_CHART)];
  return body._syncEls;
}
// Called from every path that adds, removes or replaces a row inside
// #hourly-body. Cheap — the rebuild cost is deferred to the next scroll.
function _invalidateHourlySync() {
  const body = _hourlyBody();
  if (body) body._syncEls = null;
}

document.addEventListener('scroll', e => {
  const src = e.target;
  if (!src?.classList || _hrSyncing) return;
  const isRow   = src.classList.contains('hrs');
  const isChart = src.classList.contains(_HR_CHART);
  if (!isRow && !isChart) return;
  const body = _hourlyBody();
  if (!body || !body.contains(src)) return; // Weather screen's strip scrolls alone

  _hrSyncing = true;
  _hourlySyncEls(body).forEach(el => {
    if (el === src) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    // Pixel-for-pixel for the chart too. The chart used to sync by scroll
    // FRACTION because it was drawn on a narrower grid than the strips; it now
    // shares their grid (buildPrecipChart), so equal scrollLeft = same hour.
    const target = Math.min(src.scrollLeft, max);
    // Tolerance keeps the echo scroll events from ping-ponging.
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target;
  });
  // setTimeout, not rAF: rAF never fires while the tab is hidden, which would
  // strand the flag and kill the sync entirely.
  setTimeout(() => { _hrSyncing = false; }, 0);
}, true);

function _sizeSkyBg() {
  const skyBg  = document.getElementById('skyBg');
  if (!skyBg) return;
  // Anchor on the bottom tile row. This used to prefer #obs-station-credit,
  // which sat directly under the tiles — but that block now lives below the
  // Area Forecast Discussion, and anchoring on it would stretch the gradient
  // down the whole page.
  const anchor = document.querySelector('#wx-body .detg');
  if (!anchor) return;
  // Bug fix: previously used getBoundingClientRect() which is viewport-
  // relative. When the user focused the search input on iOS, the keyboard
  // resize + scroll-into-view caused the calculation to use a shrunk
  // viewport — sky-bg got stuck taller than intended and stayed that way.
  // Switching to offsetTop / offsetHeight makes the height invariant to
  // scroll position and viewport resizes. Both elements share `.phone` as
  // their nearest positioned ancestor so the math works without walking.
  if (anchor.offsetParent === skyBg.offsetParent) {
    const h = anchor.offsetTop + anchor.offsetHeight - skyBg.offsetTop + 8;
    skyBg.style.height = h + 'px';
    return;
  }
  // Fallback for any layout where offsetParents diverge — sum offsetTop
  // up each chain to a common ancestor (body).
  const accum = el => { let y = 0, n = el; while (n) { y += n.offsetTop; n = n.offsetParent; } return y; };
  const h = accum(anchor) + anchor.offsetHeight - accum(skyBg) + 8;
  skyBg.style.height = h + 'px';
}
// Recompute when the viewport changes (rotation, font scale, window resize).
let _skyBgResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_skyBgResizeTimer);
  _skyBgResizeTimer = setTimeout(_sizeSkyBg, TIMINGS.SKY_BG_RESIZE_MS);
});

// ── Current observations (temp/wind/visibility from nearest station) ─────────

// `force` skips the TTL — used by the explicit refresh gestures.
const OBS_MAX_AGE_MS = 2 * 60 * 60 * 1000;
function _obsIsFresh(timestamp, now = Date.now()) {
  const t = Date.parse(timestamp || '');
  return Number.isFinite(t) && now - t <= OBS_MAX_AGE_MS;
}

async function fetchCurrentObs(force) {
  const myGen = _locGen; // #12
  try {
    // Ensure relativeLocation (nearest NWS reference city) is resolved.
    // This runs after renderWx() so the element exists when we update it.
    if (!activeLocation.relCity) {
      await resolveGridpoint(activeLocation).catch(() => {});
      if (_locGen !== myGen) return;
      const fcEl = document.getElementById('forecast-loc-txt');
      if (fcEl && activeLocation.relCity) {
        fcEl.textContent = `NWS ${activeLocation.wfo} \xb7 ${activeLocation.relCity}, ${activeLocation.relState}${activeLocation.relDistMi ? ' \xb7 ' + activeLocation.relDistMi + ' mi' : ''}`;
      }
    }

    // A fresh reading for this location is already in hand. Repaint from it
    // rather than refetching: renderWx() rebuilds these tiles from forecast
    // values whenever wx-body's HTML changes, so skipping the paint (not just
    // the fetch) would leave the hero on a period high/low and the visibility
    // tile stuck on its loading shimmer.
    if (!force && _obsCache.props && _obsCache.locId === activeLocation.id
        && Date.now() - _obsCache.at < OBS_FETCH_TTL_MS) {
      _paintCurrentObs(_obsCache);
      return;
    }

    const { wfo, gx, gy } = activeLocation;
    // Ask for several stations, not just the nearest. A gridpoint's station
    // list mixes airports with marine/mesonet sites, and any one station's
    // "latest" observation can legitimately carry a null temperature (sensor
    // gap, a special observation for another parameter, an inactive station
    // still listed). With limit=1 that meant silently keeping the forecast
    // period's high/low in the hero — the same bug already fixed on the widget
    // side in ios/App/NOAAWidget/WeatherData.swift.
    const stR = await nwsFetch(`https://api.weather.gov/gridpoints/${wfo}/${gx},${gy}/stations?limit=5`);
    if (_locGen !== myGen) return;
    if (!stR.ok) {
      const c = document.getElementById('obs-station-txt');
      if (c) c.textContent = 'Observation station unavailable';
      return;
    }
    const stD = await stR.json();
    if (_locGen !== myGen) return;

    // Walk the candidates until one returns an observation with a temperature.
    let stFeat = null, obsProps = null;
    for (const feat of (stD.features || [])) {
      const sid = feat?.properties?.stationIdentifier;
      if (!sid) continue;
      const r = await nwsFetch(`https://api.weather.gov/stations/${sid}/observations/latest`)
        .catch(() => null);
      if (_locGen !== myGen) return;
      if (!r?.ok) continue;
      const props = (await r.json().catch(() => null))?.properties;
      if (_locGen !== myGen) return;
      // A station that stopped reporting still answers /observations/latest
      // with its last reading, however old: 30- and 37-hour-old reports sat in
      // live 5-station lists (Seattle, West Texas; 2026-09-26). Only a recent
      // reading is shown as "now"; a stale one moves on to the next station.
      if (props?.temperature?.value != null && _obsIsFresh(props.timestamp)) { stFeat = feat; obsProps = props; break; }
    }
    if (!stFeat || !obsProps) {
      const c = document.getElementById('obs-station-txt');
      if (c) c.textContent = 'Observation station unavailable';
      return;
    }
    const stationId = stFeat.properties.stationIdentifier;
    const rawName = stFeat.properties.name || stationId;
    const stationName = shortenStationName(rawName);

    // Calculate distance from active location to observation station
    const stCoords = stFeat?.geometry?.coordinates; // [lon, lat]
    let distStr = '';
    if (stCoords && activeLocation.lat != null) {
      const mi = haversineMi(activeLocation.lat, activeLocation.lon, stCoords[1], stCoords[0]);
      distStr = ' · ' + (mi < 1 ? '<1' : Math.round(mi)) + ' mi away';
    }

    _obsCache = {
      locId: activeLocation.id, at: Date.now(),
      stationId, stationName, distStr, props: obsProps,
    };
    _paintCurrentObs(_obsCache);
  } catch (e) {
    _warn('fetchCurrentObs', e);
    const c = document.getElementById('obs-station-txt');
    if (c && c.textContent === 'Loading…') c.textContent = 'Observation station unavailable';
  } finally {
    // #20: if visibility never got a real reading (station down, no vis field,
    // or an early return), swap its loading shimmer for "N/A" instead of
    // leaving it spinning. No-op once a real value has already been written.
    _resolveVisPending(myGen);
  }
}

// Writes one observation payload into the tiles. Split out of fetchCurrentObs
// so the cached path can repaint without refetching — every DOM write below is
// against an id that renderWx() recreates, so painting is required on both
// paths even though fetching is not.
function _paintCurrentObs(c) {
  const p = c.props;
  if (!p) return;
  const { stationId, stationName, distStr } = c;

  // Update the observation station credit below the tiles
  const creditEl = document.getElementById('obs-station-txt');
  if (creditEl) creditEl.textContent = `${stationId} · ${stationName}${distStr}`;

  // Replace forecast temp with actual observed temp (NWS obs reports Celsius)
  const obsTempC = p.temperature?.value;
  const obsTempF = obsTempC != null ? (obsTempC * 9 / 5 + 32) : null;
  const tempEl = document.getElementById('tile-temp');
  if (tempEl && obsTempF != null) tempEl.textContent = ft(obsTempF);
  // Remember it so the next renderWx() seeds the hero from this rather than
  // falling back to a forecast high/low. Stamped with the observation's own
  // age (c.at), not the paint time — a repaint from cache must not reset the
  // 90-minute seed window on a reading that hasn't moved.
  if (obsTempF != null) {
    _obsTemp = { locId: activeLocation.id, tempF: obsTempF, at: c.at };
  }

  // Also patch the "Now" cell in the Hourly Forecast strip so it doesn't
  // disagree by ~1° with the live big-temp reading directly above it.
  const nowHourly = document.querySelector('#wx-body .hr.now .hrv');
  if (nowHourly && obsTempF != null) nowHourly.textContent = ft(obsTempF);

  // Keep the Locations list card in sync with the observed temp.
  if (obsTempF != null) {
    activeLocation._temp = ft(obsTempF);
    const lccEl = document.getElementById('lcc-' + activeLocation.id);
    if (lccEl && activeLocation._cond) {
      lccEl.textContent = activeLocation._cond + ' \xb7 ' + activeLocation._temp;
    }
  }

  // Wind from live obs (NWS reports km/h)
  const obsWindKmh = p.windSpeed?.value;
  const obsWindDir = p.windDirection?.value; // degrees
  const obsGustKmh = p.windGust?.value;
  const windEl = document.getElementById('tile-wind');
  const windDirEl = document.getElementById('tile-wind-dir');
  if (windEl && obsWindKmh != null) {
    const calm = obsWindKmh < 1.6; // ~ <1 mph
    if (calm) {
      windEl.textContent = 'Calm';
    } else {
      const mph = obsWindKmh / UNIT.KMH_PER_MPH;
      const val = uWind === 'kmh' ? Math.round(obsWindKmh) : Math.round(mph);
      const unit = uWind === 'kmh' ? 'km/h' : 'mph';
      windEl.textContent = val + ' ' + unit;
    }
    if (windDirEl) {
      const compass = degToCompass(obsWindDir);
      const gust = obsGustKmh != null && obsGustKmh > (obsWindKmh + 8)
        ? ' \xb7 G' + Math.round(uWind === 'kmh' ? obsGustKmh : obsGustKmh / UNIT.KMH_PER_MPH)
        : '';
      windDirEl.textContent = (calm ? '' : compass) + gust;
    }
  }

  // Humidity from live obs
  const obsRhVal = p.relativeHumidity?.value;
  const humidEl = document.getElementById('tile-humid');
  if (humidEl && obsRhVal != null) humidEl.textContent = Math.round(obsRhVal) + '%';

  // Recompute "feels like" from observed temp + observed wind + observed RH.
  // Prefer NWS-provided heatIndex / windChill if present (those are computed
  // from METAR and match what the NWS publishes); otherwise fall back to
  // calcFeelsLike() with observation inputs.
  const feelsEl    = document.getElementById('tile-feels');
  const feelsSubEl = document.getElementById('tile-feels-sub');
  if (feelsEl && obsTempF != null) {
    const hiC = p.heatIndex?.value;
    const wcC = p.windChill?.value;
    const obsRh    = p.relativeHumidity?.value;
    const obsWindK = p.windSpeed?.value; // km/h
    const obsWindMph = obsWindK != null ? obsWindK / UNIT.KMH_PER_MPH : 0;
    let feelsF, feelsSub;
    if (hiC != null) {
      feelsF   = hiC * 9 / 5 + 32;
      feelsSub = 'Heat index';
    } else if (wcC != null) {
      feelsF   = wcC * 9 / 5 + 32;
      feelsSub = 'Wind chill';
    } else {
      feelsF = calcFeelsLike(obsTempF, obsWindMph, obsRh != null ? obsRh : 60);
      const d = feelsF - obsTempF;
      feelsSub = d <= -3 ? 'Wind chill' : d >= 3 ? 'Heat index' : 'Actual temp';
    }
    feelsEl.textContent = ft(feelsF);
    if (feelsSubEl) feelsSubEl.textContent = feelsSub;
  }

  const visEl = document.getElementById('tile-vis');
  const visSubEl = document.getElementById('tile-vis-sub');
  const visM = p.visibility?.value;
  if (visEl && visM != null) {
    if (uVis === 'km') {
      const visKm = visM / 1000;
      visEl.textContent = visKm >= 16 ? '16+' : visKm.toFixed(1);
      if (visSubEl) visSubEl.textContent = 'km';
    } else {
      const visMi = visM / UNIT.M_PER_MI;
      visEl.textContent = visMi >= 10 ? '10+' : visMi.toFixed(1);
      if (visSubEl) visSubEl.textContent = 'miles';
    }
  }

  // Update forecast location credit now that renderWx() has created the element
  // and resolveGridpoint() (background fetch) has likely completed.
  const fcEl = document.getElementById('forecast-loc-txt');
  if (fcEl && activeLocation.relCity) {
    fcEl.textContent = `NWS ${activeLocation.wfo} \xb7 ${activeLocation.relCity}, ${activeLocation.relState}${activeLocation.relDistMi ? ' \xb7 ' + activeLocation.relDistMi + ' mi' : ''}`;
  }
}

// ── UV Index (EPA Envirofacts; same CPC/NWS model output) ────────────────────
// The five WHO/EPA exposure categories. Colours match the .uvbar gradient the
// tile already draws, so the tile and the UV screen read as one scale.
// `burn` is the rough time unprotected fair skin starts to burn — presented as
// an approximation in the UI, because it varies by skin type and reflection.
const UV_CATS = [
  { max: 2,        label: 'Low',       color: '#44BB44', burn: null,
    advice: 'No protection needed for most people. You can safely be outside.' },
  { max: 5,        label: 'Moderate',  color: '#FFDD00', burn: '45 minutes',
    advice: 'Take care around midday. Cover up and use sunscreen if you’ll be outside for a while.' },
  { max: 7,        label: 'High',      color: '#FF8800', burn: '25 minutes',
    advice: 'Protection needed. UV is strong enough to damage unprotected skin fairly quickly.' },
  { max: 10,       label: 'Very High', color: '#FF3B30', burn: '15 minutes',
    advice: 'Extra protection needed. Unprotected skin burns quickly, so limit time in the midday sun.' },
  { max: Infinity, label: 'Extreme',   color: '#9B2BA5', burn: '10 minutes',
    advice: 'Take all precautions. Unprotected skin can burn in minutes, so avoid the midday sun.' },
];

const UV_STEPS = [
  { icon: '🌳', text: 'Seek shade during midday hours' },
  { icon: '🧢', text: 'Wear a hat and UV-blocking sunglasses' },
  { icon: '🧴', text: 'Apply SPF 30+ and reapply every 2 hours' },
];

function uvCategory(uv) {
  return UV_CATS.find(c => uv <= c.max) || UV_CATS[UV_CATS.length - 1];
}

function uvLabel(uv) {
  return uvCategory(uv).label;
}

// Position (0–100%) along the .uvbar / .uv-scale gradient, which runs 0–11+.
function _uvScalePct(uv) {
  return Math.max(0, Math.min(100, (Math.max(0, uv) / 11) * 100));
}

// UV of 3 is the WHO threshold where protection starts being recommended.
const UV_PROTECT_THRESHOLD = 3;

const _uvHourLabel = h => `${(h % 12) || 12}${h < 12 ? 'a' : 'p'}`;
const _uvHourLong  = h => `${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}`;

function updateUVTile(uv) {
  const uvEl  = document.getElementById('tile-uv');
  const dotEl = document.getElementById('tile-uv-dot');
  const lblEl = document.getElementById('tile-uv-lbl');
  if (!uvEl) return;
  uvEl.textContent = uv;
  if (dotEl) dotEl.style.left = Math.min(100, Math.round((uv / 11) * 100)) + '%';
  if (lblEl) lblEl.textContent = uvLabel(uv);
}

// #8/#20: a metric tile renders a loading shimmer until its async source lands.
// If every source fails we swap the shimmer for an honest em-dash + a "No data"
// sublabel rather than leaving a spinner forever (or, for UV, the old fabricated
// keyword guess). No-ops once the tile already holds a real value.
function _resolveTileSkel(valId, subId, subText) {
  const el = document.getElementById(valId);
  if (!el || !el.querySelector('.tile-skel')) return;
  el.textContent = '—';
  if (subId) { const s = document.getElementById(subId); if (s) s.textContent = subText; }
}
function _resolveUVPending(myGen)  { if (_locGen === myGen) _resolveTileSkel('tile-uv', 'tile-uv-lbl', 'No data'); }
function _resolveVisPending(myGen) { if (_locGen === myGen) _resolveTileSkel('tile-vis', 'tile-vis-sub', 'N/A'); }
function _resolveAQIPending(myGen) { if (_locGen === myGen) _resolveTileSkel('tile-aqi', 'tile-aqi-sub', 'No data'); }

// Reverse-geocode lat/lon → 5-digit US ZIP via the US Census Bureau's free
// Geocoder. No API key, no rate limit, government-stable. Replaces the
// Nominatim path for resolveZip (audit issue B9).
//
// Census returns "Zip Code Tabulation Areas" (ZCTAs). These are statistical
// proxies for USPS ZIPs — they match ~99% of residential addresses, and the
// EPA UV endpoint we feed this into accepts ZCTAs interchangeably with ZIPs.
//
// CORS caveat: Census's response does not set Access-Control-Allow-Origin,
// so browser fetch() throws "Failed to fetch". The deployed iOS app uses
// CapacitorHttp (`"CapacitorHttp": {"enabled": true}` in capacitor.config.json),
// which patches fetch to route through native HTTP — that path bypasses CORS
// and the call succeeds. resolveZip below tries Census first and falls back
// to a Photon probe loop so web users keep working.
// The one request in the app that cannot go through a normal fetch on native.
//
// CapacitorHttp used to be enabled process-wide, which routed EVERY request
// through the native HTTP stack and so bypassed CORS for all of them. That also
// made the CSP's connect-src allowlist unenforceable on the shipped app, since
// the interceptor rewrites each GET to a same-origin URL. Turning it off makes
// connect-src bind again — at the cost of this one endpoint, because Census
// serves no Access-Control-Allow-Origin at all.
//
// So the bypass is now requested explicitly, for this call only: the
// CapacitorHttp *plugin* remains available and callable even with the automatic
// fetch/XHR patching disabled — `enabled: false` only turns off the patching.
//
// Everything else (api.weather.gov, RIDGE2, GIBS, Open-Meteo, Photon, EPA,
// AirNow, CO-OPS, the push relay) serves CORS headers and goes through the
// ordinary fetch path, where connect-src applies. Verified against all of them.
//
// On web there is no plugin, so this falls through to fetch() and fails the
// same way it always has — resolveZip()'s Photon probe covers that.
async function _censusFetchJSON(url) {
  const http = window.Capacitor?.Plugins?.CapacitorHttp;
  const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
                      && window.Capacitor.isNativePlatform());
  if (isNative && http && typeof http.request === 'function') {
    const res = await http.request({ url, method: 'GET', readTimeout: 8000, connectTimeout: 8000 });
    if (!res || res.status < 200 || res.status >= 300) {
      throw new Error('Census HTTP ' + (res?.status ?? 'failed'));
    }
    // The plugin parses JSON responses itself; older versions hand back a string.
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Census HTTP ' + r.status);
  return r.json();
}

async function censusZip(lat, lon) {
  // Round to 4 dp — a ZCTA covers a postal district, so anything finer adds
  // nothing to the answer.
  //
  // This trim is about payload sanity, NOT about anonymity: 4 dp is ~11 m,
  // which is house-level, so it would not on its own stop a pinpoint reaching a
  // third-party geocoder (an earlier version of this comment claimed it did).
  // What actually provides that is _roundFix(), which coarsens every GPS fix to
  // ~110 m as it enters the app — so by the time a device-derived coordinate
  // reaches this line it is already rounded and the toFixed(4) below is a no-op.
  // Coordinates that arrive from a search result are a place centroid, not the
  // user's position, so they carry nothing to protect either way.
  const url = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates'
    + `?x=${lon.toFixed(4)}&y=${lat.toFixed(4)}`
    + '&benchmark=Public_AR_Current&vintage=Current_Current'
    + '&layers=Zip+Code+Tabulation+Areas'
    + '&format=json';
  const j = await _censusFetchJSON(url);
  // Response path: result.geographies['Zip Code Tabulation Areas'][0]
  // The ZIP code lives in either ZCTA5, GEOID, BASENAME or NAME depending on
  // the API vintage; check all three.
  const arr = j?.result?.geographies?.['Zip Code Tabulation Areas'];
  if (!Array.isArray(arr) || !arr.length) return null;
  const cand = arr[0];
  const z = cand.ZCTA5 || cand.GEOID || cand.BASENAME || cand.NAME || null;
  return (typeof z === 'string' && /^\d{5}$/.test(z)) ? z : null;
}

async function resolveZip(loc) {
  if (loc.zip) return loc.zip;

  // 1. Try US Census Geocoder. Works on native iOS via CapacitorHttp; throws
  //    in the browser preview because the API doesn't set CORS headers.
  try {
    const z = await censusZip(loc.lat, loc.lon);
    if (z) { loc.zip = z; return z; }
  } catch (_) { /* fall through to Photon */ }

  // 2. Photon reverse fallback. It resolves to the nearest OSM feature and
  //    reports that feature's postcode, so try the exact lat/lon first, then
  //    small offsets for the case where the closest feature carries no postcode
  //    or OSM holds a synthetic placeholder like "10000" (Lower Manhattan).
  const probes = [
    [loc.lat, loc.lon],
    [loc.lat + 0.01, loc.lon + 0.01], // ~0.7 mi NE
    [loc.lat - 0.01, loc.lon - 0.01], // ~0.7 mi SW
  ];
  const isPlaceholder = z => !z || /^[0-9]0000$/.test(z); // 10000, 20000, ...
  for (const [lat, lon] of probes) {
    try {
      const r = await fetch(
        `https://photon.komoot.io/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&limit=1&lang=en`,
        { signal: AbortSignal.timeout(8000) }
      );
      const d = await r.json();
      const raw = d.features?.[0]?.properties?.postcode || null;
      const z = raw ? (raw.match(/^\d{5}/) || [null])[0] : null;
      if (z && !isPlaceholder(z)) { loc.zip = z; return loc.zip; }
    } catch (e) { _warn('reverseZip', e); }
  }
  loc.zip = null;
  return null;
}

// Fetches the ZIP's hourly UV series from EPA and returns every row, parsed.
//
// EPA returns rows like { DATE_TIME: "May/25/2026 04 PM", UV_VALUE: 1 } in
// local time at the ZIP, as a rolling ~24-hour window. The window is laggy and
// usually ends a few hours before "now" — which is why the tile matches on
// absolute time (below) rather than on calendar hour, and why the UV screen
// draws only the hours EPA has actually published.
//
// Cached per ZIP so the Weather-screen tile and the UV screen share one
// request. EPA republishes hourly.
const _uvCache = new Map(); // zip → { at, rows }
const UV_TTL_MS = 30 * 60 * 1000;

// Epoch ms for a wall-clock time in an IANA zone. EPA's DATE_TIME is local time
// AT THE ZIP, and it used to be read as the phone's local time — so viewing
// Miami from California put every row three hours off: the tile showed the UV
// from three hours earlier, or "No data" once the nearest row fell outside the
// 90-minute window. Two passes settle the offset across a DST change.
function _zonedEpoch(y, mon, d, h, tz) {
  if (!tz) return new Date(y, mon, d, h).getTime();
  const guess = Date.UTC(y, mon, d, h);
  const offset = (t) => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
        day: 'numeric', hour: 'numeric', minute: 'numeric',
      }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - t;
    } catch (_) { return -new Date(t).getTimezoneOffset() * 60000; }
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

function _parseUVRows(rows, tz = _locTZ()) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  return rows.map(row => {
    const m = (row.DATE_TIME || '').match(/^(\w+)\/(\d+)\/(\d+)\s+(\d+)\s*(AM|PM)/i);
    if (!m) return null;
    const mon = MONTHS[m[1]]; if (mon == null) return null;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    let h = parseInt(m[4], 10);
    const ap = m[5].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    else if (ap === 'AM' && h === 12) h = 0;
    const t = _zonedEpoch(year, mon, day, h, tz);
    // `hour` and `dayKey` stay in the ZIP's own clock — what the chart labels
    // and the today/tomorrow split are about.
    const dayKey = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { t, date: new Date(t), hour: h, dayKey, uv: Math.round(row.UV_VALUE) };
  }).filter(p => p && Number.isFinite(p.uv)).sort((a, b) => a.t - b.t);
}

async function fetchUVHourly(loc) {
  const zip = await resolveZip(loc);
  if (!zip || !/^\d{5}$/.test(zip)) return { zip: null, rows: [] };
  const hit = _uvCache.get(zip);
  if (hit && Date.now() - hit.at < UV_TTL_MS) return { zip, rows: hit.rows };
  // C2: EPA's UV endpoint 502s frequently after ~4 PM each day; cap each
  // attempt at 6 s so a hang doesn't block the keyword-guess fallback path.
  const r = await fetch(
    `https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/${zip}/JSON`,
    { signal: AbortSignal.timeout(6_000) }
  );
  if (!r.ok) throw new Error(`EPA UV HTTP ${r.status}`);
  const rows = _parseUVRows(await r.json());
  _uvCache.set(zip, { at: Date.now(), rows });
  return { zip, rows };
}

// Row closest to now in real time, or null if the nearest one is too stale to
// describe the present. 90 minutes is enough slop to pick "4 PM" at 5 PM while
// still rejecting a row from earlier in the day at 10 PM.
function _uvRowForNow(rows) {
  const nowMs = Date.now();
  let best = null, bestDiff = Infinity;
  for (const p of rows) {
    const d = Math.abs(p.t - nowMs);
    if (d < bestDiff) { bestDiff = d; best = p; }
  }
  return best && bestDiff <= 90 * 60 * 1000 ? best : null;
}

async function fetchUVIndex() {
  const loc = activeLocation;
  const myGen = _locGen; // #12
  let resolved = false;   // #8: did we land a real value?
  try {
    const { rows } = await fetchUVHourly(loc);
    if (_locGen !== myGen) return;
    // No ZIP or no usable rows → tile falls back to "No data" via the finally.
    const best = _uvRowForNow(rows);
    if (!best) return;
    updateUVTile(best.uv);
    resolved = true;
  } catch (e) { _warn('fetchUVIndex', e); }   // N46: surface EPA fetch/parse failures on web
  finally {
    // Daytime tile still on the shimmer + no real value landed → "No data".
    if (!resolved) _resolveUVPending(myGen);
  }
}

// ── UV Index detail screen (s-uv) ────────────────────────────────────────────
// Reached by tapping the UV INDEX tile. Everything here comes from the hourly
// series fetchUVIndex() already downloads for the tile — the screen just stops
// throwing the other ~20 rows away.

// Rows belonging to one calendar day AT THE LOCATION (0 = today, 1 = tomorrow).
function _uvRowsForDay(rows, offset) {
  const key = _locDayKey(new Date(Date.now() + offset * 86400000));
  return rows.filter(r => r.dayKey === key);
}

// EPA's UV endpoint is a *forecast* product on a rolling ~21-hour window, so
// late in the evening it has already dropped most of today and filled up with
// tomorrow — at 10 PM the "today" rows are just the 5–11 PM tail (peak 3)
// while tomorrow carries the real curve (peak 10). Filtering to the calendar
// day alone would headline that tail as the day's peak, which is misleading.
//
// So: stay on today while today still has daylight ahead of it, and roll to
// tomorrow once it doesn't. The caller labels the card accordingly — the one
// thing we must not do is show tomorrow's curve under today's heading.
function _uvPickDay(rows) {
  const today = _uvRowsForDay(rows, 0);
  const tomorrow = _uvRowsForDay(rows, 1);
  const nowHour = _locHour();
  const daylightLeft = today.some(r => r.hour >= nowHour && r.uv > 0);
  if (!daylightLeft && tomorrow.some(r => r.uv > 0)) {
    return { rows: tomorrow, isToday: false };
  }
  return { rows: today, isToday: true };
}

// Trim the leading/trailing all-zero night hours so the chart spends its width
// on the part of the day that actually has sun. Keeps one zero hour on each
// side as a baseline. Falls back to the whole day if UV never rises.
function _uvChartRows(today) {
  const first = today.findIndex(r => r.uv > 0);
  if (first === -1) return today;
  let last = today.length - 1;
  while (last > first && today[last].uv === 0) last--;
  return today.slice(Math.max(0, first - 1), Math.min(today.length, last + 2));
}

function _uvHeroHTML(cur, peak, isToday) {
  const cat = uvCategory(cur.uv);
  const when = isToday ? 'Peaks' : 'Tomorrow peaks';
  const peakLine = peak && (peak.hour !== cur.hour || !isToday)
    ? `${when} at ${peak.uv} &middot; ${esc(uvLabel(peak.uv))} at ${esc(_uvHourLong(peak.hour))}`
    : 'Highest reading of the day so far';
  return `<div class="card">
    <div class="clbl">${clblIcon('si-uv')}CURRENT UV INDEX<span class="dv-tag">EPA</span></div>
    <div class="dv-now">
      <div class="dv-val" data-css-color="${cat.color}">${cur.uv}</div>
      <div class="dv-now-txt">
        <div class="dv-cat" data-css-color="${cat.color}">${esc(cat.label)}</div>
        <div class="dv-now-sub">${peakLine}</div>
      </div>
    </div>
    <div class="uv-scale"><div class="dv-dot" data-css-left="${_uvScalePct(cur.uv).toFixed(1)}%"></div></div>
    <div class="dv-ticks"><span>0</span><span>3</span><span>6</span><span>8</span><span>11+</span></div>
    <div class="dv-where">${esc(activeLocation.zip || '')} &middot; reading for ${esc(_uvHourLong(cur.hour))}</div>
  </div>`;
}

function _uvChartHTML(dayRows, isToday) {
  const chart = _uvChartRows(dayRows);
  if (chart.length < 2) return '';
  const peak = dayRows.reduce((a, b) => (b.uv > a.uv ? b : a), dayRows[0]);
  // Scale to the day's own peak (floor of 4) so a low-UV winter day still has
  // a readable shape instead of a row of slivers under a fixed 0–11 ceiling.
  const ceiling = Math.max(peak.uv, 4);
  const nowHour = _locHour();
  const cols = chart.map(r => {
    const cat = uvCategory(r.uv);
    const h = Math.max(2, Math.round((r.uv / ceiling) * 68));
    const isPeak = r.uv === peak.uv && r.hour === peak.hour;
    const isNow  = isToday && r.hour === nowHour;
    return `<div class="uv-col${isPeak ? ' peak' : ''}${isNow ? ' now' : ''}">
      <div class="uv-num">${r.uv}</div>
      <div class="uv-bar" data-css-height="${h}px" data-css-bg="${cat.color}"></div>
      <div class="uv-hr">${esc(_uvHourLabel(r.hour))}</div>
    </div>`;
  }).join('');

  // EPA's window habitually ends a few hours back. Say how far it has actually
  // published rather than drawing hours we don't have numbers for.
  const lastHour = dayRows[dayRows.length - 1].hour;
  const lag = isToday && lastHour < nowHour
    ? `<div class="uv-lag">EPA has published through ${esc(_uvHourLong(lastHour))}. Later hours appear as the feed updates.</div>`
    : '';
  return `<div class="card">
    <div class="clbl">${clblIcon('si-uv')}${isToday ? "TODAY'S UV CURVE" : "TOMORROW'S UV FORECAST"}</div>
    <div class="uv-chart">${cols}</div>
    ${lag}
  </div>`;
}

function _uvWindowHTML(dayRows, isToday) {
  const heading = `SUN PROTECTION WINDOW${isToday ? '' : ' &middot; TOMORROW'}`;
  const hot = dayRows.filter(r => r.uv >= UV_PROTECT_THRESHOLD);
  if (!hot.length) {
    return `<div class="card">
      <div class="clbl">${clblIcon('si-sun')}${heading}</div>
      <div class="uv-none">UV stays below ${UV_PROTECT_THRESHOLD} all day. Most people won’t need sun protection.</div>
    </div>`;
  }
  const start = hot[0].hour, end = hot[hot.length - 1].hour;
  const chart = _uvChartRows(dayRows);
  const spanStart = chart[0].hour, spanEnd = chart[chart.length - 1].hour;
  const span = Math.max(1, spanEnd - spanStart);
  const left  = ((start - spanStart) / span) * 100;
  const width = ((end - start + 1) / span) * 100;
  return `<div class="card">
    <div class="clbl">${clblIcon('si-sun')}${heading}</div>
    <div class="uv-win">
      <div class="uv-win-time">${esc(_uvHourLong(start))} &ndash; ${esc(_uvHourLong(end + 1))}</div>
      <div class="uv-win-sub">UV is ${UV_PROTECT_THRESHOLD} or higher, when unprotected skin starts to burn.</div>
    </div>
    <div class="uv-win-track"><div class="uv-win-fill" data-css-left="${left.toFixed(1)}%" data-css-width="${Math.min(100 - left, width).toFixed(1)}%"></div></div>
    <div class="uv-win-ends"><span>${esc(_uvHourLong(spanStart))}</span><span>${esc(_uvHourLong(spanEnd))}</span></div>
  </div>`;
}

// During the day the advice describes the reading right now. Once we've rolled
// over to tomorrow's forecast, "no protection needed" against a 0 at midnight
// is true but useless — so it describes tomorrow's peak instead, and says so.
function _uvAdviceHTML(uv, isToday) {
  const cat = uvCategory(uv);
  const steps = uv >= UV_PROTECT_THRESHOLD
    ? `<div class="uv-steps">${UV_STEPS.map(s =>
        `<div class="uv-step"><span>${s.icon}</span><span>${esc(s.text)}</span></div>`).join('')}</div>`
    : '';
  const burn = cat.burn
    ? `<div class="uv-burn">Unprotected fair skin can start to burn in roughly ${esc(cat.burn)} at this level.
       Burn times are estimates and vary by skin type, altitude, and reflection off water, sand or snow.</div>`
    : '';
  return `<div class="card">
    <div class="clbl">${clblIcon('si-heart')}${isToday ? 'WHAT THIS MEANS' : 'WHAT TO EXPECT TOMORROW'}</div>
    <div class="dv-advice"><span class="dv-advice-bar" data-css-bg="${cat.color}"></span>${esc(cat.advice)}</div>
    ${steps}${burn}
  </div>`;
}

const UV_SOURCE_NOTE = `UV index: U.S. EPA Envirofacts &middot; data.epa.gov. Values are modeled for your ZIP code and
  assume clear skies. Clouds can lower the actual UV.`;

function _uvUnavailableHTML(reason) {
  return `<div class="card">
    <div class="clbl">${clblIcon('si-uv')}UV INDEX</div>
    <div class="api-unavailable-msg">${esc(reason)}</div>
  </div>
  <div class="dv-source">${UV_SOURCE_NOTE}</div>`;
}

function _uvScreenHTML(rows) {
  const { rows: dayRows, isToday } = _uvPickDay(rows);
  if (!dayRows.length) {
    return _uvUnavailableHTML('EPA has not published UV data for this location yet.');
  }
  const peak = dayRows.reduce((a, b) => (b.uv > a.uv ? b : a), dayRows[0]);
  // Before EPA's window reaches the current hour there is no "now" reading —
  // lead with the displayed day's peak instead of showing nothing.
  const cur = _uvRowForNow(rows) || peak;
  // Overnight the current reading is 0; base the guidance on tomorrow's peak.
  const adviceUV = isToday ? cur.uv : peak.uv;
  return `${_uvHeroHTML(cur, peak, isToday)}
    ${_uvChartHTML(dayRows, isToday)}
    ${_uvWindowHTML(dayRows, isToday)}
    ${_uvAdviceHTML(adviceUV, isToday)}
    <div class="dv-source">${UV_SOURCE_NOTE}</div>`;
}

async function renderUVIndex() {
  const body = document.getElementById('uv-body');
  if (!body) return;
  const myGen = _locGen;
  const loc = activeLocation;

  // Paint straight from the cache the tile already filled, so the screen opens
  // populated rather than flashing a spinner.
  // Any cached rows are shown straight away — past their TTL too, while the
  // refetch below runs — and kept if that refetch fails. A failed refresh used
  // to replace readings that were still on screen with an error.
  const cachedZip = loc.zip && _uvCache.get(loc.zip);
  if (cachedZip && cachedZip.rows.length) {
    _setInnerIfChanged(body, _uvScreenHTML(cachedZip.rows));
  } else {
    _setInnerIfChanged(body, `<div class="ldg" role="status" aria-live="polite"><div class="spin"></div><div class="_s-5e0faa">Loading UV index&hellip;</div></div>`);
  }

  let res = null;
  try { res = await fetchUVHourly(loc); } catch (e) { _warn('fetchUVHourly', e); }
  if (_locGen !== myGen) return;
  if (!res) {
    if (!(cachedZip && cachedZip.rows.length)) _setInnerIfChanged(body, _uvUnavailableHTML('Couldn’t reach EPA’s UV service. Try again later.'));
    return;
  }
  // EPA's UV feed is keyed by ZIP, and resolveZip() can come back empty for
  // remote coordinates — the screen has to say so rather than show an empty card.
  if (!res.zip) { _setInnerIfChanged(body, _uvUnavailableHTML('UV data is published by ZIP code, and no ZIP could be found for this location.')); return; }
  if (!res.rows.length) { _setInnerIfChanged(body, _uvUnavailableHTML('EPA has no UV data for this ZIP right now.')); return; }
  _setInnerIfChanged(body, _uvScreenHTML(res.rows));
}

// ── Area Forecast Discussion ─────────────────────────────────────────────────
// AFDs are issued ~4×/day (every ~6 hr) — cache per-WFO for 30 min to avoid
// re-hitting the products API on every renderWx().
const _afdCache = {}; // wfo → { text, issuedStr, fetchedAt }
const AFD_TTL_MS = 30 * 60 * 1000;

function _applyAFD(text, issuedStr, wfo) {
  const ids = [
    { body: 'discussion-body',     meta: 'afd-meta'     },
    { body: 'ext-discussion-body', meta: 'ext-afd-meta' },
  ];
  ids.forEach(({ body, meta }) => {
    const el   = document.getElementById(body);
    const metaEl = document.getElementById(meta);
    if (el) el.textContent = text;
    if (metaEl && issuedStr) metaEl.textContent = `NWS ${wfo} \xb7 AFD issued ${issuedStr}`;
  });
}

async function fetchAFD() {
  const el = document.getElementById('discussion-body');
  if (!el) return;
  if (!activeLocation.wfo) {
    _applyAFD('Forecast discussion unavailable.', null, '');
    return;
  }
  const wfoUpper = activeLocation.wfo.toUpperCase();
  const myGen = _locGen; // #12
  const cached = _afdCache[wfoUpper];
  if (cached && (Date.now() - cached.fetchedAt) < AFD_TTL_MS) {
    _applyAFD(cached.text, cached.issuedStr, wfoUpper);
    return;
  }
  try {
    const wfo = wfoUpper;
    const listR = await nwsFetch(`https://api.weather.gov/products/types/AFD/locations/${wfo}`);
    if (_locGen !== myGen) return;
    if (!listR.ok) throw new Error('HTTP ' + listR.status);
    const listD = await listR.json();
    if (_locGen !== myGen) return;
    const latest = listD['@graph']?.[0];
    if (!latest) throw new Error('No AFD found');
    const prodR = await nwsFetch(latest['@id']);
    if (_locGen !== myGen) return;
    if (!prodR.ok) throw new Error('HTTP ' + prodR.status);
    const prodD = await prodR.json();
    if (_locGen !== myGen) return;
    const raw = (prodD.productText || '').trim();
    const text = raw.replace(/^[\s\S]*?(?=\.[A-Z]{2,}\.\.\.)/,'')
      .replace(/^\s*\n\s*\n\s*\n/gm, '\n\n')
      .trim();
    const cleaned = (text || 'No discussion text available.')
      .replace(/^&&\s*$/gm, '').replace(/^\$\$\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    let issuedStr = null;
    if (prodD.issuanceTime) {
      const issued = new Date(prodD.issuanceTime);
      issuedStr = issued.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    _afdCache[wfo] = { text: cleaned, issuedStr, fetchedAt: Date.now() };
    _applyAFD(cleaned, issuedStr, wfo);
  } catch (e) {
    if (_locGen !== myGen) return; // stale failure for a since-abandoned location
    _warn('fetchAFD', e);
    _applyAFD('Forecast discussion unavailable.', null, activeLocation.wfo?.toUpperCase() || '');
  }
}

// ── Unit settings ────────────────────────────────────────────────────────────
function setUnit(type, val, btn) {
  if (type === 'temp') uTemp = val;
  else if (type === 'wind') uWind = val;
  else if (type === 'vis') uVis = val;
  if (btn) {
    btn.closest('.unit-chips').querySelectorAll('.uchip').forEach(b => b.classList.remove('sel'));
    btn.classList.add('sel');
  }
  if (wxData.forecast.length) { renderWx(); renderHourly(); }
  if (typeof saveSettings === 'function') saveSettings();
  if (type === 'temp') _syncWidget();
  // Temperature and wind units are sent to the relay so the Day Ahead summary it
  // pushes reads in the same units as the app. Visibility isn't used there.
  if ((type === 'temp' || type === 'wind') && window.pushNative) window.pushNative.syncLocation();
}

// Syncs the active location + display units into the shared App Group so the
// iOS widget extension can read them. No-op on web (plugin not present).
// Also ships the full saved-locations list (any entry with a resolved NWS
// gridpoint) so a widget can be pinned to a specific saved location via
// Edit Widget, independent of whichever location the app itself is showing.
function _syncWidget() {
  const plugin = window.Capacitor?.Plugins?.NOAAEnv;
  if (!plugin || typeof plugin.syncWidgetSettings !== 'function') return;
  const loc = activeLocation;
  if (!loc?.wfo || !loc?.zone) return;
  const locations = SAVED_LOCS
    // Exclude the app's own GPS entry ('gps', named "Current Location") — the
    // widget already has its own distinct "Current Location" sentinel (see
    // LocationEntity.current in NOAAWidget.swift), and syncing this one too
    // would show two identically-named entries in the Edit Widget picker.
    .filter(l => l.id !== 'gps' && l.wfo && l.zone && l.gx != null && l.gy != null)
    .map(l => ({ id: l.id, name: l.name, wfo: l.wfo, zone: l.zone, gx: l.gx, gy: l.gy, lat: l.lat, lon: l.lon }));
  plugin.syncWidgetSettings({
    uTemp,
    locName: loc.name,
    locWfo:  loc.wfo,
    locZone: loc.zone,
    locGx:   loc.gx,
    locGy:   loc.gy,
    locLat:  loc.lat,
    locLon:  loc.lon,
    locations,
  }).catch(err => {
    // Deliberately not routed through _warn() — that helper skips logging
    // entirely on native, which is exactly where this needs to be visible
    // (attach Safari Web Inspector to the device to see it).
    console.warn('[noaa-wx] syncWidgetSettings failed:', err);
  });
}

// Resolves the device's actual GPS position to an NWS gridpoint/zone —
// shared by the widget's "Current Location" sync, background-push dual-zone
// registration, and the Alerts screen's "also show alerts near me" fetch.
// Cached briefly so those callers (which can all run within moments of each
// other, e.g. on boot) don't each trigger their own GPS fix + NWS lookup.
//
// `requestIfNeeded` controls whether to prompt for location permission when
// it isn't already granted — callers that just want to silently piggyback on
// an existing grant (never surprise the user with an unexpected prompt) pass
// false; the widget sync, which already established prompting as expected
// here, passes true. Either way this never throws — any failure just means
// "no GPS location available right now," which every caller already treats
// as normal (falls back to whatever they use when GPS isn't available).
let _gpsZoneCache = null; // { name, wfo, zone, gx, gy, lat, lon, at }
let _gpsZoneInflight = null;
let _gpsZoneInflightRequested = false;
const GPS_ZONE_CACHE_MS = 20 * 60 * 1000;
// Zone resolution rounds the fix to an NWS forecast zone, so a coarse,
// cache-tolerant position is exactly as correct as a GPS-grade one and returns
// in milliseconds instead of seconds. maximumAge lets iOS hand back the fix it
// already has rather than powering the radio up again.
const COARSE_POS_OPTS = { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 8000 };

// ── GPS precision ────────────────────────────────────────────────────────────
// Every raw fix passes through here before it enters the app, so the rounding
// happens ONCE at the source and every downstream consumer inherits it: the NWS
// gridpoint lookup, the alerts point query, the push relay, the widget, and the
// map's fly-to. Rounding at each call site instead is how the NWS endpoints
// ended up as the only ones sending full precision while every third-party call
// carefully trimmed theirs.
//
// 3 dp is ~110 m. That is far finer than anything it feeds — an NWS gridpoint is
// ~2.5 km across, and a forecast zone is a county — so it is lossless for every
// result the app derives from it. It is also smaller than typical phone GPS
// error, so it costs nothing in practice. What it does buy: the coordinates we
// hand api.weather.gov and the relay identify a neighbourhood rather than a
// building. 4 dp (~11 m) would not — that is house-level.
//
// Returns Numbers, not strings: push.js gates on `typeof loc.lat === 'number'`,
// and the location id / cache keys call .toFixed() on these downstream.
const GPS_PRECISION_DP = 3;
function _roundFix(coords) {
  return {
    lat: +Number(coords.latitude).toFixed(GPS_PRECISION_DP),
    lon: +Number(coords.longitude).toFixed(GPS_PRECISION_DP),
  };
}

// The fourth way an unrounded device fix can reach NWS: a 'gps' location saved
// by a build that predates _roundFix still holds full precision in
// localStorage, and boot() feeds it straight to fetchAlerts/resolveGridpoint —
// so upgrading alone would not stop the leak; the user would have to tap "use
// my location" again to overwrite it. Round it on load instead.
//
// Scoped to the GPS entry on purpose. Saved search results also carry more
// decimals than needed, but those are a geocoder place centroid, not the user's
// position, so there is nothing to coarsen and rounding them would only make
// the stored coordinate disagree with the id derived from it.
function _migrateLocPrecision(loc) {
  if (loc && loc.id === 'gps' && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
    const r = _roundFix({ latitude: loc.lat, longitude: loc.lon });
    loc.lat = r.lat;
    loc.lon = r.lon;
  }
  return loc;
}
async function _resolveGPSZone(requestIfNeeded) {
  if (_gpsZoneCache && Date.now() - _gpsZoneCache.at < GPS_ZONE_CACHE_MS) return _gpsZoneCache;
  // Callers cluster on boot (alerts merge, push registration, widget sync).
  // Without this they each start their own fix + /points lookup, paying the
  // latency three times over and racing to fill the same cache slot.
  //
  // A requestIfNeeded:true caller can't ride on a :false one — that call
  // returns null rather than prompting, and the prompt is the whole point of
  // passing true — so it starts its own resolve. The reverse is fine.
  if (_gpsZoneInflight && (!requestIfNeeded || _gpsZoneInflightRequested)) return _gpsZoneInflight;
  _gpsZoneInflightRequested = !!requestIfNeeded;
  _gpsZoneInflight = _resolveGPSZoneUncached(requestIfNeeded)
    .finally(() => { _gpsZoneInflight = null; });
  return _gpsZoneInflight;
}

async function _resolveGPSZoneUncached(requestIfNeeded) {
  const Geo = window.Capacitor?.Plugins?.Geolocation;
  if (!Geo) return null;
  try {
    let perm = typeof Geo.checkPermissions === 'function' ? await Geo.checkPermissions() : null;
    if (perm && perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      if (!requestIfNeeded || typeof Geo.requestPermissions !== 'function') return null;
      perm = await Geo.requestPermissions();
    }
    if (!perm || (perm.location !== 'granted' && perm.coarseLocation !== 'granted')) return null;
    const pos = await _getCurrentPosition(COARSE_POS_OPTS);
    const { lat, lon } = _roundFix(pos.coords);   // SEC-5: rounded once, at the source
    const r = await nwsFetch(`https://api.weather.gov/points/${lat},${lon}`);
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.properties;
    const rel = p.relativeLocation?.properties;
    const zone = p.forecastZone?.split('/').pop() || '';
    // County zone as well as the forecast zone — see the county note in
    // syncLocation() (push.js): many null-geometry products, air quality
    // alerts among them, are filed against county UGCs rather than forecast
    // zones, and the relay has to be able to match either.
    const county = p.county?.split('/').pop() || '';
    const name = rel?.city && rel?.state ? `${rel.city}, ${rel.state}` : 'Current Location';
    _gpsZoneCache = { name, wfo: p.gridId, zone, county, gx: p.gridX, gy: p.gridY, lat, lon, at: Date.now() };
    return _gpsZoneCache;
  } catch (err) {
    // Routed through _warn(), unlike the deliberate bare console calls in
    // _syncWidget/push.js: a failed GPS resolve is normal (permission not
    // granted, no fix available) and every caller already treats null as
    // "no GPS right now", so there is nothing here a production user needs
    // to see. _warn adds the same "[noaa-wx] <label>:" prefix, so dev output
    // is unchanged.
    _warn('_resolveGPSZone', err);
    return null;
  }
}

// Quietly refreshes the widget's "Current Location" GPS reading, independent
// of whatever the user has manually set as the app's active location. Widget
// extensions can't obtain their own location permission (confirmed on-device
// — a widget isn't a foreground-interactive process, so it never even gets
// prompted), so this app-side sync on each boot/foreground is the only way
// the widget's "Current Location" option can reflect a live-ish position.
//
// Requests location permission if it isn't already (persistently) granted —
// "Allow Once" reverts to "prompt" on the next app launch, so a plain check
// alone would never get past that state. iOS only re-shows the system
// dialog while status is undetermined/"prompt"; it never re-prompts after an
// explicit "Don't Allow", so this can't nag on every boot.
// `requestIfNeeded` is true on boot (where prompting was already the expected
// behaviour) and false on foreground returns, which must never surprise anyone
// with a permission dialog.
async function _syncWidgetGPS(requestIfNeeded = true) {
  const plugin = window.Capacitor?.Plugins?.NOAAEnv;
  if (!plugin || typeof plugin.syncWidgetGPSLocation !== 'function') return;
  const loc = await _resolveGPSZone(requestIfNeeded);
  if (!loc) return;
  await plugin.syncWidgetGPSLocation(loc).catch(() => {});
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function loadSavedLocs() {
  try {
    const s = JSON.parse(localStorage.getItem('noaa_saved_locs') || 'null');
    if (Array.isArray(s) && s.length) {
      // s[0] is always the active location from the previous session (saveSavedLocs
      // guarantees this). Merge it into the shared activeLocation / SAVED_LOCS[0]
      // object in-place so the header and weather fetches start with the right
      // location on cold boot — no network round-trip required.
      // Migrate before merging: a pre-palette install persisted a raw `grad`
      // string, and Object.assign would copy it straight onto the live
      // location. _migrateLocGradient maps it to a key and drops it.
      s.forEach(_migrateLocGradient);
      // Same reason, for the coordinate: a pre-SEC-5 'gps' entry holds a
      // full-precision device fix that boot() would send to NWS as-is.
      s.forEach(_migrateLocPrecision);
      if (s[0] && s[0].id) Object.assign(SAVED_LOCS[0], s[0]);
      // Remaining entries are saved but inactive locations.
      const extras = s.slice(1).filter(l => l && l.id);
      SAVED_LOCS.splice(1, SAVED_LOCS.length - 1, ...extras);
    }
  } catch(_) {}
}

// Persist SAVED_LOCS without the transient summary fields. Issue #9: previously
// JSON.stringify(SAVED_LOCS) included _cond/_temp/_icon/_tideStation, so the
// next reload showed cached hour-old conditions until each card refetched.
// Always writes activeLocation as s[0] so loadSavedLocs() can restore it on boot.
function saveSavedLocs() {
  try {
    const rest = SAVED_LOCS.filter(l => l.id !== activeLocation.id);
    const ordered = [activeLocation, ...rest];
    // `grad` is stripped alongside the transient fields: a legacy raw gradient
    // string must never be written back, or a migrated install would re-persist
    // the very value the palette lookup exists to stop consuming.
    const persisted = ordered.map(({ _cond, _temp, _icon, _tideStation, _at, grad, ...keep }) => keep);
    localStorage.setItem('noaa_saved_locs', JSON.stringify(persisted));
  } catch (_) {}
}

// Map of action name → handler. Populated once at script-load before boot.
// Handlers receive (el, event) — `el` is the element with the matching
// data-{event}-action attribute. Per-action arguments come from el.dataset.
registerActions({
  // Navigation / settings
  openSettings:        () => openSettings(),
  goNav:               (el) => goNav(el.dataset.screen, el),
  dismissToast:        (_, e) => { e?.stopPropagation?.(); dismissToast(); },
  clearAllNotifs:      () => clearAllNotifs(),

  // Weather screen
  fetchWx:             () => fetchWx(),
  fetchAlerts:         () => fetchAlerts(),
  // Tapping the "updated N min ago · tap to refresh" strip is an explicit
  // refresh, so it drops the observation cache — otherwise renderWx()'s
  // fetchCurrentObs() would repaint the same reading it already had.
  refreshFromStrip:    () => { invalidateObsCache(); fetchWx(); fetchAlerts(); },
  expandMarine:        () => expandMarine(),
  hrCellTap:           (el) => hrCellTap(el, el.dataset.ts, el.dataset.sf),
  shareWeather:        () => shareWeather(),

  // Map screen
  toggleMapFullscreen: () => toggleMapFullscreen(),
  refreshMapBtn:       (el) => refreshMapBtn(el),
  toggleMapSheet:      () => toggleMapSheet(),
  toggleMapAlerts:     (el) => toggleMapAlerts(el.checked),
  toggleAlertTier:     (el) => toggleAlertTier(el.dataset.tier),
  setBase:             (el) => setBase(el.dataset.mode, el),
  setProd:             (el) => setProd(el.dataset.prod, el),
  setSatProd:          (el) => setSatProd(el.dataset.prod, el),
  setLoopLen:          (el) => setLoopLen(el.dataset.len),
  toggleRadarPlay:     () => toggleRadarPlay(),
  reloadFrames:        () => reloadFrames(),
  openClimate:         () => openClimate(),
  scrubFrame:          (el) => scrubFrame(el),
  scrubFrameEnd:       (el) => scrubFrameEnd(el),
  stepFrame:           (el) => stepFrame(+el.dataset.dir),
  setAnimSpeed:        (el) => setAnimSpeed(+el.dataset.speed, el),
  setOp:               (el) => setOp(el.value),
  setAlertOp:          (el) => setAlertOp(el.value),
  closeMapPopup:       () => closeMapPopup(),
  toggleMapAlertRow:   (el) => toggleMapAlertRow(el),
  openAlertInAlerts:   (el) => openAlertInAlerts(el.dataset.alertId),
  toggleAreaList:      (el, e) => toggleAreaList(el, e),
  openRoundup:         () => spcOpenProduct('RWR'),

  // Alerts screen
  _toggleAlertCard:    (el) => _toggleAlertCard(el, el.dataset.alertId),

  // Notifications screen
  requestPush:         () => requestPush(),
  openNotifSettings:   () => openNotifSettings(),
  recheckNotifPerm:    () => recheckNotifPerm(),
  fireTestNotif:       () => fireTestNotif(),
  fireBriefingNotif:   () => fireBriefingNotif(true),
  onMasterChange:      (el) => onMasterChange(el.checked),
  onQuietChange:       () => onQuietChange(),
  onBriefingChange:    () => onBriefingChange(),
  setSev:              (el) => setSev(el.dataset.sev, el),
  setPoll:             (el) => setPoll(+el.value),
  setSnowLevelOffset:  (el) => { snowLevelOffset = +el.value; saveSettings(); },
  setUnit:             (el) => setUnit(el.dataset.unitType, el.dataset.unitVal, el),

  // Locations screen
  removeLocation:      (el) => removeLocation(el.dataset.locId),
  lcClick:             (el, e) => lcClick(e, el.dataset.locId),
  lcTouchStart:        (el, e) => lcTouchStart(e, el.dataset.locId),
  lcTouchMove:         (el, e) => lcTouchMove(e, el.dataset.locId),
  lcTouchEnd:          (el, e) => lcTouchEnd(e, el.dataset.locId),
  lcTouchCancel:       (el, e) => lcTouchCancel(e, el.dataset.locId),

  // Notification list swipe
  nhItemClick:         (el) => nhItemClick(el),
  removeNotifItem:     (el) => removeNotifItem(el.dataset.nid),
  nhTouchStart:        (el, e) => nhTouchStart(e, el.dataset.nid),
  nhTouchMove:         (el, e) => nhTouchMove(e, el.dataset.nid),
  nhTouchEnd:          (el, e) => nhTouchEnd(e, el.dataset.nid),
  nhTouchCancel:       (el, e) => nhTouchCancel(e, el.dataset.nid),

  // Global search row (every screen)
  onGlobalSearch:      (el) => onGlobalSearch(el),
  onGlobalSearchKey:   (el, e) => onGlobalSearchKey(el, e),
  onGlobalSearchFocus: (el) => onGlobalSearchFocus(el),
  selectGsrResult:     (el) => selectGsrResult(el, +el.dataset.idx),
  useGPS:              (el) => useGPS(el),

  // Click-div keyboard activation
  _kbdClick:           (el, e) => _kbdClick(e, el),

  // First-run onboarding overlay
  obUseGPS:            (el) => obUseGPS(el),
  obSearch:            (el) => obSearch(el),
  obSearchKey:         (el, e) => obSearchKey(el, e),
  obSelectObResult:    (el) => obSelectObResult(el, +el.dataset.idx),
  obSkip:              () => obSkip(),
  obEnableNotifs:      () => obEnableNotifs(),
  obAdvanceToStep3:    () => obAdvanceToStep3(),
  obEnableBriefing:    () => obEnableBriefing(),
  obCompleteOnboarding:() => obCompleteOnboarding(),
  // Weather screen
  toggleAFD:           (el) => toggleAFD(el),
  toggleExtAFD:        (el) => toggleExtAFD(el),
  expandAFD:           (el) => expandAFD(el),

  // Air Quality screen
  toggleAQDisc:        (el) => toggleAQDisc(el),

  // Weather screen 7-day list expand/collapse
  toggleDayList:       (el) => toggleDayList(el),

  // External link (Privacy Policy button)
  openPrivacy:         () => window.open('https://nelsok-dev.github.io/noaa-weather-privacy/', '_blank', 'noopener,noreferrer'),

  // ODbL attribution link in the map's Leaflet attribution control. Rendered as
  // a <span data-click-action> rather than an <a href> for the same reason
  // everything else here is: an anchor inside the WKWebView navigates away from
  // the app with no back affordance.
  openOsmCopyright:    () => window.open('https://www.openstreetmap.org/copyright', '_blank', 'noopener,noreferrer'),

  // Opens the device's mail client addressed to the project's contact inbox
  // (a dedicated, non-personal address). Address assembled from parts at
  // runtime so the literal string isn't in the bundle for scrapers to harvest;
  // subject pre-filled with the app version for context. Uses location.href —
  // window.open('mailto:', '_blank') is unreliable inside WKWebView.
  reportBug:           () => { window.location.href = 'mailto:' + ['nelsokdev', 'gmail.com'].join('@')
                              + '?subject=' + encodeURIComponent(`Bug Report — NOAA Weather Unofficial v${APP_VERSION}`); },

  // Weather-screen feedback card (see _renderFeedbackCard). Same inbox as
  // reportBug, different subject so replies are sortable; the card is closed
  // first so it is gone whether or not a mail client actually opens.
  sendFeedback:        () => {
    // Mark pending and repaint FIRST: the mailto navigation can suspend the
    // WebView, and whatever is on screen when it comes back is what the user
    // sees. Closing here is what lost the card for anyone without Mail.
    _unwatchFeedbackCard();
    _recordFeedbackShow();
    const st = _feedbackState();
    st.pending = true;
    // Clear an earlier close, or the pending card would never re-render.
    st.closedAt = 0;
    st.closedWhy = '';
    _saveFeedbackState(st);
    const el = document.getElementById('wx-feedback-card');
    if (el) el.innerHTML = _feedbackSentHTML();
    window.location.href = 'mailto:' + _feedbackAddress()
      + '?subject=' + encodeURIComponent(`Feedback — NOAA Weather Unofficial v${APP_VERSION}`);
  },
  copyFeedbackAddress: () => {
    const addr = _feedbackAddress();
    const done = () => flashInfoToast('Copied', addr);
    // execCommand first: it runs synchronously inside this click, which is
    // exactly the condition WKWebView grants. The async clipboard API is the
    // one that gets refused when the gesture has already been consumed.
    _copyFallback(addr, done, () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(addr).then(done,
          () => flashErrorToast('Copy failed', 'Write to ' + addr + ' from any mail app'));
      } else {
        flashErrorToast('Copy failed', 'Write to ' + addr + ' from any mail app');
      }
    });
  },
  // Update pop-up. The plain product page, not a deep link to the update
  // button — Apple offers none; "Update" sits right on the page. Closes for
  // this session only: if they come back without updating, it asks again
  // next session.
  openUpdate:          () => {
    _closeUpdatePopup();
    window.open(`https://apps.apple.com/app/id${APP_STORE_ID}`, '_blank', 'noopener,noreferrer');
  },
  // "Not now", or a tap on the dimmed area: hidden until the next version.
  dismissUpdate:       () => {
    const st = _updateState();
    st.dismissed = st.version;
    _saveUpdateState(st);
    _closeUpdatePopup();
  },
  doneFeedback:        () => _closeFeedbackCard('sent'),
  dismissFeedback:     () => _closeFeedbackCard('declined'),
  // The store's own review page, opened with the write-review sheet up. Not
  // requestReview(): Apple's system sheet is rate-limited and may show nothing
  // when triggered from a button, which would make this button look broken.
  rateApp:             () => {
    _closeFeedbackCard('rated');
    // They are on the rating page now; don't follow up with the system sheet
    // this cycle as well. Same record maybeAskForReview() writes when it asks.
    const rv = _reviewState();
    rv.lastAskedAt = Date.now();
    rv.askedVersion = APP_VERSION;
    _saveReviewState(rv);
    window.open(`https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`,
      '_blank', 'noopener,noreferrer');
  },

  // .drow day-row expand — also rotates the chevron
  // Expanding a day un-clamps its existing summary line rather than revealing a
  // separate .ddetail copy underneath — the summary already holds the full
  // detailedForecast, so the old markup showed the same sentence twice.
  toggleDayDetail:     (el) => {
    const line = el.querySelector('.dshort');
    const chev = el.querySelector('.dchev');
    if (!line) return;
    const open = line.classList.toggle('open');
    if (chev) chev.classList.toggle('open', open);
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
});

// ── First-run onboarding ─────────────────────────────────────────────────────
//
// Flow:
//   boot() → _isFirstRun → showOnboarding()
//     Step 1 (location):
//       • "Use My Location"  → obUseGPS()  → _obSetLocation() → obAdvanceToStep2()
//       • search result tap  → obSelectObResult() → _obSetLocation() → obAdvanceToStep2()
//       • "Skip for now"     → obSkip()    → obAdvanceToStep2()
//     Step 2 (notifications):
//       • "Enable Weather Alerts" → obEnableNotifs() → obCompleteOnboarding()
//       • "Not now"               → obCompleteOnboarding()
//
// Weather for the chosen location loads in the background during step 2 so the
// main screen is populated the moment the overlay is dismissed.

function showOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;
  overlay.classList.add('show');
  const step1 = document.getElementById('ob-step1');
  if (step1) step1.classList.add('ob-active');
  // Pulse the GPS button after the overlay has fully appeared — draws the eye
  // to the primary action without being jarring on first paint.
  setTimeout(() => {
    const gpsBtn = document.getElementById('ob-gps-btn');
    if (gpsBtn) gpsBtn.classList.add('pulse');
  }, 700);
}

// #17: drop the user's real, just-fetched conditions into the notification and
// briefing steps so the value is concrete ("it's 54° and Cloudy in Seattle")
// before we ask for permission. Safe to call repeatedly — no-ops until the
// first forecast period is available, and re-runs once it lands.
function _obPersonalize() {
  const p = wxData.forecast && wxData.forecast[0];
  if (!p) return;
  const place = displayName(activeLocation);
  const chip = document.getElementById('ob-step2-cond');
  if (chip) {
    chip.textContent = `${place} · ${ft(p.temperature)} · ${p.shortForecast || ''}`.replace(/ · $/, '');
    chip.hidden = false;
  }
  const sub2 = document.getElementById('ob-step2-sub');
  if (sub2) sub2.textContent = `Get severe weather warnings for ${place} as soon as the National Weather Service issues them, even when the app is closed.`;
  const sub3 = document.getElementById('ob-step3-sub');
  // "every day", not "every morning" — the delivery time is user-picked and
  // runs to noon.
  if (sub3) sub3.textContent = `A short ${place} forecast every day, at a time you choose.`;
}

// Transition from step 1 to step 2.
function obAdvanceToStep2() {
  const step1 = document.getElementById('ob-step1');
  const step2 = document.getElementById('ob-step2');
  if (step1) step1.classList.remove('ob-active');
  if (step2) step2.classList.add('ob-active');
  _obPersonalize();
}

// Called by both GPS and search paths once a location has been chosen.
// Removes the DEFAULT_LOC placeholder from SAVED_LOCS, advances the overlay
// to step 2, then loads weather for the real location in the background.
async function _obSetLocation(loc) {
  // Persist the onboarded flag immediately so kill-and-reopen during step 2
  // doesn't re-show step 1 on next launch.
  try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) {}

  // Keep the module-level GPS reference up to date.
  if (loc.id === 'gps') _gpsLoc = loc;

  // Show step 2 while weather loads — user never sees a spinner waiting for data.
  obAdvanceToStep2();

  // setActiveLocation handles inserting loc into SAVED_LOCS, resolving the
  // gridpoint, and kicking off fetchWx + fetchAlerts.
  const ok = await setActiveLocation(loc);

  if (!ok) {
    // The NWS lookup failed. The default location stays active AND listed (it
    // used to be removed before the switch was known to have worked, leaving
    // the app showing a place no longer in Locations), and the chosen place,
    // which never resolved, is not left behind as a card with no forecast.
    if (!loc.wfo && loc !== activeLocation) {
      const i = SAVED_LOCS.indexOf(loc);
      if (i >= 0) SAVED_LOCS.splice(i, 1);
    }
    saveSavedLocs();
    return;
  }

  // Drop the default-location placeholder now that the chosen one is live —
  // unless the user explicitly chose it.
  if (loc.id !== DEFAULT_LOC.id) {
    const defIdx = SAVED_LOCS.findIndex(l => l.id === DEFAULT_LOC.id);
    if (defIdx >= 0) SAVED_LOCS.splice(defIdx, 1);
  }

  // After resolveGridpoint fills relCity/relState, promote the GPS loc name
  // from "Current Location" to the human-readable city.
  if (loc.id === 'gps' && loc.relCity && loc.relState) {
    loc.name = `${loc.relCity}, ${loc.relState}`;
    updateLocationHeader();
    if (wxData.forecast.length) renderWx();
  }

  saveSavedLocs();
}

// ── GPS path ──────────────────────────────────────────────────────────────────
function obUseGPS(btn) {
  btn.classList.add('locating');
  btn.classList.remove('pulse');
  const origHTML = btn.innerHTML;
  btn.innerHTML = '<span class="spin-sm" aria-hidden="true"></span> Getting location…';

  _getCurrentPosition().then(async pos => {
    const { lat, lon } = _roundFix(pos.coords);   // SEC-5: rounded once, at the source
    const loc = {
      id: 'gps',
      name: 'Current Location',
      subtitle: 'GPS · ' + lat.toFixed(3) + ', ' + lon.toFixed(3),
      lat, lon,
      gradKey: 'gps',
    };
    btn.classList.remove('locating');
    btn.innerHTML = origHTML;
    await _obSetLocation(loc);
  }).catch(err => {
    btn.classList.remove('locating');
    btn.innerHTML = origHTML;
    _warn('obUseGPS', err);
    // Show the error inline under the button rather than a toast so the user
    // can immediately see the search input as an alternative.
    const subEl = document.querySelector('#ob-step1 .ob-sub');
    if (subEl) {
      const msg = err?.code === 1 || /denied|permission/i.test(err?.message || '')
        ? 'Location access is off. Search for your city below.'
        : 'Couldn\'t get your location. Search for your city below.';
      subEl.textContent = msg;
      subEl.style.color = '#ff6b6b';
    }
  });
}

// ── Search path (onboarding-specific) ────────────────────────────────────────
let _obSearchTimer = null;

function obSearch(input) {
  clearTimeout(_obSearchTimer);
  const drop = document.getElementById('ob-search-drop');
  if (!drop) return;
  if (!input.value.trim()) { drop.style.display = 'none'; return; }
  _obSearchTimer = setTimeout(
    () => _runGsrSearch(input.value, drop, 'obSelectObResult'),
    TIMINGS.SEARCH_DEBOUNCE_MS
  );
}

function obSearchKey(input, e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const drop = document.getElementById('ob-search-drop');
    const hi = drop?.querySelector('.gsr-item.kb-active') || drop?.querySelector('.gsr-item');
    if (hi) hi.click();
    return;
  }
  if (e.key === 'Escape') {
    const drop = document.getElementById('ob-search-drop');
    if (drop) drop.style.display = 'none';
  }
  // Arrow-key navigation (same logic as main search)
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const drop = document.getElementById('ob-search-drop');
  if (!drop) return;
  const items = [...drop.querySelectorAll('.gsr-item')];
  if (!items.length) return;
  e.preventDefault();
  let idx = items.findIndex(i => i.classList.contains('kb-active'));
  if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
  else                       idx = idx <= 0 ? items.length - 1 : idx - 1;
  items.forEach(i => i.classList.remove('kb-active'));
  items[idx].classList.add('kb-active');
  items[idx].scrollIntoView({ block: 'nearest' });
}

// Mirrors selectGsrResult but routes through _obSetLocation instead of
// setActiveLocation directly.
async function obSelectObResult(itemEl, idx) {
  const drop = document.getElementById('ob-search-drop');
  const results = drop?._results;
  if (!results || !results[idx]) return;
  const r = results[idx];
  drop.style.display = 'none';
  const input = document.getElementById('ob-search-input');
  if (input) input.value = '';

  const { lat, lon, name } = r;
  const id = `loc_${lat.toFixed(3)}_${lon.toFixed(3)}`;

  const loc = { id, name, lat, lon, zip: r.zip || null, gradKey: 'default' };
  await _obSetLocation(loc);
}

// ── Skip path ────────────────────────────────────────────────────────────────
// User chose not to set a location now. Persist the onboarded flag, advance to
// step 2, and load the default location's weather in the background so
// something is on screen when the overlay is dismissed.
function obSkip() {
  try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) {}
  obAdvanceToStep2();
  resolveGridpoint(activeLocation).then(() => updateLocationHeader()).catch(() => {});
  fetchWx();
  fetchAlerts();
  setPoll(+document.getElementById('poll-sel')?.value || 10);
}

// ── Step 2 → Step 3 transition ────────────────────────────────────────────────
function obAdvanceToStep3() {
  const step2 = document.getElementById('ob-step2');
  const step3 = document.getElementById('ob-step3');
  if (step2) step2.classList.remove('ob-active');
  if (step3) step3.classList.add('ob-active');
  _obPersonalize();
}

// ── Step 2: notifications ────────────────────────────────────────────────────
function obEnableNotifs() {
  // requestPush() fires the native permission dialog; then advance to step 3
  // so we can offer the Day Ahead summary too.
  if (typeof requestPush === 'function') requestPush();
  obAdvanceToStep3();
}

// ── Step 3: Day Ahead summary ────────────────────────────────────────────────
function obEnableBriefing() {
  // Enable the briefing toggle and sync the chosen time from the onboarding
  // picker into the settings select so the interval starts immediately.
  const obTime = document.getElementById('ob-briefing-time');
  const settingsTime = document.getElementById('briefing-time');
  const settingsTog  = document.getElementById('briefing-tog');
  if (obTime && settingsTime) settingsTime.value = obTime.value;
  if (settingsTog) { settingsTog.checked = true; }
  if (typeof onBriefingChange === 'function') onBriefingChange();
  if (typeof saveSettings === 'function') saveSettings();
  obCompleteOnboarding();
}

// Hides the overlay and runs the boot tasks that were deferred during onboarding
// (notification permission check, poll timer, briefing interval, etc.).
function obCompleteOnboarding() {
  try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) {}

  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) {
    // Fade out, then hide so it's removed from the accessibility tree.
    overlay.style.transition = 'opacity .3s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.style.opacity = '';
      overlay.style.transition = '';
    }, 320);
  }

  // Run the deferred boot tasks now that the user is in the app proper.
  checkPerm();
  renderNotifList();
  if (typeof _syncBriefingInterval === 'function') _syncBriefingInterval();
  if (window.pushNative) window.pushNative.init();
  // Only start the poll timer if obSkip() hasn't already started it.
  if (!pollHandle) setPoll(+document.getElementById('poll-sel')?.value || 10);
}

// N25: boot runs in four ordered phases. Each phase depends on the prior one:
//   1. hydratePersisted — pull saved state out of localStorage into module vars
//   2. buildShell       — paint DOM that depends on hydrated state
//   3. wireGestures     — attach listeners (needs DOM from phase 2)
//   4. kickOffAsync     — fire-and-forget network calls + timers (needs phases 1-3)
function boot() {
  // The cold-boot half of the count. The visibilitychange handler adds the
  // other half — returns after SESSION_RESUME_GAP_MS — but never a quick
  // switch, since a "session" should mean the user came back to the app.
  noteAppSession();

  // ── Phase 1: hydratePersisted ─────────────────────────────────────────────
  // Must precede phase 2/4: buildBottomNavs renders SAVED_LOCS, and setPoll in
  // phase 4 reads the poll-sel value that applyStoredSettings just wrote.
  loadSavedLocs();
  applyStoredSettings();
  // Paint the correct location in the header immediately from persisted data so
  // there is zero flash of the default location / the hardcoded HTML placeholder
  // before the async resolveGridpoint call completes. loadSavedLocs() already
  // merged the stored active location (including relCity/wfo) into activeLocation.
  updateLocationHeader();

  // ── Phase 2: buildShell ───────────────────────────────────────────────────
  // N2/N7: paint the clock + live-chip labels now so users don't see the
  // placeholder "LIVE" text for up to 30 s before the first tick.
  buildBottomNavs();
  tickClock();
  renderSearchRows();   // #27: populate the 6 .global-search-row placeholders
  // D6: stamp the version string into the About section from one source.
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `Version ${APP_VERSION} · ${APP_COPYRIGHT}`;

  // ── Phase 3: wireGestures ─────────────────────────────────────────────────
  // Scoped non-passive touchmove for the two swipe surfaces (see
  // _bindSwipeTargets). Bound here rather than at script load so it sits with
  // the other gesture wiring and is guaranteed to run against a built DOM.
  _bindSwipeTargets();
  bindPullToRefresh();
  // #31: was a script-load IIFE in map.js — invoke explicitly here so its
  // execution doesn't depend on the order of <script> tags in index.html.
  if (typeof bindMapPullGestures === 'function') bindMapPullGestures();

  // ── Phase 4: kickOffAsync ─────────────────────────────────────────────────
  // C8: skip SW registration in the Capacitor native shell. WKWebView's SW
  // support is partial and historically unreliable across Capacitor versions.
  const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  if (!isNative && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        // Re-check for a new SW whenever the user returns to the tab/app.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  }
  if (isNative) {
    // A pre-C8 build may have registered a service worker in this WKWebView
    // (the "historically unreliable" experience that prompted C8). iOS keeps
    // WKWebsiteDataStore — localStorage, Cache Storage, and SW registrations —
    // around across every subsequent App Store update (even reinstalls), so
    // that zombie SW would go on intercepting every fetch and serving its
    // cached old index.html/app.js/styles.css forever, regardless of how many
    // newer builds get installed. Tear it down unconditionally; this is a
    // no-op once nothing is left to clean up.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then(regs => Promise.all(regs.map(r => r.unregister())))
        .catch(() => {});
    }
    if ('caches' in window) {
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {});
    }
  }

  if (_isFirstRun) {
    // New install: show the onboarding overlay. Weather fetching, notification
    // setup, and poll timers are deferred until the user chooses a location.
    // _obSetLocation() / obSkip() / obCompleteOnboarding() handle the rest.
    //
    // Initialize native push FIRST, though: the onboarding "Enable Weather
    // Alerts" button (step 2) calls requestPush() → pushNative.requestPermission(),
    // which bails out unless pushNative.init() has marked the plugin ready. Without
    // this the primary first-run CTA silently no-ops on native iOS — no OS
    // permission dialog ever appears. init() is async + idempotent and only flips
    // _pluginReady / detects the APNs env here (no register() until permission is
    // actually granted), so it's safe to fire before the overlay.
    if (window.pushNative) window.pushNative.init();
    showOnboarding();
    // A first visit is the usual way into a shared link: its place answers the
    // overlay's "where are you?" (openAppLink → _obSetLocation).
    _consumeGotoParam();
    _listenForAppLinks();
    // Mark existing users as onboarded so the check stays consistent going
    // forward even for users who never trigger the explicit completion path.
    return;
  }

  // Returning user — stamp onboarded flag if somehow missing (e.g. pre-flag
  // installs that cleared noaa_saved_locs but kept settings).
  try {
    if (!localStorage.getItem(ONBOARDED_KEY)) localStorage.setItem(ONBOARDED_KEY, '1');
  } catch (_) {}

  checkPerm();
  renderNotifList();
  // Resolve the initial active location's full metadata (radarStation, county,
  // timeZone, relCity/State) so headers/strips don't show stale defaults.
  // We don't need to await — fetchWx will proceed with the known wfo/gx/gy.
  resolveGridpoint(activeLocation).then(() => updateLocationHeader()).catch(() => {});
  // Instant perceived load: paint last-known weather before the network round-trip.
  const _wxCached = _loadWxCache();
  if (_wxCached) {
    wxData.forecast = _wxCached.forecast;
    wxData.hourly   = _wxCached.hourly;
    try { renderWx(); }     catch (_) {}
    try { renderHourly(); } catch (_) {}
  }
  fetchWx();
  fetchAlerts();
  // #14: read the actual select value (which applyStoredSettings just set)
  // rather than hardcoding 10, so we don't start one timer at 10 and replace it
  // when the user touches the dropdown.
  setPoll(+document.getElementById('poll-sel')?.value || 10);
  // #22: briefing-check timer starts only if the user actually has the
  // Day Ahead enabled. applyStoredSettings() already rehydrated the
  // checkbox; _syncBriefingInterval reads it and starts/stops accordingly.
  if (typeof _syncBriefingInterval === 'function') _syncBriefingInterval();
  if (window.pushNative) window.pushNative.init();
  _syncWidget();
  // Fire-and-forget — never blocks boot, and quietly no-ops if location
  // permission hasn't been granted (see _syncWidgetGPS's own doc comment).
  _syncWidgetGPS();

  // A link or notification tap (below) wins over the restored screen.
  _restoreScreen();
  _consumeGotoParam();
  _listenForAppLinks();
}

// Tapping a system notification (service-worker `notificationclick`, see
// service-worker.js) opens the app at `?goto=<screenId>` so the briefing push
// — which summarizes *today's* weather — lands the user on that content
// instead of the screen the app happened to be on last. A shared link
// (appLinkFor) carries `?lat=&lon=&name=&goto=` and lands on that place.
// Reads the params once on boot and scrubs them from the URL so a refresh
// doesn't re-trigger them.
function _consumeGotoParam() {
  const search = window.location.search;
  if (!search) return;
  try { window.history.replaceState({}, '', window.location.pathname); } catch (_) {}
  // Called at the tail of boot(), after the shell/onboarding decision is made
  // — safe to navigate immediately. (Notification taps often launch the page
  // in a `hidden` state, where requestAnimationFrame callbacks are paused
  // until it becomes visible — a direct call avoids that stall entirely.)
  openAppLink(search);
}

// ── Shared links ─────────────────────────────────────────────────────────────
// One URL for both audiences. With the app installed, iOS opens it through
// the universal link (applinks:nelsok-dev.github.io, see App.entitlements);
// without it, the same URL loads the web build of this app from the
// marketing site (scripts/publish-web.mjs).
const APP_LINK_BASE = 'https://nelsok-dev.github.io/NOAA-weather-unofficial/app/';

// GPS fixes are rounded to 2 decimals (~1 km) so a share never gives away
// where someone is standing; a searched or saved place keeps 3, which is
// what its location id uses.
function appLinkFor(loc, screen) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return APP_LINK_BASE;
  const dp = loc.id === 'gps' ? 2 : 3;
  const q = new URLSearchParams({ lat: loc.lat.toFixed(dp), lon: loc.lon.toFixed(dp), name: displayName(loc) });
  if (screen && screen !== 's-wx') q.set('goto', screen);
  return `${APP_LINK_BASE}?${q}`;
}

// Parses `?lat=&lon=&name=&goto=` (a query string or a full URL). Anything
// malformed is dropped rather than half-applied.
function parseAppLink(input) {
  let q;
  try {
    q = String(input).includes('://') ? new URL(input).searchParams : new URLSearchParams(input);
  } catch (_) { return {}; }
  const out = {};
  const goto = q.get('goto');
  if (goto && /^s-[a-z]+$/.test(goto)) out.goto = goto;
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (q.get('lat') && q.get('lon') && Number.isFinite(lat) && Number.isFinite(lon)
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const name = (q.get('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    out.place = { lat, lon, name: name || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
  }
  return out;
}

async function openAppLink(input) {
  const { place, goto } = parseAppLink(input);
  if (place) {
    // First run: the place answers the onboarding's "where are you?", so the
    // overlay moves on to the alerts step instead of asking again.
    if (document.getElementById('onboarding-overlay')?.classList.contains('show')) {
      const id = `loc_${place.lat.toFixed(3)}_${place.lon.toFixed(3)}`;
      await _obSetLocation({ id, ...place, zip: null, gradKey: 'default' });
    } else {
      goNav('s-wx', null);
      if (!(await openPlace(place))) return;
    }
  }
  if (goto && document.getElementById(goto)) goNav(goto, null);
}

// Native: links that open the app arrive through @capacitor/app — the one
// that launched it via getLaunchUrl, later ones via appUrlOpen.
function _listenForAppLinks() {
  const App = window.Capacitor?.isNativePlatform?.() && window.Capacitor?.Plugins?.App;
  if (!App) return;
  // The plugin can hand the launch URL to both paths, so a URL seen in the
  // last few seconds is not opened twice.
  let last = '', lastAt = 0;
  const handle = (url) => {
    if (!url || !url.startsWith(APP_LINK_BASE.slice(0, -1))) return;
    if (url === last && Date.now() - lastAt < 5000) return;
    last = url; lastAt = Date.now();
    openAppLink(url);
  };
  App.getLaunchUrl?.().then(r => handle(r?.url)).catch(() => {});
  App.addListener?.('appUrlOpen', e => handle(e?.url));
}

// The service worker can't call goNav() directly — it lives in a different
// global scope and only runs while the page is backgrounded/closed. When the
// user taps a notification while the app is already open in a foreground tab,
// the SW instead posts this message so we can route without a reload.
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'noaa-goto' && document.getElementById(e.data.screen)) {
    goNav(e.data.screen, null);
  }
});

document.addEventListener('DOMContentLoaded', boot);

// ─────────────────────────────────────────────────────────────────────────────
// #26: window.App — single named handle for debug inspection of the
// app's cross-file state. Production code keeps using the underlying `let`s
// directly; this is just so console-poking finds them in one place instead of
// hunting through five files.
// ─────────────────────────────────────────────────────────────────────────────
window.App = Object.freeze({
  get activeLocation() { return activeLocation; },
  get SAVED_LOCS()     { return SAVED_LOCS;     },
  get wxData()         { return wxData;         },
  get units()          { return { uTemp, uWind, uVis }; },
  get notifLog()       { return notifLog;       },
  get seenIds()        { return [...seenIds];   },
  get unread()         { return unread;         },
  get locGen()         { return _locGen;        },
  get gpsLoc()         { return _gpsLoc;        },
  get pushPerm()       { return pushPerm;       },
  get minSev()         { return minSev;         },
});

// ── Hourly tab ───────────────────────────────────────────────────────────────

// NWS reports wind as either a single value ("12 mph") or a range
// ("15 to 25 mph"). Return the larger end of the range so any "peak wind"
// derivation reflects the gust top, not the floor. (B7)
function parseWindSpd(ws) {
  const nums = String(ws || '').match(/\d+/g);
  if (!nums || !nums.length) return 0;
  return nums.reduce((max, n) => Math.max(max, +n), 0);
}

// ── Probability of precipitation, the way NWS/NOAA publish it ───────────────
// api.weather.gov hands back the raw gridded PoP — 27, 16, 11, 3 — but no NWS
// product ever prints those. NWS expresses PoP in whole 10% steps, and their
// public forecasts don't mention precipitation at all below 20%.
//
// Verified against api.weather.gov across six WFOs (SEW, TBW, MFL, FFC, PSR,
// OUN): every "Chance of precipitation is X%" sentence equals
// Math.round(raw / 10) * 10 with no exceptions (15→20, 37→40, 87→90), and
// every period whose value rounds to 10 or lower carries no mention and no
// "slight chance" wording at all.
const POP_MENTION_MIN = 20;

// The value rounded to NWS's 10% step; null when there's nothing to show.
// For labelled cells that always display a number ("PRECIP. — 10%").
function popPct(value) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) / 10) * 10;
}

// The same value, but only when NWS would actually mention it. For inline
// mentions — a droplet beside a forecast row, an hourly cell, a widget tile —
// where a bare "0%" or "10%" is noise NWS itself would omit.
function popMention(value) {
  const p = popPct(value);
  return p != null && p >= POP_MENTION_MIN ? p : null;
}

// Returns null for "VRB" (variable) or any unrecognized value — callers
// must render an indeterminate marker rather than a north-pointing arrow.
function windDirDeg(d) {
  const v = { N:0, NNE:22, NE:45, ENE:67, E:90, ESE:112, SE:135, SSE:157,
              S:180, SSW:202, SW:225, WSW:247, W:270, WNW:292, NW:315, NNW:337 }[d];
  return v == null ? null : v;
}

// Inverse of windDirDeg: 0–360° → 16-point compass label.
// B6: normalize the input first — JS `%` keeps the sign of the dividend, so
// (-1) % 360 → -1 → Math.round(-1/22.5)=0 → "N" (wrong; -1° ≈ 359° = NNW).
function degToCompass(deg) {
  if (deg == null || isNaN(deg)) return '';
  const d = ((Number(deg) % 360) + 360) % 360;  // → [0, 360)
  const points = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return points[Math.round(d / 22.5) % 16];
}

function calcFeelsLike(tempF, windMph, rh) {
  // Heat index applies whenever hot and humid — wind speed is irrelevant to it.
  // Checking this BEFORE wind chill matches NWS operator precedence: if it's
  // 95°F and calm, heat index (~108°F) must win over the early-return of actual.
  if (tempF >= 80 && rh >= 40) {
    const T = tempF, R = rh;
    return Math.round(-42.379 + 2.04901523*T + 10.14333127*R - 0.22475541*T*R
      - 0.00683783*T*T - 0.05481717*R*R + 0.00122874*T*T*R
      + 0.00085282*T*R*R - 0.00000199*T*T*R*R);
  }
  // Wind chill only applies when cold AND there is meaningful wind.
  if (tempF <= 50 && windMph >= 3) {
    const v = Math.pow(windMph, 0.16);
    return Math.round(35.74 + 0.6215 * tempF - 35.75 * v + 0.4275 * tempF * v);
  }
  return Math.round(tempF);
}

function buildPrecipChart(hours, gradientId = 'precipGrad-hourly') {
  const n = Math.min(hours.length, 24);
  const pops = hours.slice(0, n).map(h => popPct(h.probabilityOfPrecipitation?.value) ?? 0);
  if (Math.max(...pops) < POP_MENTION_MIN) {
    return `<div class="_s-0962aa">${clblIcon('si-sun', 'hsum-ico')}No significant precipitation expected</div>`;
  }
  const H = 80, LH = 20;
  // Lay the chart out on the SAME grid as the hour strips above and below it:
  // 56px cells, a 2px flex gap, and a 30px .hr-daybreak separator wherever two
  // hours straddle the location's midnight (decided by _dayBreakHTML, the same
  // function the strips use). The chart used to space hours 38px apart with no
  // separators, so every point after the first drifted further from its hour —
  // and the proportional scroll sync only lined the two up at the very ends.
  const cellX = [], breaks = [];
  let pos = 0, items = 0;
  const place = w => { if (items++) pos += HR_GAP_PX; const left = pos; pos += w; return left; };
  for (let i = 0; i < n; i++) {
    if (_dayBreakHTML(hours, i)) breaks.push({ i, x: place(HR_BREAK_PX) });
    cellX.push(place(HR_CELL_PX) + HR_CELL_PX / 2);
  }
  const svgW = pos;
  const pts = pops.map((p, i) => ({ x: cellX[i], y: H - (p / 100) * (H - 6) }));
  let line = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const cp = (pts[i-1].x + pts[i].x) / 2;
    line += ` C ${cp},${pts[i-1].y} ${cp},${pts[i].y} ${pts[i].x},${pts[i].y}`;
  }
  const area = `${line} L ${pts[n-1].x},${H} L ${pts[0].x},${H} Z`;
  const labels = hours.slice(0, n).map((h, i) => {
    const p = pops[i], x = pts[i].x;
    return `${p >= POP_MENTION_MIN ? `<text x="${x}" y="${pts[i].y - 5}" text-anchor="middle" fill="#5AC8FA" font-size="9" font-weight="700" font-family="-apple-system,sans-serif">${p}%</text>` : ''}
    <text x="${x}" y="${H + LH - 3}" text-anchor="middle" fill="rgba(255,255,255,.35)" font-size="9" font-family="-apple-system,sans-serif">${fh(h.startTime)}</text>`;
  }).join('');
  // Dot marker at each data point so low-value bars remain visible
  const dots = pts.map((pt, i) => pops[i] >= 5
    ? `<circle cx="${pt.x}" cy="${pt.y}" r="2.5" fill="#5AC8FA" opacity=".85"/>`
    : '').join('');
  // Reference grid lines at 25 / 50 / 75 %
  const refLines = [25, 50, 75].map(pct => {
    const y = H - (pct / 100) * (H - 6);
    return `<line x1="0" y1="${y}" x2="${svgW}" y2="${y}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>
    <text x="2" y="${y - 2}" fill="rgba(255,255,255,.18)" font-size="8" font-family="-apple-system,sans-serif">${pct}%</text>`;
  }).join('');
  // Baseline at 0 %
  const baseline = `<line x1="0" y1="${H}" x2="${svgW}" y2="${H}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>`;
  // Day-break vertical lines, drawn at the left edge of the separator slot —
  // where the strips draw their .hr-daybreak dashed border.
  const dayBreaks = breaks.map(({ i, x }) => {
    const curKey = _locDayKey(new Date(hours[i].startTime));
    const today = _locDayKey(new Date());
    const tmrw  = _locDayKey(new Date(Date.now() + 86400000));
    let label = _locWeekday(new Date(hours[i].startTime));
    if (curKey === today) label = 'Today';
    else if (curKey === tmrw) label = 'Tomorrow';
    return `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(0,180,230,.3)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${x + 4}" y="11" fill="rgba(0,180,230,.85)" font-size="9" font-weight="800" font-family="-apple-system,sans-serif">${label}</text>`;
  }).join('');
  // Now marker — vertical line at the first cell's centre
  const nowX = pts[0].x;
  const nowMarker = `<line x1="${nowX}" y1="0" x2="${nowX}" y2="${H}" stroke="#5AC8FA" stroke-width="1" stroke-dasharray="2 2" opacity=".6"/>
    <text x="${nowX + 3}" y="11" fill="#5AC8FA" font-size="9" font-weight="800" font-family="-apple-system,sans-serif">Now</text>`;
  // The gradient id is STABLE per call site, not minted fresh on every call.
  //
  // It used to come from a monotonic counter, because s-hourly and s-details
  // both drew this chart and both live in the DOM at once (screens are
  // display:none, not removed) — two id="precipGrad" defs would have collided
  // and one chart would have picked up the other's stops. That is no longer the
  // shape of the app: the Details screen stopped drawing its own chart when
  // these strips moved to Hourly, so there is exactly one call site.
  //
  // The counter was not merely redundant, it was actively harmful. It made
  // buildPrecipChart's output differ on every call, so renderHourly()'s HTML
  // never matched the previous render, `_setInnerIfChanged` always wrote, and
  // the #18 render-skip was dead for the entire Hourly tab — every poll rebuilt
  // all nine cards and re-ran the five gridpoint fills for identical data.
  //
  // If a second surface ever draws this chart again, pass it its own id rather
  // than reintroducing a counter — the id has to be stable across renders of
  // the same surface, and distinct between surfaces.
  const _gid = gradientId;
  return `<div class="_s-b3bc9e"><svg class="_s-2a1b75" width="${svgW}" height="${H + LH}">
    <defs><linearGradient id="${_gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0085CA" stop-opacity=".6"/><stop offset="100%" stop-color="#001422" stop-opacity=".05"/>
    </linearGradient></defs>
    ${refLines}
    ${baseline}
    ${dayBreaks}
    ${nowMarker}
    <path d="${area}" fill="url(#${_gid})"/>
    <path d="${line}" fill="none" stroke="#0085CA" stroke-width="1.5" opacity=".85"/>
    ${dots}
    ${labels}
  </svg></div>`;
}

// Insert a vertical day-break separator between two hour cells when they
// straddle midnight. Returns an HTML string (possibly empty).
function _dayBreakHTML(arr, i) {
  if (i === 0) return '';
  const prev = new Date(arr[i-1].startTime);
  const cur  = new Date(arr[i].startTime);
  // Day boundaries computed in the location's timezone (#7) so the break
  // lands at the location's midnight, not the device's.
  const curKey = _locDayKey(cur);
  if (_locDayKey(prev) === curKey) return '';
  const today = _locDayKey(new Date());
  const tmrw  = _locDayKey(new Date(Date.now() + 86400000));
  let label = _locWeekday(cur);
  if (curKey === today) label = 'Today';
  else if (curKey === tmrw) label = 'Tomorrow';
  return `<div class="hr-daybreak"><span>${label}</span></div>`;
}

function buildWindRow(hours) {
  const n = Math.min(hours.length, 24);
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const spd = parseWindSpd(h.windSpeed);
    const deg = windDirDeg(h.windDirection);
    const calm = spd < 2;
    const variable = !calm && deg == null;
    const spdDisp = calm ? '—' : (uWind === 'kmh' ? Math.round(spd * UNIT.KMH_PER_MPH) : spd);
    const unitLbl = calm ? '' : (uWind === 'kmh' ? 'km/h' : 'mph');
    const dimColor = 'rgba(255,255,255,.3)';
    const glyph = variable ? '–' : '↑';
    const transform = variable ? 'none' : `rotate(${deg ?? 0}deg)`;
    const color = (calm || variable) ? dimColor : '#5AC8FA';
    const dayBreak = _dayBreakHTML(hours, i);
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="_s-c2384e" data-css-transform="${transform}" data-css-color="${color}">${glyph}</span>
      <span class="hrv _s-5e0faa">${spdDisp}<span class="_s-7e7812"> ${unitLbl}</span></span>
    </div>`;
  }).join('')}</div>`;
}

// Reveal the shortForecast text for a tapped hour cell in a caption below the row.
function hrCellTap(el, ts, sf) {
  const cap = document.getElementById('hourly-tempcell-caption');
  if (!cap) return;
  if (!sf) { cap.textContent = ''; cap.style.opacity = '0'; return; }
  cap.innerHTML = `<b class="_s-2cffed">${esc(ts)}</b> · ${esc(sf)}`;
  cap.style.opacity = '1';
}

// Cloud cover row — from gridpoint `skyCover`. Mirrors what Marine tab does.
function buildCloudRow(hours, skySeries) {
  const n = Math.min(hours.length, 24);
  if (!skySeries || !skySeries.length) {
    // See buildGustRow: the empty-series branch needs the same day breaks as
    // the populated one or this row won't scroll in step with the others.
    return `<div class="hrs">${hours.slice(0, n).map((h, i) => _dayBreakHTML(hours, i) + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv _s-36338c">--</span>
    </div>`).join('')}</div>`;
  }
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const sky = getGridValueAt(skySeries, new Date(h.startTime));
    const pct = sky != null ? Math.round(sky) : null;
    const dayBreak = _dayBreakHTML(hours, i);
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv _s-5e0faa">${pct != null ? pct + '%' : '--'}</span>
    </div>`;
  }).join('')}</div>`;
}

// Humidity row — from NWS hourly `relativeHumidity`
function buildHumidityRow(hours) {
  const n = Math.min(hours.length, 24);
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const rh = h.relativeHumidity?.value;
    const dayBreak = _dayBreakHTML(hours, i);
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv">${rh != null ? Math.round(rh) + '%' : '--'}</span>
    </div>`;
  }).join('')}</div>`;
}

// Dew point row — from NWS hourly `dewpoint` (Celsius)
function buildDewpointRow(hours) {
  const n = Math.min(hours.length, 24);
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const dC = h.dewpoint?.value;
    const dF = dC != null ? dC * 9 / 5 + 32 : null;
    const dayBreak = _dayBreakHTML(hours, i);
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv">${dF != null ? ft(dF) : '--\xb0'}</span>
    </div>`;
  }).join('')}</div>`;
}

function buildFeelsRow(hours) {
  const n = Math.min(hours.length, 24);
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const rh = h.relativeHumidity?.value ?? 60;
    const ws = parseWindSpd(h.windSpeed);
    const fl = calcFeelsLike(h.temperature, ws, rh);
    const dayBreak = _dayBreakHTML(hours, i);
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv">${ft(fl)}</span>
    </div>`;
  }).join('')}</div>`;
}

// ── Hourly: Today/Next-24h summary card ──────────────────────────────────────
// Derived from data we already have on the page (wxData.hourly + alerts +
// active location's timezone). No new fetches.
function buildHourlySummary() {
  const h = wxData.hourly;
  if (!h.length) return '';
  const next24 = h.slice(0, 24);

  let hi = -Infinity, lo = Infinity;
  let peakPop = 0;
  let wetHours = 0;
  let peakWindMph = 0, peakWindDir = '';
  next24.forEach(p => {
    if (typeof p.temperature === 'number') {
      if (p.temperature > hi) hi = p.temperature;
      if (p.temperature < lo) lo = p.temperature;
    }
    const pop = popPct(p.probabilityOfPrecipitation?.value) ?? 0;
    if (pop > peakPop) peakPop = pop;
    if (pop >= 30) wetHours++;
    const w = parseWindSpd(p.windSpeed);
    if (w > peakWindMph) { peakWindMph = w; peakWindDir = p.windDirection || ''; }
  });
  if (hi === -Infinity) hi = null;
  if (lo === Infinity)  lo = null;

  // Sun times in the location's timezone — calcSunTimes lives in marine.js
  // but is loaded as a global by the time this runs.
  const sun = (typeof calcSunTimes === 'function')
    ? calcSunTimes(activeLocation.lat, activeLocation.lon, activeLocation.timeZone)
    : { rise: '—', set: '—' };

  // Wind: pick the user's unit. D10: below 5 mph counts as "calm" — showing
  // "0 mph N" or "2 mph SW" misleads readers into thinking the wind has a
  // meaningful direction. Empty dash + "Calm" subtitle is the honest read.
  const peakIsCalm = peakWindMph < 5;
  const windDisp = peakIsCalm
    ? '—'
    : (uWind === 'kmh' ? Math.round(peakWindMph * UNIT.KMH_PER_MPH) + ' km/h' : peakWindMph + ' mph');
  const peakWindSub = peakIsCalm ? 'Calm' : peakWindDir;

  // Precip subtitle
  const popSub = peakPop > 0
    ? (wetHours ? wetHours + ' hr ≥30%' : 'Brief')
    : 'Dry next 24h';

  const alert = wxData.alerts?.[0];
  const aIcon = alert ? alertNWSIcon(alert.properties?.event) : null;
  // A tornado someone has actually SEEN is not the same as one radar suspects,
  // and that difference shouldn't be one tap deep. When the tag says OBSERVED
  // the banner itself escalates; every other alert keeps the existing styling.
  const aLoud = alert && alertIsConfirmed(alert.properties);
  const alertHTML = alert ? `<div class="abanner _s-bb5a63${aLoud ? ' abanner-loud' : ''}" data-click-action="goNav" data-screen="s-alerts">
      ${imgFb(aIcon, '⚠️', 'ab-img', null, null, 'font-size:18px')}
      <span class="_s-9954c3">${esc(alert.properties?.headline || alert.properties?.event || 'Active weather alert')}</span>
      <span class="_s-9d0c00">NWS</span>
    </div>` : '';

  return `<div class="card">
    <div class="clbl">${clblIcon('si-clock')}NEXT 24 HOURS</div>
    <div class="hrly-summary">
      <div class="hsum-item">
        <div class="hsum-lbl">HIGH / LOW</div>
        <div class="hsum-val">${ft(hi)} <span class="_s-7bdef0">/</span> ${ft(lo)}</div>
      </div>
      <div class="hsum-item">
        <div class="hsum-lbl">PRECIP</div>
        <div class="hsum-val">${peakPop > 0 ? peakPop + '%' : '—'}</div>
        <div class="hsum-sub">${popSub}</div>
      </div>
      <div class="hsum-item">
        <div class="hsum-lbl">PEAK WIND</div>
        <div class="hsum-val">${windDisp}</div>
        <div class="hsum-sub">${esc(peakWindSub)}</div>
      </div>
      <div class="hsum-item">
        <div class="hsum-lbl">SUNRISE</div>
        <div class="hsum-val">${clblIcon('si-sun', 'hsum-ico')}${sun.rise}</div>
      </div>
      <div class="hsum-item">
        <div class="hsum-lbl">SUNSET</div>
        <div class="hsum-val">${clblIcon('si-moon', 'hsum-ico')}${sun.set}</div>
      </div>
    </div>
    ${alertHTML}
  </div>`;
}

// Shared gridpoint-data cache — every reader of the NWS gridpoint (hourly
// rows, winter, Storm Center's thunder strip, Detailed Conditions, snow-level
// tags, air-quality dispersion) goes through here. 30 min TTL. The payload is
// ~1 MB, and the Details screen alone used to fetch it twice on open (plus once
// more for air quality), each bypassing this cache; concurrent callers now also
// share one request instead of each starting their own.
const _gridpointCache = {};
const _gridpointInflight = {};
const GRIDPOINT_TTL_MS = 30 * 60 * 1000;

// A deliberate pull-to-refresh has to reach the network: drop the active
// location's cached gridpoint so the next read fetches it fresh.
function invalidateGridpointCache() {
  if (!activeLocation.wfo) return;
  delete _gridpointCache[`${activeLocation.wfo}-${activeLocation.gx}-${activeLocation.gy}`];
}

// Resolves null on failure (never throws), and does not cache a failure.
function getGridpointDataCached() {
  if (!activeLocation.wfo) return Promise.resolve(null);
  const key = `${activeLocation.wfo}-${activeLocation.gx}-${activeLocation.gy}`;
  const cached = _gridpointCache[key];
  if (cached && (Date.now() - cached.at) < GRIDPOINT_TTL_MS) return Promise.resolve(cached.data);
  if (_gridpointInflight[key]) return _gridpointInflight[key];
  const p = fetchGridpointData()
    .then(data => { _gridpointCache[key] = { data, at: Date.now() }; return data; })
    .catch(() => null)
    .finally(() => { delete _gridpointInflight[key]; });
  _gridpointInflight[key] = p;
  return p;
}

// Gust row built from a gridpoint series. NWS gridpoint windGust is returned
// in km/h (wmoUnit:km_h-1) — multiply by 0.621371 to get mph. The same
// conversion is used in marine.js buildExtended() so the two tabs stay in sync.
function buildGustRow(hours, gustSeries) {
  const n = Math.min(hours.length, 24);
  if (!gustSeries || !gustSeries.length) {
    // Day breaks must be emitted here too, not just in the populated branch —
    // the hourly rows scroll in lockstep (see the sync listener) and that only
    // lines up if every row has identical geometry.
    return `<div class="hrs">${hours.slice(0, n).map((h, i) => _dayBreakHTML(hours, i) + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv _s-36338c">--</span>
    </div>`).join('')}</div>`;
  }
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const t = new Date(h.startTime);
    const g = getGridValueAt(gustSeries, t); // km/h
    const mph = g != null ? Math.round(g * 0.621371) : null;
    const kmh = g != null ? Math.round(g) : null;
    const val = mph == null ? '--' : (uWind === 'kmh' ? kmh : mph);
    const unit = mph == null ? '' : (uWind === 'kmh' ? 'km/h' : 'mph');
    const dayBreak = _dayBreakHTML(hours, i);
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv _s-5e0faa">${val}<span class="_s-7e7812"> ${unit}</span></span>
    </div>`;
  }).join('')}</div>`;
}


// ── Long-range outlook (Open-Meteo, days 8-14) ───────────────────────────────
// NWS publishes nothing longer than 7 days per point — /forecast returns 14
// periods and stops. The CPC 6-10/8-14 day outlooks are probability categories,
// not point forecasts; they now render above this section from NOAA's map
// service (see _renderCpcOutlook). CPC's own GIS server sends no CORS headers,
// which is why this was once written off as a dead end.
//
// This is raw GFS output, and it is presented as such. It sits in its own
// section, under its own header, in muted type with no weather icons: an icon
// implies the same confidence as the NWS row above it, and day 12 does not
// deserve that. Nothing here is allowed to look like an NWS forecast.
//
// 14 DAYS, NOT 16, for two reasons that happen to agree. Open-Meteo bills a
// request covering more than two weeks as more than one API call against the
// 10,000/day free-tier allowance; and GFS skill has collapsed well before day
// 14 anyway, so days 15-16 would be numbers we cannot stand behind.
//
// Licence: CC-BY 4.0, non-commercial. This app qualifies — free, no ads, no
// subscription — and the credit line below is the attribution that requires.
// If the app ever carries advertising or a paid tier, this endpoint needs a
// commercial plan.
// ── Precipitation nowcast (Open-Meteo 15-minute, next 2 hours) ───────────────
//
// The gap every modern weather app closes and NWS cannot: "is it about to rain
// HERE, in the next hour". api.weather.gov's finest grain is hourly probability
// over a 2.5 km grid, which cannot answer it. Open-Meteo's minutely_15 series
// (HRRR over North America) can, and the host is already a dependency — the
// long-range outlook below uses the same endpoint and it is already in the CSP
// and both privacy policies.
//
// Two honesty rules, the same ones the long-range block follows:
//
//   * The series is quarter-hourly, so the copy is too. "In about 30 minutes",
//     never "in 12 minutes" — a minute-precise number the data cannot support
//     is the fastest way to be caught being wrong.
//   * It is model output, not an NWS product, and says so on the strip.
//
// Silent when there is nothing to say, which is most of the time: no strip
// unless precipitation actually appears in the next two hours.
const NOWCAST_URL = 'https://api.open-meteo.com/v1/forecast';
const NOWCAST_TTL_MS = 10 * 60 * 1000;   // HRRR updates hourly; 10 min is plenty
const NOWCAST_STEPS = 8;                 // 8 x 15 min = the next 2 hours
const NOWCAST_WET_MM = 0.1;              // below this the model is saying "damp air", not rain
let _nowcastCache = null;                // { key, at, steps: [...] }

function _nowcastKey(loc) {
  return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
}

async function fetchNowcast(loc) {
  const key = _nowcastKey(loc);
  if (_nowcastCache && _nowcastCache.key === key && Date.now() - _nowcastCache.at < NOWCAST_TTL_MS) {
    return _nowcastCache.steps;
  }
  try {
    const url = `${NOWCAST_URL}?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}`
      + '&minutely_15=precipitation,snowfall,precipitation_probability'
      + `&forecast_minutely_15=${NOWCAST_STEPS}&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
    const d = await r.json();
    const t = d?.minutely_15?.time;
    if (!Array.isArray(t) || !t.length) throw new Error('no minutely_15 series');
    // Times come back local-naive ("2026-09-19T23:30") with the offset alongside,
    // so parse as UTC and subtract the offset rather than letting the device's
    // own zone decide what that string means.
    const off = (+d.utc_offset_seconds || 0) * 1000;
    const steps = t.map((iso, i) => ({
      at: Date.parse(iso + 'Z') - off,
      mm: +d.minutely_15.precipitation?.[i] || 0,
      snow: +d.minutely_15.snowfall?.[i] || 0,
      pop: +d.minutely_15.precipitation_probability?.[i] || 0,
    }));
    _nowcastCache = { key, at: Date.now(), steps };
    return steps;
  } catch (e) {
    _warn('fetchNowcast', e);
    return [];
  }
}

// Turns the series into one sentence, or null for "nothing worth saying".
//
// Rounded to the nearest five minutes and never below "within 15 minutes",
// because each step covers a quarter hour: a step timestamped 4:30 means rain
// somewhere in 4:30-4:45, so promising 4:30 exactly would be false precision.
function _nowcastLine(steps) {
  const now = Date.now();
  const ahead = steps.filter(s => s.at + 15 * 60000 > now);
  if (!ahead.length) return null;

  const wet = s => s.mm >= NOWCAST_WET_MM;
  const word = s => (s.snow > 0 ? 'Snow' : 'Rain');
  const mins = s => Math.max(0, Math.round((s.at - now) / 60000 / 5) * 5);

  // Already raining: say when it lets up, which is the question someone with a
  // window already open actually has.
  if (wet(ahead[0])) {
    const dry = ahead.find(s => !wet(s));
    if (!dry) return { text: `${word(ahead[0])} through the next 2 hours`, wet: true };
    const m = mins(dry);
    return {
      text: m <= 15
        ? `${word(ahead[0])} easing within 15 minutes`
        : `${word(ahead[0])} for about another ${m} minutes`,
      wet: true,
    };
  }

  const first = ahead.find(wet);
  if (!first) return null;
  const m = mins(first);
  return {
    text: m <= 15
      ? `${word(first)} likely within 15 minutes`
      : `${word(first)} likely in about ${m} minutes`,
    wet: false,
  };
}

// Additive and silent, like the climate card: the slot stays empty unless the
// model has precipitation in the next two hours.
async function _renderNowcast() {
  const el = document.getElementById('wx-nowcast');
  if (!el) return;
  const myGen = _locGen;
  const steps = await fetchNowcast(activeLocation);
  if (_locGen !== myGen || !el.isConnected) return;

  const line = _nowcastLine(steps);
  if (!line) { el.innerHTML = ''; return; }

  el.innerHTML = `<div class="nowcast${line.wet ? ' nowcast-now' : ''}">
    <span class="nowcast-dot"></span>
    <span class="nowcast-txt">${esc(line.text)}</span>
    <span class="nowcast-src">MODEL &middot; NOT NWS</span>
  </div>`;
}

const LRF_URL = 'https://api.open-meteo.com/v1/forecast';
const LRF_TTL_MS = 3 * 3600 * 1000;   // GFS runs 4x/day; 3h keeps calls to ~4-8 per user per day
let _lrfCache = null;                 // { key, at, days: [...] }

function _lrfKey(loc) {
  return `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
}

// Returns [] on any failure. The extended section is additive — if Open-Meteo
// is unreachable (its free tier carries no uptime guarantee) the NWS 7-day
// above must render exactly as it always did, with this section simply absent.
// Never a spinner that outlives the request, never an error on the main list.
async function fetchLongRange(loc) {
  const key = _lrfKey(loc);
  if (_lrfCache && _lrfCache.key === key && Date.now() - _lrfCache.at < LRF_TTL_MS) {
    return _lrfCache.days;
  }
  try {
    const url = `${LRF_URL}?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}`
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
      + '&forecast_days=14&temperature_unit=fahrenheit&timezone=auto';
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
    const d = await r.json();
    const t = d?.daily?.time;
    if (!Array.isArray(t) || !t.length) throw new Error('no daily series');
    const days = t.map((date, i) => ({
      date,
      hi: d.daily.temperature_2m_max?.[i],
      lo: d.daily.temperature_2m_min?.[i],
      pop: d.daily.precipitation_probability_max?.[i],
      code: d.daily.weather_code?.[i],
    }));
    _lrfCache = { key, at: Date.now(), days };
    return days;
  } catch (e) {
    _warn('fetchLongRange', e);
    return [];
  }
}

// WMO weather code → short plain-English label. Deliberately coarse: this is
// day 8-14 model output and a precise label would overstate it.
function lrfCondition(code) {
  const c = +code;
  if (!Number.isFinite(c)) return '';
  if (c === 0) return 'Clear';
  if (c <= 2) return 'Partly cloudy';
  if (c === 3) return 'Cloudy';
  if (c <= 49) return 'Fog';
  if (c <= 59) return 'Drizzle';
  if (c <= 69) return 'Rain';
  if (c <= 79) return 'Snow';
  if (c <= 84) return 'Showers';
  if (c <= 94) return 'Snow showers';
  return 'Thunderstorms';
}

// Only the days BEYOND the NWS range are shown. Overlapping the two sources for
// the same day would invite exactly the comparison this section is designed to
// avoid, and the NWS value is the better one wherever both exist.
function _lrfBeyondNws(days) {
  let lastNws = null;
  for (const p of (wxData.forecast || [])) {
    const d = (p.startTime || '').slice(0, 10);
    if (d && (!lastNws || d > lastNws)) lastNws = d;
  }
  if (!lastNws) return [];
  return days.filter(d => d.date > lastNws);
}

async function _renderLongRange() {
  const el = document.getElementById('lrf-section');
  if (!el) return;
  const loc = activeLocation;
  if (typeof loc?.lat !== 'number') { el.innerHTML = ''; return; }

  const myGen = _locGen;
  const all = await fetchLongRange(loc);
  if (_locGen !== myGen) return;          // user switched while we were away
  const days = _lrfBeyondNws(all);
  if (!days.length) { el.innerHTML = ''; return; }   // fail soft: section vanishes

  const rows = days.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    const name = dt.toLocaleDateString([], { weekday: 'long' });
    const sub  = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const cond = lrfCondition(d.code);
    const pop  = Number.isFinite(+d.pop) && +d.pop >= 20
      ? `<span class="lrf-pop">${Math.round(+d.pop)}%</span>` : '';
    const hi = Number.isFinite(+d.hi) ? ft(Math.round(+d.hi)) : '--';
    const lo = Number.isFinite(+d.lo) ? ft(Math.round(+d.lo)) : '--';
    return `<div class="lrf-row">
      <span class="lrf-day">${esc(name)}<span class="lrf-date">${esc(sub)}</span></span>
      <span class="lrf-cond">${esc(cond)}${pop}</span>
      <span class="lrf-temps"><span class="lrf-hi">${hi}</span><span class="lrf-lo">${lo}</span></span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="ext-list lrf-list">
    <div class="clbl lrf-lbl">
      LONG-RANGE OUTLOOK
      <span class="lrf-badge">NOT AN NWS FORECAST</span>
    </div>
    <p class="lrf-warn">Computer model output for the days after the NWS forecast ends. No forecaster has reviewed it, and accuracy drops quickly after about a week, so use it for general trends only.</p>
    ${rows}
    <div class="lrf-src">
      <span class="ldot"></span>GFS via Open-Meteo &middot; CC-BY 4.0 &middot; temperatures converted to the unit you selected
    </div>
  </div>`;
}



// ── NOAA Climate Prediction Center 6–10 / 8–14 day outlooks ──────────────────
// The official NOAA outlook for the two weeks after the NWS forecast ends:
// the probability that each period averages ABOVE, NEAR or BELOW normal, for
// temperature and precipitation. It is a lean, not a forecast — "50% chance of
// above-normal temperatures" — and it is what NWS itself points to beyond day 7.
//
// Source: CPC's outlooks as served by NOAA's map service
// (mapservices.weather.noaa.gov), which, unlike CPC's own GIS server, sends CORS
// headers and answers point queries. The August note above calling CPC a dead
// end was about that other server.
//
// Privacy: the query point IS the location, so it is rounded to 0.01° (~1 km)
// first — plenty for outlooks drawn at the scale of whole states.
const CPC_BASE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks';
const CPC_TTL_MS = 3 * 60 * 60 * 1000;   // issued once a day, mid-afternoon Eastern
let _cpcCache = null;                    // { key, at, data }

async function _cpcQuery(service, layer, lat, lon) {
  const url = `${CPC_BASE}/${service}/MapServer/${layer}/query?geometry=${lon},${lat}`
    + '&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects'
    + '&outFields=cat,prob,start_date,end_date&returnGeometry=false&f=json';
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('CPC HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('CPC: ' + (j.error.message || 'error'));
  const a = j.features?.[0]?.attributes;
  // No polygon at a point means CPC shows "equal chances" there — no lean.
  return a ? { cat: a.cat || 'EC', prob: a.prob, start: a.start_date, end: a.end_date } : { cat: 'EC' };
}

async function fetchCpcOutlook(loc) {
  const lat = +(+loc.lat).toFixed(2), lon = +(+loc.lon).toFixed(2);
  const key = lat + ',' + lon;
  if (_cpcCache && _cpcCache.key === key && Date.now() - _cpcCache.at < CPC_TTL_MS) return _cpcCache.data;
  const [t610, p610, t814, p814] = await Promise.all([
    _cpcQuery('cpc_6_10_day_outlk', 0, lat, lon), _cpcQuery('cpc_6_10_day_outlk', 1, lat, lon),
    _cpcQuery('cpc_8_14_day_outlk', 0, lat, lon), _cpcQuery('cpc_8_14_day_outlk', 1, lat, lon),
  ]);
  const data = [
    { label: '6–10 days', temp: t610, precip: p610 },
    { label: '8–14 days', temp: t814, precip: p814 },
  ];
  _cpcCache = { key, at: Date.now(), data };
  return data;
}

// "50% chance above normal", or "Equal chances" (CPC's own term) for EC.
function cpcPhrase(o, kind) {
  const c = String(o?.cat || 'EC').toLowerCase();
  if (!o || c === 'ec' || !Number.isFinite(+o.prob)) return { text: 'Equal chances', cls: 'cpc-ec' };
  const word = c.startsWith('above') ? (kind === 'temp' ? 'warmer' : 'wetter')
             : c.startsWith('below') ? (kind === 'temp' ? 'cooler' : 'drier')
             : 'near';
  const text = word === 'near'
    ? `${Math.round(+o.prob)}% chance near normal`
    : `${Math.round(+o.prob)}% chance ${word} than normal`;
  const cls = word === 'near' ? 'cpc-ec' : `cpc-${word}`;
  return { text, cls };
}

function _cpcRange(o) {
  if (!o?.start || !o?.end) return '';
  const f = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(o.start)} – ${f(o.end)}`;
}

async function _renderCpcOutlook() {
  const el = document.getElementById('cpc-section');
  if (!el) return;
  const loc = activeLocation;
  if (typeof loc?.lat !== 'number') { el.innerHTML = ''; return; }
  const myGen = _locGen;
  let data;
  try { data = await fetchCpcOutlook(loc); }
  catch (e) { _warn('cpcOutlook', e); el.innerHTML = ''; return; }   // fail soft
  if (_locGen !== myGen) return;
  const rows = data.map(p => {
    const t = cpcPhrase(p.temp, 'temp'), r = cpcPhrase(p.precip, 'precip');
    const range = _cpcRange(p.temp.start ? p.temp : p.precip);
    return `<div class="cpc-row">
      <div class="cpc-when">${esc(p.label)}${range ? `<span class="cpc-dates">${esc(range)}</span>` : ''}</div>
      <div class="cpc-leans">
        <span class="cpc-lean ${t.cls}"><span class="cpc-k">Temp</span>${esc(t.text)}</span>
        <span class="cpc-lean ${r.cls}"><span class="cpc-k">Precip</span>${esc(r.text)}</span>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="card cpc-card">
    <div class="clbl">NOAA OUTLOOK &middot; NEXT 2 WEEKS<span class="spc-clbl-tag">CPC</span></div>
    ${rows}
    <p class="cpc-note">The chance each period is warmer, cooler, wetter or drier than normal for the time of year. This is not a day-by-day forecast.</p>
    <div class="spc-meta"><span class="ldot"></span>NOAA/NWS Climate Prediction Center</div>
  </div>`;
}

// ── Climate: normals, departures, records ────────────────────────────────────
// The NWS CLI (Climatological Report) product carries, per city, today's high
// and low against the 1991-2020 normal AND the all-time record with its year,
// plus precipitation and snowfall month-to-date and year-to-date each with a
// departure from normal. It answers "is this hot for September", "are we behind
// on rain" and "how much snow so far" in one fetch.
//
// It arrives through /products/types/{TYPE}/locations/{ID} — the same endpoint
// the app already uses for the AFD and the coastal forecast. No new host, no
// CSP change, no licence question.
//
// Mapping a user to their CLI city: strip the leading K from the ASOS station
// identifier already resolved for current conditions (KOKC -> OKC). Verified
// against the ten largest US markets, 10/10. Falls through the other stations
// in the existing stations?limit=5 response when the nearest has no CLI.
const CLI_TTL_MS = 3 * 3600 * 1000;   // issued a few times daily; 3h is plenty
let _cliCache = null;                 // { key, at, data }

// Trailing R marks a record set or tied, E an estimate. Keep the flag, drop it
// from the number. "M"/"MM" mean missing.
function _cliVal(t) {
  const m = String(t ?? '').match(/^(-?\d+(?:\.\d+)?)([RE])?$/);
  return m ? { n: parseFloat(m[1]), flag: m[2] || '' } : null;
}

// A row reads: observed [time] [record year] normal departure lastYear.
// Anchor on the 4-digit year — whether a record column exists is exactly what
// varies between row types, so finding the year first means a missing time or
// record column cannot shift every later reading by one.
function _cliRow(rest) {
  const toks = String(rest).trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length - 1; i++) {
    if (/^\d{1,4}$/.test(toks[i]) && /^(AM|PM)$/i.test(toks[i + 1])) { toks.splice(i, 2); break; }
  }
  const isYear = t => /^\d{4}$/.test(t) && +t >= 1800 && +t <= 2100;
  const yi = toks.findIndex(isYear);
  if (yi > 0) {
    return { observed: _cliVal(toks[0]), record: _cliVal(toks[yi - 1]), year: +toks[yi],
             normal: _cliVal(toks[yi + 1]), departure: _cliVal(toks[yi + 2]) };
  }
  return { observed: _cliVal(toks[0]), record: null, year: null,
           normal: _cliVal(toks[1]), departure: _cliVal(toks[2]) };
}

// Verified against OKC, SEA, DEN, ANC, BOS and MIA — offices differ in whether
// the period lines carry a colon and in which "SINCE" rows they print, so both
// are matched loosely.
function parseCLI(text) {
  const out = { temp: {}, precip: {}, snow: {}, normalPeriod: null, recordPeriod: null, summaryDate: null };
  let section = null;
  for (const raw of String(text).split('\n')) {
    const t = raw.trim();
    let m;
    // Which day the report is about. NWS issues a preliminary report for TODAY
    // in the afternoon and the final for YESTERDAY after midnight, so the
    // latest one is yesterday's for about half of every day (Miami: 4:26 AM to
    // 4:40 PM, 2026-09-26) — and was being shown as "today".
    if (!out.summaryDate && (m = t.match(/CLIMATE SUMMARY FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/))) {
      const mon = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'].indexOf(m[1]);
      if (mon >= 0) out.summaryDate = `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
      continue;
    }
    if ((m = t.match(/^CLIMATE NORMAL PERIOD:?\s+(.+)$/))) { out.normalPeriod = m[1].trim(); continue; }
    if ((m = t.match(/^CLIMATE RECORD PERIOD:?\s+(.+)$/))) { out.recordPeriod = m[1].trim(); continue; }
    if (/^TEMPERATURE\b/.test(t))   { section = 'temp';   continue; }
    if (/^PRECIPITATION\b/.test(t)) { section = 'precip'; continue; }
    if (/^SNOWFALL\b/.test(t))      { section = 'snow';   continue; }
    if (/^(DEGREE DAYS|WIND|SKY COVER|WEATHER CONDITIONS|RELATIVE HUMIDITY)\b/.test(t)) { section = null; continue; }
    if (!section) continue;
    const labels = section === 'temp'
      ? [['MAXIMUM', 'max'], ['MINIMUM', 'min']]
      : [['MONTH TO DATE', 'mtd'], ['SINCE JAN 1', 'ytd'], ['SINCE DEC 1', 'season'],
         ['SINCE JUL 1', 'season'], ['TODAY', 'today']];
    for (const [lbl, key] of labels) {
      const mm = t.match(new RegExp('^' + lbl.replace(/ /g, '\\s+') + '\\s+(.*)$'));
      if (mm && !out[section][key]) { out[section][key] = _cliRow(mm[1]); break; }
    }
  }
  return out;
}

// Returns null on anything unexpected. This whole section is additive — if the
// office publishes no CLI for any nearby station, it simply does not appear.
// "today" / "yesterday" / "Sep 24" for the day a CLI report covers, judged in
// the location's timezone. Falls back to "today" when the report carried no
// date line (the pre-fix wording, rather than guessing a day).
function cliDayWord(summaryDate, now = new Date()) {
  if (!summaryDate) return 'today';
  const today = _locDayKey(now);
  if (summaryDate === today) return 'today';
  if (summaryDate === _locDayKey(new Date(now.getTime() - 86400000))) return 'yesterday';
  const d = new Date(summaryDate + 'T12:00:00');
  return isNaN(d) ? 'today' : 'on ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function fetchClimate(loc) {
  const key = loc.id + '|' + _lrfKey(loc);
  if (_cliCache && _cliCache.key === key && Date.now() - _cliCache.at < CLI_TTL_MS) return _cliCache.data;
  try {
    const stations = await _nearbyStationIds(loc);
    for (const sid of stations) {
      const cliId = sid.replace(/^K/, '');
      if (cliId.length !== 3) continue;
      const l = await nwsFetch(`https://api.weather.gov/products/types/CLI/locations/${cliId}`).catch(() => null);
      if (!l?.ok) continue;
      const listing = await l.json().catch(() => null);
      // `@id` is the full product URL; the sibling `id` is a bare UUID. Prefer
      // the URL and build one from the UUID only as a fallback — fetching the
      // bare id silently resolves against the app origin and 404s.
      const first = listing?.['@graph']?.[0];
      const pid = first?.['@id'] || (first?.id ? `https://api.weather.gov/products/${first.id}` : null);
      if (!pid) continue;
      const r = await nwsFetch(pid).catch(() => null);
      if (!r?.ok) continue;
      const body = await r.json().catch(() => null);
      if (!body?.productText) continue;
      const parsed = parseCLI(body.productText);
      if (!parsed.temp.max?.observed) continue;   // unparseable — try the next station
      const data = { ...parsed, station: cliId, issued: body.issuanceTime || null };
      _cliCache = { key, at: Date.now(), data };
      return data;
    }
  } catch (e) { _warn('fetchClimate', e); }
  return null;
}

// Candidate CLI city codes for this location, nearest first.
//
// NOT the five nearest stations. CLI is published for ~627 designated CLIMATE
// sites — typically a metro's primary airport — and the nearest reporting
// station usually is not one. Seattle is the case that proved it: KBFI (Boeing
// Field) and KRNT (Renton) are closest and publish no CLI, while KSEA sits
// SIXTH in the list and is the actual climate site. A five-station window
// returned nothing for a major city, and would have done the same for most
// suburban locations.
//
// So: ask for a wide list, keep only ids shaped like a CLI code (K + three
// letters), and cap the candidates so a location with no climate site nearby
// cannot spend a dozen round trips discovering that.
const CLI_MAX_CANDIDATES = 6;
async function _nearbyStationIds(loc) {
  try {
    if (!loc.wfo || loc.gx == null) return [];
    const r = await nwsFetch(`https://api.weather.gov/gridpoints/${loc.wfo}/${loc.gx},${loc.gy}/stations?limit=20`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.features || [])
      .map(f => f?.properties?.stationIdentifier)
      .filter(id => typeof id === 'string' && /^K[A-Z]{3}$/.test(id))
      .slice(0, CLI_MAX_CANDIDATES);
  } catch (_) { return []; }
}

// ── Dry / wet streak (ACIS) ──────────────────────────────────────────────────
// CLI has no memory beyond today, so "tenth day in a row without rain" needs
// daily history. ACIS is the Regional Climate Centers' API: free, no key,
// CORS-open, multi-decade daily records.
const ACIS_URL = 'https://data.rcc-acis.org/StnData';
let _streakCache = null;

async function fetchDryStreak(stationId) {
  if (_streakCache && _streakCache.key === stationId && Date.now() - _streakCache.at < CLI_TTL_MS) {
    return _streakCache.value;
  }
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 120 * 864e5);
    const iso = d => d.toISOString().slice(0, 10);
    const r = await fetch(
      `${ACIS_URL}?sid=${encodeURIComponent(stationId)}&sdate=${iso(start)}&edate=${iso(end)}&elems=pcpn&output=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error('ACIS HTTP ' + r.status);
    const d = await r.json();
    const rows = d?.data;
    if (!Array.isArray(rows) || !rows.length) return null;
    let dry = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const p = rows[i][1];
      if (p === 'M') continue;                    // missing day — skip, don't break the run
      const v = p === 'T' ? 0 : parseFloat(p);    // trace counts as dry
      if (!Number.isFinite(v)) break;
      if (v > 0) break;
      dry++;
    }
    const value = dry >= 5 ? dry : null;          // below ~5 days it is not a story
    _streakCache = { key: stationId, at: Date.now(), value };
    return value;
  } catch (e) { _warn('fetchDryStreak', e); return null; }
}

async function _renderClimate() {
  const el = document.getElementById('clim-section');
  if (!el) return;
  const myGen = _locGen;
  const c = await fetchClimate(activeLocation);
  if (_locGen !== myGen) return;
  if (!c) { el.innerHTML = ''; return; }          // fail soft

  const t = (v, unit) => v == null ? '—' : (unit === 'F' ? ft(Math.round(v.n)) : v.n.toFixed(2) + '"');
  // Departures are the point of the whole section, so they are the only thing
  // that gets colour: above normal warm, below normal cool.
  const dep = (v, unit, invert) => {
    if (!v) return '';
    const n = v.n;
    if (Math.abs(n) < 0.005) return `<span class="clim-dep clim-flat">normal</span>`;
    const cls = (n > 0) !== !!invert ? 'clim-up' : 'clim-down';
    const s = (n > 0 ? '+' : '') + (unit === 'F' ? Math.round(n) : n.toFixed(2));
    return `<span class="clim-dep ${cls}">${esc(s)}${unit === 'F' ? '°' : '"'}</span>`;
  };

  const day = cliDayWord(c.summaryDate);
  const rows = [];
  if (c.temp.max) rows.push([`High ${day}`, t(c.temp.max.observed, 'F'),
    `normal ${t(c.temp.max.normal, 'F')}`, dep(c.temp.max.departure, 'F'),
    c.temp.max.record ? `record ${t(c.temp.max.record, 'F')} in ${c.temp.max.year}` : '']);
  if (c.temp.min) rows.push([`Low ${day}`, t(c.temp.min.observed, 'F'),
    `normal ${t(c.temp.min.normal, 'F')}`, dep(c.temp.min.departure, 'F'),
    c.temp.min.record ? `record ${t(c.temp.min.record, 'F')} in ${c.temp.min.year}` : '']);
  if (c.precip.mtd) rows.push(['Rain this month', t(c.precip.mtd.observed, 'in'),
    `normal ${t(c.precip.mtd.normal, 'in')}`, dep(c.precip.mtd.departure, 'in'), '']);
  if (c.precip.ytd) rows.push(['Rain since Jan 1', t(c.precip.ytd.observed, 'in'),
    `normal ${t(c.precip.ytd.normal, 'in')}`, dep(c.precip.ytd.departure, 'in'), '']);
  if (c.snow.season?.observed) rows.push(['Snow this season', t(c.snow.season.observed, 'in'),
    `normal ${t(c.snow.season.normal, 'in')}`, dep(c.snow.season.departure, 'in'), '']);
  if (!rows.length) { el.innerHTML = ''; return; }

  // A record broken or tied today is the one thing here worth leading with.
  const rec = c.temp.max?.observed?.flag === 'R' ? 'high' :
              c.temp.min?.observed?.flag === 'R' ? 'low'  : null;
  const recBanner = rec
    ? `<div class="clim-record">Record ${rec} set or tied ${esc(day)}. Previous record: ${
        t(rec === 'high' ? c.temp.max.record : c.temp.min.record, 'F')} in ${
        rec === 'high' ? c.temp.max.year : c.temp.min.year}</div>`
    : '';

  el.innerHTML = `<div class="ext-list clim-list">
    <div class="clbl clim-lbl">CLIMATE &amp; RECORDS<span class="clim-stn">${esc(c.station)}</span></div>
    ${recBanner}
    ${rows.map(([label, obs, norm, d, extra]) => `<div class="clim-row">
      <span class="clim-name">${esc(label)}<span class="clim-extra">${esc(extra)}</span></span>
      <span class="clim-obs">${obs}</span>
      <span class="clim-norm">${esc(norm)}</span>
      ${d}
    </div>`).join('')}
    <div class="clim-streak" id="clim-streak"></div>
    <div class="lrf-src"><span class="ldot"></span>NWS Climatological Report${
      c.normalPeriod ? ` &middot; normals ${esc(c.normalPeriod.toLowerCase())}` : ''}${
      c.recordPeriod ? ` &middot; records ${esc(c.recordPeriod.toLowerCase())}` : ''}</div>
  </div>`;

  // Streak is a second source and a slower one, so it fills in after the paint
  // rather than holding the section back.
  const days = await fetchDryStreak('K' + c.station);
  if (_locGen !== myGen || !days) return;
  const st = document.getElementById('clim-streak');
  if (st) st.textContent = `${days} days in a row without measurable rain.`;
}


// ── Climate card on the Weather screen ───────────────────────────────────────
// The full Climate & Records block lives on the Details screen, three levels in
// — Weather, Details, scroll. That is too deep for the most distinctive thing
// in the app, and the same discoverability problem SPC and air quality already
// have. This surfaces ONE line at the top level and opens the full section.
//
// The line is chosen, not templated: whichever fact is actually remarkable
// today wins. On an ordinary day in an ordinary place there is nothing
// remarkable, and the card says something plain rather than manufacturing
// drama out of a 1° departure.
function _climHeadline(c) {
  const F = v => ft(Math.round(v.n));
  const day = cliDayWord(c.summaryDate);
  const IN = v => v.n.toFixed(2) + '"';

  // 1. A record today beats everything else.
  if (c.temp.max?.observed?.flag === 'R' && c.temp.max.record) {
    return { tag: 'RECORD', text: `Record high ${day}: ${F(c.temp.max.observed)} (old record ${F(c.temp.max.record)} in ${c.temp.max.year})` };
  }
  if (c.temp.min?.observed?.flag === 'R' && c.temp.min.record) {
    return { tag: 'RECORD', text: `Record low ${day}: ${F(c.temp.min.observed)} (old record ${F(c.temp.min.record)} in ${c.temp.min.year})` };
  }
  // 2. A long dry spell is the thing people notice and repeat.
  if (c._streak >= 7) {
    const ytd = c.precip.ytd?.departure;
    const behind = ytd && ytd.n <= -1 ? ` · ${IN({ n: Math.abs(ytd.n) })} behind for the year` : '';
    return { tag: 'DRY', text: `${c._streak} days without rain${behind}` };
  }
  // 3. A big temperature departure.
  const td = c.temp.max?.departure;
  if (td && Math.abs(td.n) >= 10) {
    return { tag: null, text: `${Math.abs(Math.round(td.n))}° ${td.n > 0 ? 'above' : 'below'} normal ${day} (high ${F(c.temp.max.observed)}, normal ${F(c.temp.max.normal)})` };
  }
  // 4. A meaningful rainfall deficit or surplus for the year.
  const pd = c.precip.ytd?.departure;
  if (pd && Math.abs(pd.n) >= 2) {
    return { tag: null, text: `${IN({ n: Math.abs(pd.n) })} ${pd.n > 0 ? 'above' : 'below'} normal rainfall so far this year` };
  }
  // 5. Nothing remarkable. Say so plainly.
  if (c.temp.max?.observed && c.temp.max?.normal) {
    return { tag: null, text: `High ${F(c.temp.max.observed)} ${day}, close to the normal ${F(c.temp.max.normal)}` };
  }
  return null;
}

async function _renderClimateCard() {
  const el = document.getElementById('wx-clim-card');
  if (!el) return;
  const myGen = _locGen;
  const c = await fetchClimate(activeLocation);
  if (_locGen !== myGen || !c) { if (el) el.innerHTML = ''; return; }   // fail soft

  // The streak feeds the headline, so it has to be in hand before choosing —
  // but it must not delay the card if ACIS is slow or down.
  c._streak = await fetchDryStreak('K' + c.station).catch(() => null) || 0;
  if (_locGen !== myGen) return;

  const h = _climHeadline(c);
  if (!h) { el.innerHTML = ''; return; }

  el.innerHTML = `<button class="card sc-entry clim-card" data-click-action="openClimate"
      aria-label="Climate and records — open">
    <div class="sc-entry-txt">
      <div class="sc-entry-title">CLIMATE &amp; RECORDS${
        h.tag ? `<span class="clim-card-tag clim-tag-${h.tag.toLowerCase()}">${esc(h.tag)}</span>` : ''}</div>
      <div class="sc-entry-sub">${esc(h.text)}</div>
    </div>
    <span class="clbl-chev sc-entry-chev">&rsaquo;</span>
  </button>`;
}

// Opens the Details screen and puts the climate block on screen, rather than
// dropping the user at the top of a long scroller to find it themselves.
//
// Two things make this harder than one scrollIntoView call.
//
// The Details screen scrolls in a NESTED `.scroller` (630px tall inside an
// 812px screen), so window-relative geometry is the wrong frame — an element
// at window-top 698 is comfortably on screen by that measure and nearly off
// the bottom of the actual scroller. Position is therefore computed against
// the scroller and written to its scrollTop directly.
//
// And the long-range outlook sits ABOVE this section and fills in from its own
// request, so a scroll that lands correctly gets pushed away when that arrives.
// Measured: the section held at 698 for six seconds, then jumped to 2399. So
// the position is re-asserted until the layout stops moving, and gives up as
// soon as it has been stable — or the user has taken over by scrolling.
function openClimate() {
  goNav('s-forecast', null);
  let tries = 0, stable = 0, lastSet = null;
  const settle = () => {
    tries++;
    const scroller = document.querySelector('#s-forecast .scroller');
    const target = document.getElementById('clim-section');
    if (scroller && target && target.querySelector('.clim-row')) {
      // If the scroll position moved somewhere this function did not put it,
      // the user is scrolling. Their intent wins.
      if (lastSet !== null && Math.abs(scroller.scrollTop - lastSet) > 24) return;
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (delta >= 0 && delta < scroller.clientHeight * 0.4) {
        if (++stable >= 3) return;          // held position three checks running
      } else {
        stable = 0;
        scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 20);
        lastSet = scroller.scrollTop;
      }
    }
    if (tries < 60) setTimeout(settle, 250);   // ~15s ceiling, covers the late paint
  };
  setTimeout(settle, 200);
}

function renderExtendedForecast() {
  const body = document.getElementById('forecast-ext-body');
  if (!body) return;
  const p = wxData.forecast;
  if (!p?.length) {
    body.innerHTML = '<div class="card"><div class="_s-5e0faa">Forecast data unavailable.</div></div>';
    const srcEmpty = document.getElementById('details-source');
    if (srcEmpty) srcEmpty.textContent = ''; // don't leave a previous location's footer
    return;
  }

  // Group day+night pairs
  const html = p.slice(0, 14).map(period => {
    const url   = nwsIconUrl(period, 'medium');
    const fb    = iconFb(period.shortForecast, period.isDaytime);
    const isNight = !period.isDaytime;
    const label = (period.name || '')
      .replace(/^This Afternoon$/i, 'Today')
      .replace(/^Afternoon$/i,      'Today')
      .replace(/^This Morning$/i,   'Today')
      .replace(/^Today Night$/i,    'Tonight');
    const precip = popMention(period.probabilityOfPrecipitation?.value);
    const precipStr = precip != null ? `<span class="ext-precip">💧 ${precip}%</span>` : '';
    const wind = period.windSpeed && period.windDirection
      ? `<span class="ext-wind">💨 ${esc(period.windSpeed)} ${esc(period.windDirection)}</span>`
      : '';

    return `<div class="ext-period${isNight ? ' ext-night' : ''}" data-period-start="${esc(period.startTime)}" data-period-end="${esc(period.endTime)}">
      <div class="ext-header">
        <div class="ext-name-col">
          <span class="ext-name"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${isNight ? 'drow-night-ico' : 'drow-day-ico'}"><use href="#${isNight ? 'si-moon' : 'si-sun'}"/></svg> ${esc(label)}</span>
          <span class="ext-short">${esc(period.shortForecast)}</span>
          <span class="ext-meta">${wind}${precipStr}<span class="ext-snow-tag"></span></span>
        </div>
        ${imgFb(url, fb, 'ext-img', 'ext-fb')}
        <span class="ext-temp">${ft(period.temperature)}</span>
      </div>
      <div class="ext-detail">${esc(period.detailedForecast)}</div>
    </div>`;
  }).join('');

  const afdSection = `
    <div class="ext-list">
      <div class="_s-fa9415" data-css-style="margin:0 0 10px">
        <div class="clbl _s-fdf33f">
          AREA FORECAST DISCUSSION
          <span class="_s-5b34da">NWS</span>
        </div>
        <div id="ext-discussion-body" class="afd-scroll _s-759dd7 afd-collapsed" data-click-action="expandAFD"><div class="spin _s-7555c6"></div></div>
        <button class="afd-expand-btn" id="ext-afd-expand-btn" data-click-action="toggleExtAFD">Read full discussion ›</button>
        <div class="_s-111f6a">
          <span class="ldot"></span><span id="ext-afd-meta">NWS ${esc(activeLocation.wfo || '')} · Area Forecast Discussion · api.weather.gov</span>
        </div>
      </div>
    </div>`;

  // The 7-day snow-level strip used to sit here, between the NWS periods and the
  // long-range outlook — a horizontal strip of numbers interrupting a vertical
  // run of days. It now renders with the other winter cards (snowfall, ice) in
  // Detailed Conditions below; see buildSnowLevelSection in marine.js. The
  // per-period ❄️ tags stay on the period cards, filled by _renderExtSnowLevel.

  // Long-range sits AFTER the NWS list, before the discussion —
  // read top to bottom it is plainly a separate, lesser thing that follows the
  // real forecast rather than extending it.
  // NOAA's official outlook (CPC) reads before the raw model numbers below it.
  const cpcPlaceholder = `<div id="cpc-section"></div>`;
  const lrfPlaceholder = `<div id="lrf-section"></div>`;
  const climPlaceholder = `<div id="clim-section"></div>`;

  const changed = _setInnerIfChanged(body, `<div class="ext-list">${html}</div>${cpcPlaceholder}${lrfPlaceholder}${climPlaceholder}${afdSection}`);
  if (changed !== false) {
    fetchAFD();
    _renderExtSnowLevel();
    _renderCpcOutlook();
    _renderLongRange();
    _renderClimate();
  }
  // Source attribution lives at the bottom of the Details scroller (after the
  // Marine section) so the footer is always the last thing on the screen.
  const src = document.getElementById('details-source');
  if (src) src.textContent = `api.weather.gov \xb7 NWS ${activeLocation.wfo || ''}`.trim();
}

// Tags each period card with its lowest snow level when that is within reach of
// the location (elevation + the user's offset). The 7-day strip that used to be
// built here moved to Detailed Conditions — buildSnowLevelSection in marine.js.
async function _renderExtSnowLevel() {
  let data;
  data = await getGridpointDataCached();
  if (!data?.snowLevel?.length) return;

  const threshold = (data.elevationFt || 0) + snowLevelOffset;

  // Inject snow level into each period card when below location elevation + offset
  const RELEVANT_FT = threshold;
  document.querySelectorAll('.ext-period[data-period-start]').forEach(card => {
    const start = new Date(card.dataset.periodStart).getTime();
    const end   = new Date(card.dataset.periodEnd).getTime();
    const vals  = data.snowLevel.filter(e => {
      const t = e.time.getTime();
      return t >= start && t <= end && e.value != null;
    }).map(e => e.value);
    if (!vals.length) return;
    const minMeters = Math.min(...vals);
    const snowFt    = Math.round(minMeters * 3.28084);
    if (snowFt >= RELEVANT_FT) return;
    const tag = card.querySelector('.ext-snow-tag');
    if (!tag) return;
    tag.textContent = `❄️ ${snowFt.toLocaleString()} ft`;
    tag.style.color = snowFt < 1000 ? '#5AC8FA' : 'rgba(255,255,255,.55)';
  });
}

function renderHourly() {
  const body = document.getElementById('hourly-body');
  if (!body) return;
  const h = wxData.hourly;
  if (!h.length) {
    body.innerHTML = wxData.hourlyFailed
      ? `<div class="ldg"><div class="api-unavailable-msg">
           <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-css-style="opacity:.4"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".8" fill="currentColor"/></svg>
           Hourly data temporarily unavailable from api.weather.gov
         </div></div>`
      : '<div class="ldg" role="status" aria-live="polite"><div class="spin"></div><div class="_s-5e0faa">Loading hourly forecast&hellip;</div></div>';
    _invalidateHourlySync();   // rows replaced by the empty/error state
    return;
  }
  const n = Math.min(h.length, 24);
  const tempRow = `<div class="hrs">${h.slice(0, n).map((hh, i) => {
    const url = nwsIconUrl(hh, 'small');
    const fb = iconFb(hh.shortForecast, hh.isDaytime);
    const pop = popMention(hh.probabilityOfPrecipitation?.value);
    const dayBreak = _dayBreakHTML(h, i);
    const raw = hh.shortForecast || '';
    const sfHtml = esc(raw);
    const ts     = (i === 0 ? 'Now' : fh(hh.startTime));
    return dayBreak + `<div class="hr${i === 0 ? ' now' : ''}" data-click-action="hrCellTap" data-ts="${esc(ts)}" data-sf="${sfHtml}" title="${sfHtml}">
      <span class="hrt">${ts}</span>
      ${imgFb(url, fb, 'hr-img', 'hr-fb')}
      <span class="hrv">${ft(hh.temperature)}</span>
      <span class="hrp">${pop != null ? pop + '%' : ''}</span>
    </div>`;
  }).join('')}</div>
  <div id="hourly-tempcell-caption" class="hr-caption"></div>`;
  const _hourlyHtml = `
    ${buildHourlySummary()}
    <div class="card">
      <div class="clbl">${clblIcon('si-thermo')}TEMPERATURE &amp; CONDITIONS</div>
      ${tempRow}
    </div>
    <div class="card">
      <div class="clbl">${clblIcon('si-precip')}PRECIPITATION CHANCE</div>
      ${buildPrecipChart(h)}
    </div>
    <div class="card">
      <div class="clbl">${clblIcon('si-wind')}WIND</div>
      ${buildWindRow(h)}
    </div>
    <div class="card" id="hourly-gust-card">
      <div class="clbl">${clblIcon('si-air')}WIND GUSTS</div>
      <div id="hourly-gust-row"><div class="hrs"><div class="hr"><span class="hrt">…</span><span class="hrv _s-33f563">--</span></div></div></div>
    </div>
    <div class="card">
      <div class="clbl">${clblIcon('si-thermo')}FEELS LIKE</div>
      ${buildFeelsRow(h)}
    </div>
    <div class="card">
      <div class="clbl">${clblIcon('si-humidity')}HUMIDITY</div>
      ${buildHumidityRow(h)}
    </div>
    <div class="card">
      <div class="clbl">${clblIcon('si-dew')}DEW POINT</div>
      ${buildDewpointRow(h)}
    </div>
    <div class="card" id="hourly-cloud-card">
      <div class="clbl">${clblIcon('si-cloud')}CLOUD COVER</div>
      <div id="hourly-cloud-row"><div class="hrs"><div class="hr"><span class="hrt">…</span><span class="hrv _s-33f563">--</span></div></div></div>
    </div>
    <!-- Snow level / snowfall / ice: hour-by-hour series that used to live on
         the Details screen. They belong with the other strips, and all three
         self-hide out of season rather than showing 24 zeroes. -->
    <div class="card" id="hourly-snowlevel-card"></div>
    <div class="card" id="hourly-snowfall-card"></div>
    <div class="card" id="hourly-ice-card"></div>
    <div class="_s-252340">
      Hourly data: NOAA / NWS &middot; api.weather.gov
    </div>`;
  // #18: only re-do the DOM (and the gridpoint fill below) if anything moved.
  // The early return matters for the sync cache too: an unchanged render leaves
  // the existing rows in place, so the cached list is still correct and must
  // NOT be dropped. Only a real rewrite invalidates it.
  if (!_setInnerIfChanged(body, _hourlyHtml)) return;
  _invalidateHourlySync();

  // Gust + cloud rows share the gridpoint fetch — one request, fill both.
  const _hourlyGen = _locGen; // #12: guard against stale location data
  getGridpointDataCached().then(data => {
    if (_locGen !== _hourlyGen) return; // user switched location while fetching
    const gustSlot = document.getElementById('hourly-gust-row');
    if (gustSlot) gustSlot.innerHTML = buildGustRow(h, data?.windGust || []);
    const cloudSlot = document.getElementById('hourly-cloud-row');
    if (cloudSlot) cloudSlot.innerHTML = buildCloudRow(h, data?.skyCover || []);

    // Each of these three removes its own card when the series is empty or all
    // zero, so an August forecast doesn't carry three dead rows.
    _fillHourlyGridCard('hourly-snowlevel-card', `${clblIcon('si-snow')}SNOW LEVEL`,
      buildSnowLevelRow(h, data?.snowLevel || []));
    _fillHourlyGridCard('hourly-snowfall-card', `${clblIcon('si-snow')}SNOWFALL`,
      buildAccumRow(h, data?.snowfall || []));
    _fillHourlyGridCard('hourly-ice-card', `${clblIcon('si-snow')}ICE ACCUMULATION`,
      buildAccumRow(h, data?.iceAccum || []));

    // The five fills above are what actually populate the gridpoint-backed rows
    // — and _fillHourlyGridCard removes a card outright when its series is
    // empty. So the row set is only final HERE, not at the innerHTML write.
    _invalidateHourlySync();
  });
}

// Writes a gridpoint-backed strip into one of the Hourly tab's placeholder
// cards, or removes the card entirely when the builder found nothing worth
// showing. Keeping the empty case as "no card" rather than "card of dashes"
// matters here: these three are seasonal and would otherwise be dead weight on
// the screen for most of the year.
function _fillHourlyGridCard(id, label, rowHTML) {
  const card = document.getElementById(id);
  if (!card) return;
  if (!rowHTML) { card.remove(); return; }
  card.innerHTML = `<div class="clbl">${label}</div>${rowHTML}`;
  applyDynamicStyles(card);
}

// Snow level in feet. Returns '' when the series never rises above zero, which
// is how NWS encodes "not a snow situation" rather than omitting the field.
function buildSnowLevelRow(hours, series) {
  if (!series?.length) return '';
  const n = Math.min(hours.length, 24);
  const vals = hours.slice(0, n).map(h => getGridValueAt(series, new Date(h.startTime)));
  if (!vals.some(v => v != null && v > 0)) return '';
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const sl = vals[i];
    // Unit in the small span rather than inline, matching buildGustRow. A
    // literal "9,957 ft" overflows the 56px .hr cell and pushes this row's
    // scrollWidth past every other row's — which breaks the equal-geometry
    // assumption the hourly scroll-sync relies on to share scrollLeft verbatim.
    const val  = sl != null ? Math.round(sl * UNIT.FT_PER_M).toLocaleString() : '--';
    const unit = sl != null ? 'ft' : '';
    return _dayBreakHTML(hours, i) + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv _s-5e0faa">${val}<span class="_s-7e7812"> ${unit}</span></span>
    </div>`;
  }).join('')}</div>`;
}

// Hour-by-hour accumulation (snowfall, ice), mm in and inches out. Returns ''
// when nothing accumulates over the window — see buildAccumTotal in marine.js
// for the matching 24-hour headline on the Details screen.
function buildAccumRow(hours, series) {
  if (!series?.length) return '';
  const n = Math.min(hours.length, 24);
  const vals = hours.slice(0, n).map(h => getGridValueAt(series, new Date(h.startTime)));
  if (!vals.some(v => v != null && v > 0)) return '';
  return `<div class="hrs">${hours.slice(0, n).map((h, i) => {
    const mm = vals[i];
    const inch = mm != null ? mm / UNIT.MM_PER_IN : null;
    // 'tr' for a trace: NWS reports these to the tenth of an inch, so anything
    // below that is real but unquantified — not the same as a zero.
    const txt = inch == null ? '--' : inch >= 0.05 ? inch.toFixed(1) + '"' : inch > 0 ? 'tr' : '0';
    return _dayBreakHTML(hours, i) + `<div class="hr${i === 0 ? ' now' : ''}">
      <span class="hrt">${i === 0 ? 'Now' : fh(h.startTime)}</span>
      <span class="hrv _s-6cb285">${txt}</span>
    </div>`;
  }).join('')}</div>`;
}

// ── AQI (item 14) ─────────────────────────────────────────────────────────────
// Primary source is AirNow, the EPA's official air-quality program (run jointly
// with NOAA, NPS and the state/local/tribal air agencies that own the monitors).
// Its reporting-area endpoint needs no API key and returns everything the Air
// Quality screen shows: current hourly AQI per pollutant, a multi-day forecast,
// the Action Day flag, and the local agency's written discussion.
//
// Open-Meteo stays as the fallback. AirNow only covers US reporting areas, so a
// location outside one (or an AirNow outage) still gets a number on the tile —
// it's a model output rather than a monitor reading, and the screen says so.

// The six EPA AQI categories, in order. `label` is the official category name
// (matched against AirNow's `category` strings); `short` is the abbreviated
// form the narrow tile and forecast rows use; `advice` is the EPA's activity
// guidance for that category, condensed to one line.
const AQI_CATS = [
  { max:  50, label: 'Good',                           short: 'Good',             color: '#34C759',
    advice: 'Air quality is satisfactory. It’s a good day to be active outside.' },
  { max: 100, label: 'Moderate',                        short: 'Moderate',         color: '#FFD60A',
    advice: 'Unusually sensitive people should consider shortening long or intense outdoor activity.' },
  { max: 150, label: 'Unhealthy for Sensitive Groups',  short: 'Sensitive Groups', color: '#FF9F0A',
    advice: 'People with heart or lung disease, older adults, children and teens should shorten long or intense outdoor activity.' },
  { max: 200, label: 'Unhealthy',                       short: 'Unhealthy',        color: '#FF453A',
    advice: 'Everyone should shorten long or intense outdoor activity; sensitive groups should move activities indoors.' },
  { max: 300, label: 'Very Unhealthy',                  short: 'Very Unhealthy',   color: '#BF5AF2',
    advice: 'Everyone should avoid long or intense outdoor activity; sensitive groups should stay indoors and keep activity light.' },
  { max: Infinity, label: 'Hazardous',                  short: 'Hazardous',        color: '#8B0000',
    advice: 'Health warning of emergency conditions. Everyone should stay indoors and keep activity levels low.' },
];

function aqiCategory(aqi) {
  return AQI_CATS.find(c => aqi <= c.max) || AQI_CATS[AQI_CATS.length - 1];
}

// AirNow sends the category as a string, and on forecast rows it is sometimes
// the only thing present (the numeric AQI can be null). Match on the name so
// those rows still get the right colour, falling back to the numeric mapping.
function aqiCatByName(name, aqi) {
  const n = String(name || '').trim().toLowerCase();
  const hit = AQI_CATS.find(c => c.label.toLowerCase() === n || c.short.toLowerCase() === n);
  if (hit) return hit;
  return Number.isFinite(aqi) ? aqiCategory(aqi) : null;
}

// Position (0–100%) of an AQI value along the .aq-scale gradient. The six
// category bands cover unequal numeric ranges (0–50 vs 300–500) but are drawn
// as equal-width blocks, so the dot has to be placed band-relative — a linear
// value/500 mapping would park it under the wrong colour.
function _aqiScalePct(aqi) {
  const edges = [0, 51, 101, 151, 201, 301, 501];
  const n = Math.max(0, Math.min(500, Number(aqi) || 0));
  for (let i = 0; i < 6; i++) {
    if (n < edges[i + 1]) return ((i + (n - edges[i]) / (edges[i + 1] - edges[i])) / 6) * 100;
  }
  return 100;
}

// AirNow parameter code → display name + what it actually is.
const AQ_POLLUTANTS = {
  'PM2.5': { name: 'Fine Particles',     abbr: 'PM2.5', sub: 'Smoke, soot & haze' },
  'PM10':  { name: 'Coarse Particles',   abbr: 'PM10',  sub: 'Dust, pollen & ash' },
  'OZONE': { name: 'Ozone',              abbr: 'O₃', sub: 'Ground-level smog' },
  'NO2':   { name: 'Nitrogen Dioxide',   abbr: 'NO₂', sub: 'Traffic & combustion' },
  'CO':    { name: 'Carbon Monoxide',    abbr: 'CO',    sub: 'Combustion exhaust' },
  'SO2':   { name: 'Sulfur Dioxide',     abbr: 'SO₂', sub: 'Fuel burning' },
};
const _aqPollutant = p => AQ_POLLUTANTS[p] || { name: p, abbr: p, sub: '' };

// ── AirNow fetch + parse ─────────────────────────────────────────────────────
// Cached per rounded coordinate so the tile fetch on the Weather screen and the
// Air Quality screen share one request. AirNow observations update hourly.
const _airCache = new Map(); // "lat,lon" → { at, data }
const AIRNOW_TTL_MS = 15 * 60 * 1000;
const _airKey = loc => `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;

function _airCachePeek(loc) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  const hit = _airCache.get(_airKey(loc));
  return hit && Date.now() - hit.at < AIRNOW_TTL_MS ? hit.data : null;
}

// "08/02/26" → Date (local midnight). AirNow dates are MM/DD/YY.
function _airDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(String(s || '').trim());
  return m ? new Date(2000 + +m[3], +m[1] - 1, +m[2]) : null;
}

// Calendar key of an AirNow date (built at local midnight from its MM/DD/YY
// parts, so its components ARE the AirNow date).
function _airKey10(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Today" / "Tomorrow" / "Wed", relative to the LOCATION's date — AirNow dates
// are the reporting area's own. Compared against the phone's date, a Honolulu
// forecast viewed from New York in the evening was a day off.
function _airDayLabel(d) {
  if (!d) return '';
  const k = _airKey10(d);
  if (k === _locDayKey(new Date())) return 'Today';
  if (k === _locDayKey(new Date(Date.now() + 86400000))) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

// Reshapes the flat record list into { current, observations, forecast, … }.
// Returns null when the response holds nothing usable — the caller treats that
// the same as "no reporting area here" and falls back to Open-Meteo.
function _parseAirNow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;

  const obsByParam = new Map();  // param → latest observation
  const fcstByDate = new Map();  // "MM/DD/YY" → [rows]
  let area = '', state = '', agency = '', discussion = '', actionDate = null, tz = '';

  for (const r of rows) {
    const param = String(r.parameter || '').toUpperCase().trim();
    if (!param) continue;
    const aqi = r.aqi != null && Number.isFinite(+r.aqi) ? Math.round(+r.aqi) : null;
    const rec = {
      param, aqi,
      category:  String(r.category || '').trim(),
      isPrimary: r.isPrimary === true,
      time:      String(r.time || '').trim(),
      validDate: String(r.validDate || '').trim(),
    };
    area   = area   || String(r.reportingArea    || '').trim();
    state  = state  || String(r.stateCode        || '').trim();
    agency = agency || String(r.reportingAgency  || '').trim();
    tz     = tz     || String(r.timezone         || '').trim();

    if (r.dataType === 'O') {
      // Same pollutant can appear more than once; keep the latest clock hour.
      const prev = obsByParam.get(param);
      if (!prev || rec.time > prev.time) obsByParam.set(param, rec);
    } else if (r.dataType === 'F') {
      if (!discussion && r.discussion) discussion = String(r.discussion).trim();
      // Action Day lives on the forecast rows; remember the earliest flagged day.
      if (r.isActionDay === true) {
        const d = _airDate(rec.validDate);
        if (d && (!actionDate || d < actionDate)) actionDate = d;
      }
      if (!fcstByDate.has(rec.validDate)) fcstByDate.set(rec.validDate, []);
      fcstByDate.get(rec.validDate).push(rec);
    }
  }

  // Highest-AQI row wins when nothing is flagged primary — that's the pollutant
  // the overall AQI is reported against.
  const pickDominant = list => {
    if (!list.length) return null;
    return list.find(r => r.isPrimary && r.aqi != null)
        || list.find(r => r.isPrimary)
        || list.slice().sort((a, b) => (b.aqi ?? -1) - (a.aqi ?? -1))[0];
  };

  const observations = [...obsByParam.values()]
    .sort((a, b) => (b.aqi ?? -1) - (a.aqi ?? -1));
  const current = pickDominant(observations);

  const todayKey = _locDayKey(new Date());
  const forecast = [...fcstByDate.entries()]
    .map(([date, list]) => {
      const pick = pickDominant(list);
      return pick ? { ...pick, date: _airDate(date) } : null;
    })
    .filter(f => f && f.date && _airKey10(f.date) >= todayKey)   // drop yesterday's leftovers
    .sort((a, b) => a.date - b.date)
    .slice(0, 5);

  if (!current && !forecast.length) return null;

  return {
    source: 'airnow',
    area, state, agency, discussion, tz,
    actionDate,
    current, observations, forecast,
  };
}

async function fetchAirNow(loc) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  const cached = _airCachePeek(loc);
  if (cached) return cached;
  const key = _airKey(loc);
  const r = await fetch(
    `https://airnowgovapi.com/reportingarea/get?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`AirNow HTTP ${r.status}`);
  const data = _parseAirNow(await r.json());
  // Cache the miss too — a location with no reporting area shouldn't re-request
  // on every renderWx().
  _airCache.set(key, { at: Date.now(), data });
  return data;
}

// Modeled US AQI — the fallback when AirNow has no reporting area nearby.
async function fetchOpenMeteoAQI(loc) {
  const r = await fetch(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}&current=us_aqi`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  const j = await r.json();
  const aqi = j?.current?.us_aqi;
  return aqi != null && Number.isFinite(+aqi) ? Math.round(+aqi) : null;
}

function _paintAQITile(aqi, categoryName) {
  const cat = aqiCatByName(categoryName, aqi) || aqiCategory(aqi);
  const el    = document.getElementById('tile-aqi');
  const subEl = document.getElementById('tile-aqi-sub');
  if (el)    { el.textContent = aqi != null ? aqi : '--'; el.style.color = cat.color; }
  if (subEl) subEl.textContent = cat.short;
}

async function fetchAQI() {
  const myGen = _locGen;
  const loc = activeLocation;
  let resolved = false; // #20: did we land a real reading?
  if (!loc.lat || !loc.lon) { _resolveAQIPending(myGen); return; }
  try {
    let air = null;
    try { air = await fetchAirNow(loc); } catch (e) { _warn('fetchAirNow', e); }
    if (_locGen !== myGen) return;
    if (air?.current?.aqi != null) {
      _paintAQITile(air.current.aqi, air.current.category);
      resolved = true;
      return;
    }
    const val = await fetchOpenMeteoAQI(loc);
    if (_locGen !== myGen) return;
    if (val != null) { _paintAQITile(val, null); resolved = true; }
  } catch (e) { _warn('fetchAQI', e); }
  finally { if (!resolved) _resolveAQIPending(myGen); }
}

// ── Air Quality detail screen (s-air) ────────────────────────────────────────
// Reached by tapping the AIR QUAL. tile on the Weather screen. Renders the full
// AirNow picture for the location: current AQI and the pollutant it's driven
// by, every monitored pollutant, the EPA health guidance for that category, the
// multi-day agency forecast, and the forecaster's discussion.

// Big number + category + where/when it was measured.
function _aqHeroHTML(air) {
  const cur = air.current;
  const cat = aqiCatByName(cur.category, cur.aqi) || aqiCategory(cur.aqi);
  const p   = _aqPollutant(cur.param);
  const pct = _aqiScalePct(cur.aqi);
  const where = [air.area, air.state].filter(Boolean).join(', ');
  const when  = cur.time ? `${cur.time}${air.tz ? ' ' + air.tz : ''}` : '';
  return `<div class="card">
    <div class="clbl">${clblIcon('si-air')}CURRENT AIR QUALITY<span class="dv-tag">AIRNOW</span></div>
    <div class="dv-now">
      <div class="dv-val" data-css-color="${cat.color}">${cur.aqi != null ? cur.aqi : '--'}</div>
      <div class="dv-now-txt">
        <div class="dv-cat" data-css-color="${cat.color}">${esc(cur.category || cat.label)}</div>
        <div class="dv-now-sub">US AQI &middot; ${esc(p.name)} (${esc(p.abbr)})</div>
      </div>
    </div>
    <div class="aq-scale"><div class="dv-dot" data-css-left="${pct.toFixed(1)}%"></div></div>
    <div class="dv-ticks"><span>0</span><span>50</span><span>100</span><span>150</span><span>200</span><span>300</span><span>500</span></div>
    <div class="dv-where">${esc(where)}${when ? ' &middot; ' + esc(when) : ''}</div>
  </div>`;
}

// EPA activity guidance for the category currently in effect.
function _aqAdviceHTML(air) {
  const cur = air.current;
  const cat = aqiCatByName(cur.category, cur.aqi) || aqiCategory(cur.aqi);
  return `<div class="card">
    <div class="clbl">${clblIcon('si-heart')}WHAT THIS MEANS</div>
    <div class="dv-advice"><span class="dv-advice-bar" data-css-bg="${cat.color}"></span>${esc(cat.advice)}</div>
  </div>`;
}

// One row per monitored pollutant, ordered worst-first by _parseAirNow.
function _aqPollutantsHTML(air) {
  if (!air.observations?.length) return '';
  const rows = air.observations.map(o => {
    const cat = aqiCatByName(o.category, o.aqi) || aqiCategory(o.aqi);
    const p   = _aqPollutant(o.param);
    const pct = o.aqi != null ? _aqiScalePct(o.aqi) : 0;
    // Badge the pollutant the headline AQI is actually reported against — the
    // one _parseAirNow chose — rather than AirNow's isPrimary flag, which some
    // agencies leave unset on every row.
    const isMain = o === air.current;
    return `<div class="aq-prow">
      <div class="aq-pname">
        <span class="aq-pn">${esc(p.name)}${isMain ? '<span class="aq-pri">MAIN</span>' : ''}</span>
        <span class="aq-psub">${esc(p.abbr)}${p.sub ? ' &middot; ' + esc(p.sub) : ''}</span>
      </div>
      <div class="aq-ptrack"><div class="aq-pbar" data-css-width="${pct.toFixed(1)}%" data-css-bg="${cat.color}"></div></div>
      <div class="aq-pval">
        <span class="aq-paqi" data-css-color="${cat.color}">${o.aqi != null ? o.aqi : '--'}</span>
        <span class="aq-pcat">${esc(cat.short)}</span>
      </div>
    </div>`;
  }).join('');
  return `<div class="card">
    <div class="clbl">${clblIcon('si-air')}POLLUTANTS MEASURED NOW</div>
    ${rows}
  </div>`;
}

function _aqForecastHTML(air) {
  if (!air.forecast?.length) return '';
  const rows = air.forecast.map(f => {
    const cat = aqiCatByName(f.category, f.aqi) || aqiCategory(f.aqi);
    const p   = _aqPollutant(f.param);
    return `<div class="aq-frow">
      <span class="aq-fdot" data-css-bg="${cat.color}"></span>
      <span class="aq-fday">${esc(_airDayLabel(f.date))}</span>
      <span class="aq-fparam">${esc(p.abbr)}</span>
      <span class="aq-fcat">${esc(f.category || cat.label)}</span>
      <span class="aq-faqi" data-css-color="${cat.color}">${f.aqi != null ? f.aqi : '--'}</span>
    </div>`;
  }).join('');
  return `<div class="card">
    <div class="clbl">${clblIcon('si-sun')}AIR QUALITY FORECAST</div>
    ${rows}
    <div class="aq-fnote">Peak AQI expected each day, from ${esc(air.agency || 'the local air agency')}.</div>
  </div>`;
}

function _aqDiscussionHTML(air) {
  if (!air.discussion) return '';
  return `<div class="card">
    <div class="clbl">FORECASTER'S DISCUSSION<span class="dv-tag">${esc(air.agency || 'AIRNOW')}</span></div>
    <div id="aq-discussion" class="afd-scroll aq-disc afd-collapsed" data-click-action="expandAFD">${esc(air.discussion)}</div>
    <button class="afd-expand-btn" id="aq-disc-btn" data-click-action="toggleAQDisc">Read full discussion &rsaquo;</button>
  </div>`;
}

function _aqActionHTML(air) {
  if (!air.actionDate) return '';
  const day = _airDayLabel(air.actionDate);
  return `<div class="aq-action">
    <span class="aq-action-ico">&#9888;&#65039;</span>
    <span><strong>Air Quality Action Day</strong> ${esc(day.toLowerCase() === 'today' ? 'today' : day)}.
    ${esc(air.agency || 'The local air agency')} asks people to drive less and cut other emissions.</span>
  </div>`;
}

const AQ_SOURCE_NOTE = `AirNow: U.S. EPA with NOAA, NPS, and tribal, state &amp; local air agencies &middot; airnow.gov.
  Readings come from the nearest official monitoring area, so they may differ from conditions on your street.`;

function _aqScreenHTML(air) {
  return `${_aqActionHTML(air)}
    ${air.current ? _aqHeroHTML(air) : ''}
    ${air.current ? _aqAdviceHTML(air) : ''}
    ${_aqPollutantsHTML(air)}
    ${_aqForecastHTML(air)}
    <div id="aq-dispersion"></div>
    ${_aqDiscussionHTML(air)}
    <div class="dv-source">${AQ_SOURCE_NOTE}</div>`;
}

// Shown when the location sits outside every AirNow reporting area (or AirNow
// is down). Falls back to the modeled Open-Meteo value rather than an empty
// screen, and is explicit that it is a model, not a monitor.
function _aqFallbackHTML(aqi) {
  if (aqi == null) {
    return `<div class="card">
      <div class="clbl">${clblIcon('si-air')}AIR QUALITY</div>
      <div class="api-unavailable-msg">No air quality data available for this location right now.</div>
    </div>
    <div class="dv-source">${AQ_SOURCE_NOTE}</div>`;
  }
  const cat = aqiCategory(aqi);
  return `<div class="card">
    <div class="clbl">${clblIcon('si-air')}CURRENT AIR QUALITY<span class="dv-tag">MODELED</span></div>
    <div class="dv-now">
      <div class="dv-val" data-css-color="${cat.color}">${aqi}</div>
      <div class="dv-now-txt">
        <div class="dv-cat" data-css-color="${cat.color}">${esc(cat.label)}</div>
        <div class="dv-now-sub">US AQI &middot; modeled estimate</div>
      </div>
    </div>
    <div class="aq-scale"><div class="dv-dot" data-css-left="${_aqiScalePct(aqi).toFixed(1)}%"></div></div>
    <div class="dv-ticks"><span>0</span><span>50</span><span>100</span><span>150</span><span>200</span><span>300</span><span>500</span></div>
    <div class="dv-where">No EPA AirNow reporting area covers this location</div>
  </div>
  <div class="card">
    <div class="clbl">${clblIcon('si-heart')}WHAT THIS MEANS</div>
    <div class="dv-advice"><span class="dv-advice-bar" data-css-bg="${cat.color}"></span>${esc(cat.advice)}</div>
  </div>
  <div id="aq-dispersion"></div>
  <div class="dv-source">This location is outside the EPA AirNow monitoring network, so the value above is a
    model estimate from Open-Meteo rather than a ground monitor reading. Pollutant breakdown, forecast and
    agency discussion are only available inside an AirNow reporting area.</div>`;
}

async function renderAirQuality() {
  const body = document.getElementById('air-body');
  if (!body) return;
  const myGen = _locGen;
  const loc = activeLocation;

  // Paint straight from cache when the Weather-screen tile already fetched it,
  // so the screen opens populated instead of flashing a spinner.
  const cached = _airCachePeek(loc);
  if (cached) _setInnerIfChanged(body, _aqScreenHTML(cached));
  else _setInnerIfChanged(body, `<div class="ldg" role="status" aria-live="polite"><div class="spin"></div><div class="_s-5e0faa">Loading air quality&hellip;</div></div>`);

  if (!loc?.lat || !loc?.lon) {
    _setInnerIfChanged(body, _aqFallbackHTML(null));
    return;
  }

  let air = null;
  try { air = await fetchAirNow(loc); } catch (e) { _warn('fetchAirNow', e); }
  if (_locGen !== myGen) return;                       // location changed mid-flight
  if (air) { _setInnerIfChanged(body, _aqScreenHTML(air)); _renderAQDispersion(myGen); return; }

  let val = null;
  try { val = await fetchOpenMeteoAQI(loc); } catch (e) { _warn('fetchOpenMeteoAQI', e); }
  if (_locGen !== myGen) return;
  _setInnerIfChanged(body, _aqFallbackHTML(val));
  _renderAQDispersion(myGen);
}

// ── Dispersion (why the air is bad, not just how bad) ────────────────────────
//
// AQI says how polluted the air is; these two say whether it can clear. Mixing
// height is the depth of air pollutants get stirred through, and transport wind
// is how fast that layer moves downwind — a shallow layer under light wind
// traps smoke and haze near the ground even when nothing new is being emitted.
//
// Both ride along on the gridpoint request the app already makes for the
// Details screen, so this costs no extra network.
//
// Ventilation index = mixing height (m) x transport wind (m/s). The category
// breaks below are the smoke-management convention used in fire weather, not
// an EPA AQI scale — worded as dispersion, never as a health number, so it
// can't be misread as a second AQI.
const VENT_CATS = [
  { max: 2000,     label: 'Poor',      color: '#FF453A', note: 'Stagnant air. Smoke and haze will stay near the ground.' },
  { max: 4000,     label: 'Fair',      color: '#FF9F0A', note: 'Limited mixing. Pollutants clear slowly.' },
  { max: 6000,     label: 'Good',      color: '#30D158', note: 'Good mixing. Pollutants clear at a normal rate.' },
  { max: Infinity, label: 'Excellent', color: '#5AC8FA', note: 'Strong mixing. Pollutants clear quickly.' },
];

async function _renderAQDispersion(myGen) {
  const el = document.getElementById('aq-dispersion');
  if (!el) return;
  let data;
  data = await getGridpointDataCached();
  if (!data || _locGen !== myGen) return;              // failed, or switched location mid-flight
  const el2 = document.getElementById('aq-dispersion');
  if (!el2) return;
  delete el2.dataset.note;   // a note from an earlier reading must not outlive it

  const now = new Date();
  const mixM   = getGridValueAt(data.mixingHeight, now);
  const spdKmh = getGridValueAt(data.transportSpd, now);
  const dirDeg = getGridValueAt(data.transportDir, now);
  // Not every office publishes these; render nothing rather than an empty card.
  if (mixM == null && spdKmh == null) return;

  const mixFt  = mixM != null ? Math.round(mixM * UNIT.FT_PER_M) : null;
  const spdMph = spdKmh != null ? Math.round(spdKmh / UNIT.KMH_PER_MPH) : null;
  const spdTxt = spdKmh == null ? '--'
    : uWind === 'kmh' ? Math.round(spdKmh) + ' km/h' : spdMph + ' mph';
  const dirTxt = dirDeg != null ? ' ' + degToCompass(dirDeg) : '';

  // Only categorize when both inputs exist — a ventilation index computed from
  // a missing half would be confidently wrong.
  let vent = '';
  if (mixM != null && spdKmh != null) {
    const vi = mixM * (spdKmh / 3.6);
    const cat = VENT_CATS.find(c => vi < c.max);
    vent = `<div class="sm-item"><div class="sm-lbl">DISPERSION</div>
        <div class="sm-val" data-css-color="${cat.color}">${cat.label}</div></div>`;
    el2.dataset.note = cat.note;
  }

  el2.innerHTML = `<div class="card">
    <div class="clbl">${clblIcon('si-wind')}DISPERSION &middot; NWS</div>
    <div class="sm-grid">
      ${vent}
      <div class="sm-item"><div class="sm-lbl">MIXING HEIGHT</div>
        <div class="sm-val">${mixFt != null ? mixFt.toLocaleString() + ' ft' : '--'}</div></div>
      <div class="sm-item"><div class="sm-lbl">TRANSPORT WIND</div>
        <div class="sm-val">${esc(spdTxt + dirTxt)}</div></div>
    </div>
    ${el2.dataset.note ? `<div class="_s-0962aa">${esc(el2.dataset.note)}</div>` : ''}
  </div>`;
  // Direct innerHTML write — see the note in renderExtended(). data-css-* only
  // takes effect if we apply it ourselves.
  applyDynamicStyles(el2);
}

function toggleAQDisc(btn) {
  const body = document.getElementById('aq-discussion');
  if (!body) return;
  const isOpen = body.classList.toggle('afd-open');
  if (btn) btn.textContent = isOpen ? 'Collapse ‹' : 'Read full discussion ›';
}

// ── AFD expand/collapse (item 16) ─────────────────────────────────────────────
// Clicking the collapsed discussion body itself expands it (not just the
// "Read full discussion" button). Expand-only: a click inside an already-open
// box is ignored so the user can scroll/select the text without it collapsing.
function expandAFD(el) {
  const body = el.closest('.afd-scroll');
  if (!body || body.classList.contains('afd-open')) return;
  body.classList.add('afd-open');
  const btn = body.nextElementSibling;
  if (btn && btn.classList.contains('afd-expand-btn')) btn.textContent = 'Collapse ‹';
}

function toggleAFD(btn) {
  const body = document.getElementById('discussion-body');
  if (!body) return;
  const isOpen = body.classList.toggle('afd-open');
  if (btn) btn.textContent = isOpen ? 'Collapse ‹' : 'Read full discussion ›';
}

// Grows the day list from its ~4-row window to the AFD-style 60vh cap. Mirrors
// toggleAFD: same button treatment, same collapse affordance.
function toggleDayList(btn) {
  const list = document.querySelector('#wx-body .dlist');
  if (!list) return;
  const isOpen = list.classList.toggle('dlist-open');
  if (btn) btn.textContent = isOpen ? 'Collapse ‹' : 'Show all 7 days ›';
  // Height changed, so the "more below" fade needs recomputing.
  _syncDayListFade(list);
}

function toggleExtAFD(btn) {
  const body = document.getElementById('ext-discussion-body');
  if (!body) return;
  const isOpen = body.classList.toggle('afd-open');
  if (btn) btn.textContent = isOpen ? 'Collapse ‹' : 'Read full discussion ›';
}

// Double-tapping an expanded AFD box collapses it back down. Delegated on
// document since #discussion-body / #ext-discussion-body are recreated by
// renderWx() / renderExtendedForecast() innerHTML writes.
document.addEventListener('dblclick', e => {
  const body = e.target.closest('.afd-collapsed.afd-open');
  if (!body) return;
  e.preventDefault();
  body.classList.remove('afd-open');
  body.scrollTop = 0;
  const btn = body.nextElementSibling;
  if (btn && btn.classList.contains('afd-expand-btn')) btn.textContent = 'Read full discussion ›';
  body.closest('._s-fa9415, .ext-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
});

// ── Share (item 8) ───────────────────────────────────────────────────────────
// Uses the Web Share API (supported natively by WKWebView via Capacitor) with a
// clipboard-copy fallback for PWA/web builds. Shares current conditions as plain
// text — no screenshot needed, no extra permissions.
function shareWeather() {
  const loc = displayName(activeLocation);
  const p   = wxData.forecast[0];
  if (!loc || !p) return;

  // Prefer the live observed temp if it's been patched in by fetchCurrentObs().
  const tempEl = document.getElementById('tile-temp');
  const temp   = tempEl?.textContent || ft(p.temperature);
  const cond   = p.shortForecast || '';

  // High / Low from the first day+night pair
  const pair = (wxData.forecast[0] && wxData.forecast[1])
    ? { hi: wxData.forecast[0].isDaytime ? wxData.forecast[0].temperature : wxData.forecast[1].temperature,
        lo: wxData.forecast[0].isDaytime ? wxData.forecast[1].temperature : wxData.forecast[0].temperature }
    : null;
  const hlLine = pair ? `H: ${ft(pair.hi)}  ·  L: ${ft(pair.lo)}\n` : '';

  const windEl = document.getElementById('tile-wind');
  const wind   = windEl?.textContent;
  const windLine = wind && wind !== '--' ? `💨 Wind: ${wind}\n` : '';

  const alertLine = wxData.alerts?.length
    ? `⚠️ ${wxData.alerts[0].properties?.headline || wxData.alerts[0].properties?.event || 'Active NWS Alert'}\n`
    : '';

  const shareText =
    `📍 ${loc}\n` +
    `🌡 ${temp} · ${cond}\n` +
    hlLine +
    windLine +
    alertLine +
    `\nVia NOAA Weather Unofficial`;

  // The link opens this place in the app for anyone who has it, and in the
  // web build for anyone who doesn't.
  const url = appLinkFor(activeLocation);
  if (typeof navigator.share === 'function') {
    navigator.share({ title: `${loc} Weather`, text: shareText, url }).catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(`${shareText}\n${url}`).then(() => {
      flashInfoToast('Copied to clipboard', 'Forecast copied. Paste it anywhere to share.');
    }).catch(() => {
      flashErrorToast('Share unavailable', 'Sharing is not supported in this browser');
    });
  }
}

// ── Location management ──────────────────────────────────────────────────────

async function resolveGridpoint(loc) {
  // Keyed by id AND coordinate. Saved locations never move, but 'gps' is a
  // single pseudo-id whose coordinate changes with every fix — so an id-only
  // key meant the first GPS lookup of a session pinned that city's gridpoint,
  // zone and relativeLocation to the key forever. Tapping "use my location"
  // from anywhere else then re-used them and the app kept showing the previous
  // city: the GPS button visibly did nothing.
  const ck = `${loc.id}@${loc.lat},${loc.lon}`;
  if (locPointCache[ck]) { Object.assign(loc, locPointCache[ck]); return; }
  const r = await nwsFetch(`https://api.weather.gov/points/${loc.lat},${loc.lon}`);
  if (!r.ok) throw new Error('Points lookup failed');
  const d = await r.json();
  const p = d.properties;
  const rel = p.relativeLocation?.properties;
  const relDistMi = rel?.distance?.value ? Math.round(rel.distance.value / UNIT.M_PER_MI) : null;
  const resolved = {
    wfo: p.gridId, gx: p.gridX, gy: p.gridY,
    zone: p.forecastZone?.split('/').pop() || '',
    radarStation: p.radarStation || null, // e.g. "KATX", "KDIX"
    county: p.county?.split('/').pop() || '', // e.g. "WAC033"
    timeZone: p.timeZone || null, // IANA zone (e.g. "America/Los_Angeles")
    relCity: rel?.city || '', relState: rel?.state || '', relDistMi
  };
  Object.assign(loc, resolved);
  locPointCache[ck] = resolved;
}

// Returns false when the switch did not happen — the NWS gridpoint lookup
// failed, or a later switch took over while this one was waiting — so callers
// with follow-up work (useGPS renames, selectGsrResult cleans up) can tell.
async function setActiveLocation(loc) {
  // #12: bump the generation counter FIRST so any in-flight fetch from the
  // previous location sees a moved-on gen when it tries to render, and bails.
  const myGen = _bumpLocGen();
  // #11: cancel any pending alerts retry from the previous zone.
  if (typeof _cancelAlertsRetry === 'function') _cancelAlertsRetry();
  // Storm Center caches products per WFO — drop them so the next open refetches
  // against the new office rather than showing the previous location's text.
  if (typeof resetStormCenter === 'function') resetStormCenter();

  // #10: keep `activeLocation` referentially identical to the SAVED_LOCS
  // entry with the same id so writes via activeLocation._cond etc. update the
  // same object the locations list reads. If `loc` is brand-new (e.g. a
  // search result that hasn't been pushed yet), promote it into SAVED_LOCS
  // instead of letting the two refs diverge.
  const existingIdx = SAVED_LOCS.findIndex(l => l.id === loc.id);
  if (existingIdx >= 0) {
    Object.assign(SAVED_LOCS[existingIdx], loc); // copy any newly resolved fields
    loc = SAVED_LOCS[existingIdx];
  } else {
    SAVED_LOCS.push(loc);
  }

  try {
    if (!loc.wfo || !loc.gx) {
      const _wb1 = document.getElementById('wx-body');
      _wb1.innerHTML = '<div class="ldg" role="status" aria-live="polite"><div class="spin"></div><div class="_s-5e0faa">Resolving location…</div></div>';
      _wb1._lastHtml = null; // force renderWx() to write even if the new data matches old _lastHtml
      await resolveGridpoint(loc);
    } else if (!loc.relCity) {
      // Grid already known but relativeLocation not fetched yet.
      // Await it (no spinner — grid is known so weather fetch proceeds right after).
      await resolveGridpoint(loc).catch(() => {});
    }
  } catch (e) {
    // The lookup failed (NWS answers /points with an intermittent 500, and some
    // points have no grid). This used to throw out of here uncaught and leave
    // "Resolving location…" spinning with no way out. Put the location the
    // user was already on back on screen instead, and say what happened.
    if (_locGen !== myGen) return false;
    _warn('setActiveLocation', e);
    flashErrorToast('Location unavailable',
      'Couldn’t get a forecast for this location. Try again.');
    const wb = document.getElementById('wx-body');
    if (wb) wb._lastHtml = null;
    if (wxData.forecast.length) renderWx(); else fetchWx();
    fetchAlerts();   // the bump above discarded any poll that was in flight
    return false;
  }
  // A later switch started while this one waited on the lookup. Letting this
  // one carry on would overwrite it: tap a search result (slow, needs the
  // lookup) and then a saved city, and the app ended up on the search result.
  if (_locGen !== myGen) return false;
  activeLocation = loc;
  // Drop any persisted map viewport for the previous location so the next
  // map open re-centers cleanly on the new active location.
  try {
    const k = 'noaa_map_prefs_v1';
    const p = JSON.parse(localStorage.getItem(k) || '{}') || {};
    if (p.view && p.view.locId !== loc.id) { delete p.view; localStorage.setItem(k, JSON.stringify(p)); }
  } catch (_) {}
  if (typeof _savedMapView !== 'undefined' && _savedMapView && _savedMapView.locId !== loc.id) {
    _savedMapView = null;
  }
  updateLocationHeader();
  const _wb = document.getElementById('wx-body');
  _wb.innerHTML = '<div class="ldg" role="status" aria-live="polite"><div class="spin"></div><div class="_s-5e0faa">Fetching from api.weather.gov…</div></div>';
  _wb._lastHtml = null; // force renderWx() to write even if the new data matches old _lastHtml
  wxData = { forecast: [], hourly: [], alerts: [], hourlyFailed: false };
  await Promise.all([fetchWx(), fetchAlerts()]);
  if (window.pushNative) window.pushNative.syncLocation();
  // Persist the new active location so it's restored on next cold boot.
  saveSavedLocs();
  _syncWidget();
  return true;
}

function updateLocationHeader() {
  const nameEl = document.getElementById('hdr-loc-name');
  const zoneEl = document.getElementById('hdr-loc-zone');
  const stripEl = document.getElementById('hdr-strip-txt');
  const hourlyNameEl = document.getElementById('hourly-loc-name');
  const detailsNameEl = document.getElementById('details-loc-name');
  const forecastExtNameEl = document.getElementById('forecast-ext-loc-name');
  const airNameEl = document.getElementById('air-loc-name');
  const uvNameEl = document.getElementById('uv-loc-name');
  const settingsStripEl = document.getElementById('settings-loc-strip');
  // Use displayName() everywhere — it gracefully falls back to relCity+relState
  // when the raw name is generic (the "Current Location" GPS case).
  const dispName = displayName(activeLocation);
  if (nameEl) nameEl.textContent = dispName;
  // Append a subtle › to the zone/subtitle line so users know the header
  // location is tappable. The ›  sits on a separate line from the city name
  // so it doesn't get clipped by the max-width on _s-2cbcc1.
  if (zoneEl) {
    const zoneBase = activeLocation.zone ? 'Zone ' + activeLocation.zone : activeLocation.subtitle || '';
    zoneEl.textContent = (zoneBase ? zoneBase + ' ' : '') + '›';
  }
  // Same affordance on the hourly / details screen location buttons.
  if (hourlyNameEl) hourlyNameEl.textContent = dispName + ' ›';
  if (detailsNameEl) detailsNameEl.textContent = dispName + ' ›';
  if (forecastExtNameEl) forecastExtNameEl.textContent = dispName + ' ›';
  if (airNameEl) airNameEl.textContent = dispName + ' ›';
  if (uvNameEl) uvNameEl.textContent = dispName + ' ›';
  if (stripEl) {
    const cityPart = activeLocation.relCity && activeLocation.relState
      ? activeLocation.relCity.toUpperCase() + ' ' + activeLocation.relState.toUpperCase() + ' '
      : '';
    const nwsText = 'NATIONAL WEATHER SERVICE \xb7 ' + cityPart + '(' + (activeLocation.wfo || 'NWS') + ')';
    _baseStripText = nwsText;
    // Only write if not currently showing a stale message (avoids brief flash
    // of NWS text when a location switch happens during a stale state).
    if (!stripEl._staleMsg) stripEl.textContent = nwsText;
  }
  const compactCity = dispName.split(',')[0].trim();

  if (settingsStripEl) {
    const zone = activeLocation.zone ? ' \xb7 ZONE ' + activeLocation.zone : '';
    settingsStripEl.textContent = dispName.toUpperCase() + zone;
  }

  // Map strip — refresh even when the user hasn't reopened the map screen
  // since location changed. Only meaningful in radar mode.
  const mapStripEl = document.querySelector('#s-map .ss-txt');
  if (mapStripEl && typeof curBase !== 'undefined' && curBase === 'radar') {
    const rs = activeLocation.radarStation;
    mapStripEl.textContent = 'NWS RADAR \xb7 '
      + (rs ? rs + (compactCity ? ' \xb7 ' + compactCity.toUpperCase() : '') : 'NEXRAD MOSAIC')
      + ' \xb7 RIDGE2';
  }
}

async function switchToLocation(id) {
  const loc = SAVED_LOCS.find(l => l.id === id) || (id === 'gps' ? _gpsLoc : null);
  if (!loc) return;
  goNav('s-wx', document.querySelector('#s-loc .bnav .nbtn:first-child'));
  // Already showing this location's weather — just navigate back, no spinner.
  if (id === activeLocation.id && wxData.forecast.length) return;
  await setActiveLocation(loc);
}

async function fetchLocSummary(loc) {
  // C9: capture the generation. If the user switches locations (or removes
  // this one) while the fetch is in flight, the response may be relevant to
  // a SAVED_LOCS entry that no longer exists. We still write to `loc`
  // (which is parameter-bound and can't be re-aimed mid-call), but we skip
  // the DOM-write path inside renderLocations by silently returning if the
  // card is gone — the .then() handler at the call site already null-checks
  // `document.getElementById`, so this gen guard is belt-and-suspenders.
  const myGen = _locGen;
  try {
    if (!loc.wfo || !loc.gx) await resolveGridpoint(loc);
    if (_locGen !== myGen && !SAVED_LOCS.some(l => l === loc)) return;
    const r = await nwsFetch(`https://api.weather.gov/gridpoints/${loc.wfo}/${loc.gx},${loc.gy}/forecast`);
    if (_locGen !== myGen && !SAVED_LOCS.some(l => l === loc)) return;
    const d = await r.json();
    const period = d.properties?.periods?.[0];
    if (period) {
      loc._cond = period.shortForecast;
      loc._temp = ft(period.temperature);
      loc._icon = nwsIconUrl(period, 'small');
      loc._at   = Date.now(); // #10: timestamp so renderLocations can detect staleness
    }
  } catch {
    // B3: stamp _at even on failure so renderLocations honors the TTL and
    // doesn't re-hammer the API once a card is persistently "Unavailable".
    // Successful refetches still happen at the next TTL boundary or on PTR.
    loc._cond = 'Unavailable';
    loc._at = Date.now();
  }
}

// Refetch a card's summary once it's older than this. Anything within the
// window is "fresh enough" to display while the user browses the list.
const LOC_SUMMARY_TTL_MS = 10 * 60 * 1000;

function renderLocations() {
  const list = document.getElementById('loc-list');
  if (!list) return;
  // locCardHTML is isActive-free so the string only changes when locations are
  // added/removed — not on every active-location switch. This prevents all card
  // <img> elements from reloading every time the user picks a different city.
  const _locHtml = SAVED_LOCS.map(loc => locCardHTML(loc)).join('') +
    `<div class="loc-add-hint">Search above to add a city</div>`;
  _setInnerIfChanged(list, _locHtml); // #18 — no DOM write when nothing changed
  // Apply active-location highlight surgically (no innerHTML replace, no img reload).
  _applyLocActiveState();
  SAVED_LOCS.forEach(loc => {
    // #10: refresh if missing OR stale. The previous code only refetched when
    // _cond was falsy, so a card whose summary was last set when it was the
    // active location would stay stuck forever.
    const fresh = loc._cond && loc._at && (Date.now() - loc._at) < LOC_SUMMARY_TTL_MS;
    if (fresh) return;
    fetchLocSummary(loc).then(() => {
      const el = document.getElementById('lcc-' + loc.id);
      if (el) {
        el.classList.remove('lc-loading');
        el.textContent = loc._cond + (loc._temp ? ' · ' + loc._temp : '');
      }
      const img = document.getElementById('lci-' + loc.id);
      if (img && loc._icon) { img.src = loc._icon; img.style.display = 'block'; }
    });
  });
}

// Applies/removes the active-location border, ✓ badge, and aria-label on
// existing card DOM nodes without touching innerHTML — so <img> elements are
// never destroyed and reloaded just because the active location changed.
function _applyLocActiveState() {
  SAVED_LOCS.forEach(loc => {
    const card   = document.getElementById('lc-' + loc.id);
    const nameEl = document.getElementById('lcnm-' + loc.id);
    if (!card || !nameEl) return;
    const isActive = loc.id === activeLocation.id;
    card.classList.toggle('lcard-active', isActive);
    card.setAttribute('aria-label', 'Switch to ' + loc.name + (isActive ? ' (current)' : ''));
    const tick = nameEl.querySelector('._s-019d63');
    if (isActive && !tick) {
      const s = document.createElement('span');
      s.className = '_s-019d63';
      s.textContent = ' ✓';
      nameEl.appendChild(s);
    } else if (!isActive && tick) {
      tick.remove();
    }
  });
}

function locCardHTML(loc) {
  // Lookup, never interpolation of a stored string — see LOC_GRADIENTS. An
  // unknown/absent key resolves to the default literal, so whatever is in
  // localStorage, what lands in data-css-style is always app-authored CSS.
  const grad = LOC_GRADIENTS[loc.gradKey] || LOC_GRADIENTS.default;
  // Show shimmer on the condition line when data hasn't loaded yet (U1).
  const hasData = !!loc._cond;
  const cond = hasData ? loc._cond : '';
  const temp = loc._temp || '';
  const idHtml = esc(loc.id);
  const name   = esc(loc.name);
  return `<div class="lcard-wrap" id="lcw-${idHtml}">
    <button class="lcard-del" data-click-action="removeLocation" data-loc-id="${idHtml}" aria-label="Remove ${name}">✕</button>
    <div class="lcard" id="lc-${idHtml}" role="button" tabindex="0" aria-label="Switch to ${name}" data-css-style="background:${grad}" data-click-action="lcClick" data-keydown-action="_kbdClick"
      data-touchstart-action="lcTouchStart"
      data-touchmove-action="lcTouchMove"
      data-touchend-action="lcTouchEnd"
      data-touchcancel-action="lcTouchCancel"
      data-loc-id="${idHtml}">
      <div class="lcnm" id="lcnm-${idHtml}">${name}</div>
      <div class="lcc${hasData ? '' : ' lc-loading'}" id="lcc-${idHtml}">${hasData ? esc(cond) + (temp ? ' · ' + esc(temp) : '') : ''}</div>
      <img class="lc-nws" id="lci-${idHtml}" src="${esc(loc._icon || '')}" data-css-display="${loc._icon ? 'block' : 'none'}" loading="lazy" data-img-hide/>
    </div>
  </div>`;
}

function removeLocation(id) {
  const idx = SAVED_LOCS.findIndex(l => l.id === id);
  if (idx === -1) return;
  SAVED_LOCS.splice(idx, 1);
  saveSavedLocs();
  // Keep the widget's location picker in sync even when the removed entry
  // isn't the active location (setActiveLocation below already covers that case).
  _syncWidget();
  if (id === activeLocation.id) {
    if (SAVED_LOCS.length) {
      setActiveLocation(SAVED_LOCS[0]);
    } else {
      // Last location removed — reset to the built-in default so the app
      // is never left in a state where activeLocation points at a deleted object.
      const fallback = { ...DEFAULT_LOC };
      SAVED_LOCS.push(fallback);
      saveSavedLocs();
      setActiveLocation(fallback);
    }
  }
  // Animate card out then re-render
  const wrap = document.getElementById('lcw-' + id);
  if (wrap) {
    wrap.style.transition = 'max-height .25s ease, opacity .25s ease';
    wrap.style.maxHeight = wrap.offsetHeight + 'px';
    requestAnimationFrame(() => {
      wrap.style.maxHeight = '0';
      wrap.style.opacity = '0';
      wrap.style.overflow = 'hidden';
      setTimeout(() => renderLocations(), 260);
    });
  } else {
    renderLocations();
  }
}

// Swipe-left to reveal delete button.
// We also block the synthetic click that follows a swipe so the user doesn't
// accidentally switch locations while swiping or while the delete is open.
const _lcTouch = {};
const _lcSwiped = {}; // id → true if the card is currently swiped open
let _lcSuppressClick = false;

function lcTouchStart(e, id) {
  _lcTouch[id] = { x: e.touches[0].clientX, moved: false };
}
function lcTouchMove(e, id) {
  if (!_lcTouch[id]) return;
  const dx = e.touches[0].clientX - _lcTouch[id].x;
  _lcTouch[id].dx = dx;
  _lcTouch[id].moved = Math.abs(dx) > 8;
  const wrap = document.getElementById('lcw-' + id);
  if (!wrap) return;
  if (dx < 0) {
    const offset = Math.max(-72, dx);
    wrap.querySelector('.lcard').style.transform = `translateX(${offset}px)`;
    wrap.querySelector('.lcard').style.transition = 'none';
    e.preventDefault();
  }
}
function lcTouchEnd(e, id) {
  if (!_lcTouch[id]) return;
  const dx = _lcTouch[id].dx || 0;
  const moved = _lcTouch[id].moved;
  const card = document.getElementById('lcw-' + id)?.querySelector('.lcard');
  if (!card) { delete _lcTouch[id]; return; }
  card.style.transition = 'transform .2s ease';
  if (dx < -50) {
    card.style.transform = 'translateX(-72px)'; // reveal delete
    _lcSwiped[id] = true;
  } else {
    card.style.transform = ''; // snap back
    _lcSwiped[id] = false;
  }
  if (moved) {
    // Block the synthetic click that browsers fire after a touch sequence.
    // The FLAG is the mechanism — lcClick() checks it. There used to be an
    // e.preventDefault() here too, but touchend is dispatched from the passive
    // document listener, so it could never take effect; all it did was log
    // "Unable to preventDefault inside passive event listener" on every swipe.
    _lcSuppressClick = true;
    setTimeout(() => { _lcSuppressClick = false; }, TIMINGS.PTR_CLICK_SUPPRESS_MS);
  }
  delete _lcTouch[id];
}

// C6: iOS fires touchcancel (not touchend) when another gesture takes over
// — e.g. the user starts a horizontal swipe and the browser decides it's a
// page scroll, or a notification slides down. Without this handler the
// _lcTouch entry stays in the object until the next touchstart on the same
// card, leaving the card half-swiped on screen.
function lcTouchCancel(e, id) {
  if (!_lcTouch[id]) return;
  const card = document.getElementById('lcw-' + id)?.querySelector('.lcard');
  if (card) {
    card.style.transition = 'transform .2s ease';
    card.style.transform = ''; // snap back to closed
  }
  _lcSwiped[id] = false;
  delete _lcTouch[id];
}

function lcClick(e, id) {
  // Block clicks that arrive right after a swipe, or while delete is open.
  if (_lcSuppressClick || _lcSwiped[id]) {
    e.preventDefault();
    e.stopPropagation();
    // Tap on an already-swiped card snaps it closed instead of switching loc.
    if (_lcSwiped[id]) {
      const card = document.getElementById('lcw-' + id)?.querySelector('.lcard');
      if (card) { card.style.transform = ''; card.style.transition = 'transform .2s ease'; }
      _lcSwiped[id] = false;
    }
    return;
  }
  switchToLocation(id);
}

// Lightweight toast for transient errors — reuses the alert toast UI.
// Lightweight transient toast for UI errors (geolocation denied, push perm
// missing, etc.). Reuses the toast UI from the alerts queue but is explicitly
// NOT stored in notifLog or seenIds — the `err-…` id we generate here only
// exists for the toast queue's de-dupe; it never reaches localStorage. See #35.
// Neutral sibling of flashErrorToast for outcomes that are not failures. The
// error variant carries a red bar and a warning triangle, which is the wrong
// costume for "Copied" — a success wearing an alert's clothes reads as a
// malfunction, and this app's toasts otherwise mean severe weather.
function flashInfoToast(title, msg) {
  queueToast({
    id: 'info-' + Date.now(),
    emoji: '📋', event: title, headline: msg,
    area: '', color: '#0085CA', nwsIconUrl: null,
    time: new Date(), read: true
  });
}

function flashErrorToast(title, msg) {
  const entry = {
    id: 'err-' + Date.now(),
    emoji: '⚠️', event: title, headline: msg,
    area: '', color: '#C8102E', nwsIconUrl: null,
    time: new Date(), read: true
  };
  queueToast(entry); // no notifLog.unshift, no seenIds.add — keep it that way.
}

// (#34) `getCurrentLocation()` was the older GPS entry point bound to a
// `#gps-btn` button that no longer exists in index.html. Removed in favor of
// `useGPS(btn)` below, which is invoked by the search-row pin icon on every
// screen. If you re-add a standalone "Use current location" button, point its
// onclick at `useGPS(this)`.

// ── Global Search Row (all tabs) ─────────────────────────────────────────────

let _gsrTimer = null;
// Bumped on every search kickoff. A response whose generation is stale lost the
// race to a later keystroke and must not overwrite the dropdown — the two-tier
// provider chain below means a slow fallback can land after a fast primary.
let _gsrGen = 0;

function onGlobalSearchFocus(input) {
  document.querySelectorAll('.gsr-drop').forEach(d => {
    if (d !== input.closest('.global-search-row').querySelector('.gsr-drop')) d.style.display = 'none';
  });
}

function onGlobalSearch(input) {
  clearTimeout(_gsrTimer);
  const drop = input.closest('.global-search-row').querySelector('.gsr-drop');
  if (!input.value.trim()) { drop.style.display = 'none'; return; }
  _gsrTimer = setTimeout(() => _runGsrSearch(input.value, drop), TIMINGS.SEARCH_DEBOUNCE_MS);
}

function onGlobalSearchEnter(input) {
  // If the dropdown already shows results, Enter selects the highlighted item
  // (or first if none highlighted). Otherwise run a fresh search.
  const drop = input.closest('.global-search-row').querySelector('.gsr-drop');
  const items = [...drop.querySelectorAll('.gsr-item')];
  if (items.length && drop.style.display !== 'none') {
    const highlighted = drop.querySelector('.gsr-item.kb-active');
    const target = highlighted || items[0];
    target?.click();
    return;
  }
  clearTimeout(_gsrTimer);
  _runGsrSearch(input.value, drop);
}

// Arrow-key navigation in the search dropdown.
function onGlobalSearchKey(input, e) {
  if (e.key === 'Enter') { e.preventDefault(); onGlobalSearchEnter(input); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return;
  const drop = input.closest('.global-search-row').querySelector('.gsr-drop');
  if (e.key === 'Escape') { drop.style.display = 'none'; return; }
  const items = [...drop.querySelectorAll('.gsr-item')];
  if (!items.length) return;
  e.preventDefault();
  let idx = items.findIndex(i => i.classList.contains('kb-active'));
  if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
  else                       idx = idx <= 0 ? items.length - 1 : idx - 1;
  items.forEach(i => i.classList.remove('kb-active'));
  items[idx].classList.add('kb-active');
  items[idx].scrollIntoView({ block: 'nearest' });
}

// ── Geocoding providers ──────────────────────────────────────────────────────
//
// Open-Meteo's geocoding API is the primary provider: no API key, CORS-enabled,
// prefix-matched (so it works as a typeahead), and ranked by population — a
// search for "Springfield" leads with MO/IL/MA instead of whichever OSM node
// happened to sort first. A 5-digit ZIP resolves straight to its city, so one
// endpoint covers both halves of the old ZIP-vs-name split.
//
// Why not Nominatim, which this replaced: the OSMF usage policy lists
// "auto-complete search" under Unacceptable Use — "you must not implement such
// a service on the client side using the API" — and this box searches on every
// keystroke. Photon is the OSM-backed geocoder that *is* built for
// search-as-you-type, so it stays on as the fallback covering what Open-Meteo
// structurally can't: street addresses, and the small unincorporated places
// GeoNames never listed. (Open-Meteo matches GeoNames names literally — no
// fuzzy matching — so a near miss returns nothing at all rather than a guess.
// Neither provider expands abbreviations: "Ft Worth" finds nothing in either,
// and only the spelled-out "Fort Worth" resolves.)
//
// Both providers normalize to { name, sub, lat, lon, zip }.

// NWS forecasts cover the states plus these territories, and both geocoders
// report the territories under their own ISO codes rather than US. So filter on
// the set client-side instead of using Open-Meteo's `countryCode=US`, which
// drops San Juan, PR.
const GEO_COUNTRIES = new Set(['US', 'PR', 'VI', 'GU', 'AS', 'MP']);

// minLon,minLat,maxLon,maxLat. Photon has no country parameter, so this box
// keeps its results roughly in-hemisphere — wide enough to include Alaska,
// Hawaii and Puerto Rico. GEO_COUNTRIES does the actual filtering.
const GEO_US_BBOX = '-180,15,-64,72';

async function _geocodeOpenMeteo(query, isZip) {
  // Over-fetch: the country filter runs client-side, so `count` is the pool to
  // filter from, not the number of rows we show.
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(query)}&count=20&language=en&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
  const j = await r.json();
  return (j.results || [])
    .filter(x => GEO_COUNTRIES.has(x.country_code))
    .slice(0, 6)
    .map(x => ({
      // Territory capitals are often their own admin1 (San Juan, PR), which
      // would otherwise render as "San Juan, San Juan".
      name: x.admin1 && x.admin1 !== x.name ? `${x.name}, ${x.admin1}` : x.name,
      sub: [x.admin2, x.admin1, x.country_code === 'US' ? null : x.country]
        .filter(Boolean).join(', '),
      lat: x.latitude,
      lon: x.longitude,
      // A city carries every ZIP inside it. When the user searched a specific
      // ZIP, keep theirs — postcodes[0] would silently swap 98023 for 98003.
      zip: isZip && (x.postcodes || []).includes(query)
        ? query
        : (x.postcodes || [])[0] || null,
    }));
}

// Photon ranks raw OSM features, so an unrestricted query for "Ft Worth"
// answers with six bus stops named "Ft Worth @ …". Restricting to these layers
// drops that furniture while keeping both halves of what the fallback is for:
// the place layers catch small/unincorporated spots GeoNames omits (Bellvue,
// CO), and street/house keep address search working.
// (Photon rejects the whole request with a 400 on an unknown layer name, and
// `postcode` is not one of them — ZIP lookups are Open-Meteo's job anyway.)
const PHOTON_LAYERS = ['state', 'county', 'city', 'district', 'locality', 'street', 'house'];
// Within a response, prefer the broader place types — searching "Bellvue Colo"
// should lead with the town, not with Bellvue Road.
const PHOTON_LAYER_RANK = Object.fromEntries(PHOTON_LAYERS.map((l, i) => [l, i]));
// Photon files transit furniture under the `house` layer, so the layer filter
// alone still lets "Ft Worth @ Parkcrest - W - NS" through. None of these is
// ever a place someone wants a forecast for.
const PHOTON_DENY = new Set([
  'bus_stop', 'platform', 'crossing', 'traffic_signals', 'turning_circle',
  'street_lamp', 'stop', 'give_way', 'milestone', 'motorway_junction',
]);

async function _geocodePhoton(query) {
  const url = 'https://photon.komoot.io/api/'
    + `?q=${encodeURIComponent(query)}&limit=20&lang=en&bbox=${GEO_US_BBOX}`
    + PHOTON_LAYERS.map(l => `&layer=${l}`).join('');
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Photon HTTP ' + r.status);
  const j = await r.json();
  return (j.features || [])
    .filter(f => GEO_COUNTRIES.has(f.properties?.countrycode)
              && !PHOTON_DENY.has(f.properties.osm_value))
    .sort((a, b) => (PHOTON_LAYER_RANK[a.properties.type] ?? 99)
                  - (PHOTON_LAYER_RANK[b.properties.type] ?? 99))
    .slice(0, 6)
    .map(f => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      // `name` is the feature itself (a street, a school, a bare postcode);
      // `city` is what contains it. Some address hits have no name at all.
      const label = p.name || p.city || p.street || p.county || '';
      return {
        name: p.state && label !== p.state ? `${label}, ${p.state}` : label,
        sub: [p.city !== label ? p.city : null, p.county, p.state]
          .filter(Boolean).join(', '),
        lat, lon,
        zip: /^\d{5}$/.test(p.postcode || '') ? p.postcode : null,
      };
    });
}

// Primary provider, then fallback only if it came back empty. A thrown primary
// also falls through, so an Open-Meteo outage degrades to Photon rather than to
// a broken search box.
async function geoSearch(query) {
  const isZip = /^\d{5}$/.test(query);
  try {
    const results = await _geocodeOpenMeteo(query, isZip);
    if (results.length) return results;
  } catch (e) {
    _warn('geocode:open-meteo', e);
  }
  return _geocodePhoton(query);
}

// itemAction — the data-click-action to attach to each result row.
// Defaults to 'selectGsrResult' (main app search); pass 'obSelectObResult'
// for the onboarding overlay search so results route through the onboarding flow.
async function _runGsrSearch(query, drop, itemAction) {
  const action = itemAction || 'selectGsrResult';
  query = (query || '').trim();
  if (!query) return;
  const myGen = ++_gsrGen;
  drop.style.display = 'block';
  drop.innerHTML = '<div class="gsr-msg"><span class="spin-sm" aria-hidden="true"></span>Searching…</div>';
  try {
    const results = await geoSearch(query);
    if (myGen !== _gsrGen) return; // superseded by a later keystroke
    drop._results = results;
    if (!results.length) { drop.innerHTML = '<div class="gsr-msg">No results found</div>'; return; }
    drop.innerHTML = results.map((r, i) =>
      `<div class="gsr-item" role="option" tabindex="-1" aria-label="${esc(r.name + (r.sub ? ', ' + r.sub : ''))}" data-click-action="${action}" data-idx="${i}">
        <div class="gsr-item-name">${esc(r.name)}</div>
        <div class="gsr-item-sub">${esc(r.sub)}</div>
      </div>`).join('');
  } catch(e) {
    if (myGen !== _gsrGen) return;
    _warn('search', e);
    drop.innerHTML = '<div class="gsr-msg _s-743b28">Search failed. Check your connection.</div>';
  }
}

async function selectGsrResult(itemEl, idx) {
  const drop = itemEl.closest('.gsr-drop');
  const results = drop._results;
  if (!results || !results[idx]) return;
  const r = results[idx];
  drop.style.display = 'none';
  const input = drop.closest('.global-search-row').querySelector('.gsr-input');
  if (input) input.value = '';

  goNav('s-wx', null);
  await openPlace(r);
}

// Make a place the active location, adding it to Locations if it is new. Used
// by search results and by shared links (openAppLink).
async function openPlace({ lat, lon, name, zip }) {
  const id = `loc_${lat.toFixed(3)}_${lon.toFixed(3)}`;

  let loc = SAVED_LOCS.find(l => l.id === id);
  const added = !loc;
  if (!loc) {
    loc = { id, name, lat, lon, zip: zip || null, gradKey: 'default' };
    SAVED_LOCS.push(loc);
    saveSavedLocs();
  }
  const ok = await setActiveLocation(loc);
  // A search result the NWS could not resolve must not stay in Locations as a
  // card with no forecast behind it. Only one this tap just added, and only if
  // it never resolved — a saved city is never removed over a transient failure.
  if (!ok && added && !loc.wfo && loc !== activeLocation) {
    const i = SAVED_LOCS.indexOf(loc);
    if (i >= 0) { SAVED_LOCS.splice(i, 1); saveSavedLocs(); }
  }
  return ok;
}

// Wraps `getCurrentPosition` so native iOS uses the @capacitor/geolocation
// plugin (which talks to CoreLocation and prompts with the app name) instead
// of `navigator.geolocation` (which talks to the WebView and prompts with
// "localhost wants to use your location" because the Capacitor scheme is
// `capacitor://localhost`).
// `opts` overrides the default high-accuracy options. Callers that only need
// to know which NWS zone/gridpoint the device is in (accuracy measured in tens
// of km) should pass COARSE_POS_OPTS — a high-accuracy fix waits on the GPS
// radio for seconds, which is pure latency when the answer gets rounded to a
// forecast zone anyway.
async function _getCurrentPosition(opts) {
  const o = { enableHighAccuracy: true, timeout: 10000, ...(opts || {}) };
  const native = window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform();
  const Geo = window.Capacitor?.Plugins?.Geolocation;
  if (native && Geo && typeof Geo.getCurrentPosition === 'function') {
    // Capacitor plugin returns { coords: { latitude, longitude, ... } }
    // — same shape as the web API, so callers don't need to branch.
    return Geo.getCurrentPosition(o);
  }
  if (!navigator.geolocation) throw new Error('Geolocation not supported');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, o);
  });
}

function useGPS(btn) {
  const origHTML = btn.innerHTML;
  btn.classList.add('locating');
  const restore = () => { btn.classList.remove('locating'); btn.innerHTML = origHTML; };

  _getCurrentPosition().then(async pos => {
    const { lat, lon } = _roundFix(pos.coords);   // SEC-5: rounded once, at the source

    // On the map screen: just fly to the GPS position without switching tabs.
    if (document.querySelector('.screen.active')?.id === 's-map') {
      restore();
      if (typeof lmap !== 'undefined' && lmap) {
        // stop() first: flyTo() on a map already mid-animation (a pan still
        // easing, the fly from a previous tap) is dropped on the floor, which
        // reads as the button doing nothing. Purely a viewport move — no frame
        // reload, the loop keeps playing.
        lmap.stop();
        lmap.flyTo([lat, lon], Math.max(lmap.getZoom(), 9), { duration: 1.2 });
      }
      return;
    }

    // Start with the GPS coords as a fallback label. The post-resolve update
    // below replaces this with the geocoded city/state once we know it.
    const loc = {
      id: 'gps',
      name: 'Current Location',
      subtitle: 'GPS · ' + lat.toFixed(3) + ', ' + lon.toFixed(3),
      lat, lon,
      gradKey: 'gps',
    };
    _gpsLoc = loc;
    const existingGpsIdx = SAVED_LOCS.findIndex(l => l.id === 'gps');
    if (existingGpsIdx < 0) SAVED_LOCS.unshift(loc);
    // Replace the entry outright rather than merging into it. setActiveLocation()
    // only re-resolves the gridpoint when wfo/gx are missing, and the stored
    // 'gps' entry carries the previous fix's wfo/gx/zone/relCity — merging the
    // new coordinate over them would leave the app on the old city's forecast.
    else SAVED_LOCS[existingGpsIdx] = loc;
    restore();
    goNav('s-wx', null);
    // setActiveLocation calls resolveGridpoint which populates relCity/relState.
    await setActiveLocation(loc);
    // Now that we know the human-readable city, promote it to `loc.name` so
    // every UI surface (header, hero, locations list, hourly tab, etc.) shows
    // "Norman, OK" instead of "Current Location".
    if (loc.relCity && loc.relState) {
      loc.name = `${loc.relCity}, ${loc.relState}`;
      // Re-render so the new name shows immediately.
      updateLocationHeader();
      if (wxData.forecast.length) renderWx();
    }
  }).catch(err => {
    restore();
    _warn('useGPS', err);
    // Distinguish denied vs. timeout vs. unsupported when possible.
    const msg = err?.code === 1 || /denied|permission/i.test(err?.message || '')
      ? 'Location permission denied. Enable in Settings → Privacy → Location.'
      : err?.code === 3 || /timeout/i.test(err?.message || '')
      ? 'Location request timed out. Try again.'
      : 'Couldn\'t get your location. Enable Location Services in Settings.';
    flashErrorToast('Location', msg);
  });
}

// Close dropdowns when tapping outside the search area (both main app and
// onboarding overlay search).
document.addEventListener('click', e => {
  if (!e.target.closest('.global-search-row') && !e.target.closest('#ob-search-row')) {
    document.querySelectorAll('.gsr-drop').forEach(d => d.style.display = 'none');
    const obDrop = document.getElementById('ob-search-drop');
    if (obDrop) obDrop.style.display = 'none';
  }
});

// ── Pull-to-refresh — one implementation, used by all six screens ───────────
// This used to be two: this helper for the five scroller-backed tabs, and a
// near-identical copy in map.js (_mapPullStart/_mapPullMove/_mapPullEnd) for
// the Map screen. Same thresholds, same rubber-band factor, same timings — and
// they had already drifted, because only this copy read TIMINGS, so changing
// TIMINGS.PTR_HOLD_MS silently applied to five screens and not the sixth.
//
// Only two things actually differed between them, and both are now parameters:
//
//   • WHERE the gesture is bound. Five tabs hang it on their scroller; the Map
//     has no scrollable list, so it binds to the whole #s-map screen.
//   • WHEN a pull may begin. A scroller only pulls when it is already at the
//     top (otherwise the gesture is an ordinary scroll); the Map instead has to
//     exclude touches that start on the Leaflet canvas or its controls, which
//     own their own drag gestures — see _pullAllowed() in map.js.
//
// The indicator is a parameter too, because the Map's is static markup in
// index.html (#map-pull) while the other five are generated on first bind.
const PTR_THRESHOLD   = 70;    // px of pull before release-to-refresh arms
const PTR_MAX         = 110;   // visual ceiling on the indicator height
const PTR_RUBBER_BAND = 0.55;  // drag-to-indicator ratio, so it eases rather than tracking 1:1
const PTR_SPINNER_H   = 34;    // indicator height while the refresh runs

function addPullToRefresh({ target, indicator, canPull, onRefresh }) {
  if (!target || !indicator) return;
  if (target._ptrBound) return;   // idempotent: boot() may run this more than once
  target._ptrBound = true;

  const allow = typeof canPull === 'function' ? canPull : () => true;
  const setTxt = t => { const el = indicator.querySelector('.map-pull-txt'); if (el) el.textContent = t; };

  let pull = null;         // { startY, height } while a pull is in progress
  let refreshing = false;

  target.addEventListener('touchstart', e => {
    if (refreshing || !allow(e)) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    pull = { startY: t.clientY, height: 0 };
    indicator.classList.remove('snap', 'ready', 'refreshing');
  }, { passive: true });

  target.addEventListener('touchmove', e => {
    if (!pull) return;
    // Re-checked mid-gesture, not just at touchstart: on a scroller the list can
    // move under the finger, and once it is no longer at the top this is a
    // scroll, not a pull. (For the Map the predicate is positional and cannot
    // change mid-drag, so this is a no-op there.)
    if (!allow(e)) { pull = null; indicator.style.height = '0px'; return; }
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dy = t.clientY - pull.startY;
    if (dy <= 0) {
      pull.height = 0;
      indicator.style.height = '0px';
      indicator.classList.remove('ready');
      return;
    }
    const h = Math.min(PTR_MAX, Math.round(dy * PTR_RUBBER_BAND));
    pull.height = h;
    indicator.style.height = h + 'px';
    indicator.classList.toggle('ready', h >= PTR_THRESHOLD);
    setTxt(h >= PTR_THRESHOLD ? 'Release to refresh' : 'Pull to refresh');
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  const finish = () => {
    if (!pull) return;
    const triggered = pull.height >= PTR_THRESHOLD;
    pull = null;
    indicator.classList.add('snap');
    if (triggered) {
      indicator.classList.remove('ready');
      indicator.classList.add('refreshing');
      setTxt('Refreshing…');
      indicator.style.height = PTR_SPINNER_H + 'px';
      refreshing = true;
      try { Promise.resolve(onRefresh()).catch(() => {}); } catch (e) { _warn('pullRefresh', e); }
      // Hold the indicator briefly so an instantly-cached fetch is still
      // visually acknowledged, then collapse. (D4)
      setTimeout(() => {
        indicator.style.height = '0px';
        setTimeout(() => {
          indicator.classList.remove('refreshing', 'snap');
          refreshing = false;
        }, TIMINGS.PTR_COLLAPSE_MS);
      }, TIMINGS.PTR_HOLD_MS);
    } else {
      indicator.style.height = '0px';
      setTimeout(() => indicator.classList.remove('snap'), TIMINGS.PTR_COLLAPSE_MS);
    }
  };
  target.addEventListener('touchend',    finish, { passive: true });
  target.addEventListener('touchcancel', finish, { passive: true });
}

// The indicator for a scroller-backed screen, created on first bind.
//
// It goes in as the scroller's PREVIOUS SIBLING so its growing height pushes
// the scroller down (the standard iOS feel) without being clobbered by the
// inner renderHourly()/renderAlerts() innerHTML resets.
function _ptrIndicator(screen, screenId, scroller) {
  const existing = screen.querySelector(`.map-pull[data-ptr-for="${screenId}"]`);
  if (existing) return existing;
  const indicator = document.createElement('div');
  indicator.className = 'map-pull';
  indicator.dataset.ptrFor = screenId;
  indicator.innerHTML = '<span class="map-pull-ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></span><span class="map-pull-txt">Pull to refresh</span>';
  // On most tabs the header sits outside the scroller, so inserting the
  // indicator before the scroller places it just under the header. On
  // #s-wx the header is the scroller's first child (.hz wraps the whole
  // screen) — insert after it there, or the indicator renders above the
  // header, under the status bar.
  const innerHdr = scroller.querySelector(':scope > .noaa-hdr');
  if (innerHdr) innerHdr.insertAdjacentElement('afterend', indicator);
  else scroller.parentNode.insertBefore(indicator, scroller);
  return indicator;
}

// Convenience wrapper for the five scroller-backed tabs.
function addScrollerPullToRefresh(screenId, scrollerSelector, onRefresh) {
  const screen = document.getElementById(screenId);
  if (!screen) return;
  const scroller = screen.querySelector(scrollerSelector);
  if (!scroller) return;
  addPullToRefresh({
    target: scroller,
    indicator: _ptrIndicator(screen, screenId, scroller),
    canPull: () => scroller.scrollTop <= 0,
    onRefresh,
  });
}

// Wire pull-to-refresh on the five scroller-backed tabs. The Map screen binds
// the same gesture through the same helper from map.js, where _pullAllowed()
// lives — see bindMapPullGestures().
function bindPullToRefresh() {
  addScrollerPullToRefresh('s-wx', '.hz', () => {
    // Drop the observation cache first: fetchCurrentObs is TTL-gated now, so
    // without this a pull would repaint the cached reading instead of fetching
    // a new one — and a deliberate pull is exactly when the user wants fresh.
    invalidateObsCache();
    fetchWx();
    fetchAlerts();
    // fetchCurrentObs + fetchUVIndex + fetchAFD are re-triggered by renderWx()
    // which runs at the tail of fetchWx().
  });
  addScrollerPullToRefresh('s-hourly',   '#hourly-body', () => { invalidateGridpointCache(); fetchWx(); });
  addScrollerPullToRefresh('s-forecast', '.scroller', () => {
    // Refresh all three sections of the Details screen. Both renderers
    // short-circuit when their computed HTML is unchanged (the #18 render-skip),
    // so pull-to-refresh clears each cache to force the fetches to re-run.
    const mb = document.getElementById('marine-body');     if (mb) mb._lastHtml = null;
    const cb = document.getElementById('conditions-body'); if (cb) cb._lastHtml = null;
    // Detailed Conditions read the shared gridpoint cache (30 min); a pull
    // means "now", so drop it — otherwise pulling refreshed nothing below the
    // forecast until the cache happened to expire.
    invalidateGridpointCache();
    fetchWx().then(renderExtendedForecast);
    renderConditions();
    renderMarine();
  });
  addScrollerPullToRefresh('s-alerts',   '.scroller', () => fetchAlerts());
  addScrollerPullToRefresh('s-loc',      '.scroller', () => {
    // Drop cached summaries so renderLocations re-fetches each one.
    // B4: also drop _at so the TTL check doesn't treat the cleared cards as
    // "fresh enough" while the refetch is in flight.
    SAVED_LOCS.forEach(l => { delete l._cond; delete l._temp; delete l._icon; delete l._at; });
    renderLocations();
  });
}

// Refresh weather + alerts when the user returns to the tab after a while.
// Measure time-spent-hidden rather than time-since-last-visible-event so the
// 60s threshold compares against the user's actual away duration (issue #15).
// Also pause/resume the live-chip clock so it doesn't fire needlessly while
// the app is backgrounded and fires immediately on return so the freshness
// state is accurate the moment the user sees the screen again.
let _lastHiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    _lastHiddenAt = Date.now();
    clearInterval(_clockHandle); _clockHandle = null;
    return;
  }
  if (document.visibilityState !== 'visible' || _lastHiddenAt == null) return;
  const hiddenFor = Date.now() - _lastHiddenAt;
  _lastHiddenAt = null;
  // Before the refetch below, so the renderWx() it triggers sees the new count
  // when it calls maybeAskForReview().
  if (hiddenFor >= SESSION_RESUME_GAP_MS) noteAppSession();
  // Fire immediately so the chip reflects stale state the moment the user returns
  tickClock();
  _clockHandle = setInterval(tickClock, TIMINGS.CLOCK_TICK_MS);
  if (hiddenFor > TIMINGS.RETURN_REFRESH_MS && wxData.forecast.length) {
    fetchWx();
    fetchAlerts();
    if (typeof refreshStormCenterIfOpen === 'function') refreshStormCenterIfOpen();
    // Where the phone actually is reaches the push relay and the widget only
    // through these two calls, and they used to run only at cold launch (push:
    // via registration; widget: from boot). iOS keeps the app alive for days, so
    // someone who travelled without force-quitting kept getting alerts for — and
    // a "Current Location" widget showing — where they had been. Both are cheap
    // when nothing moved: the GPS fix is cached for 20 minutes and
    // syncLocation() skips the POST when its key is unchanged.
    if (window.pushNative) window.pushNative.syncLocation();
    _syncWidgetGPS(false);
  }
  // The most common path back from "Open Settings" is flipping the
  // notification toggle then switching straight back to the app. Re-read the
  // OS permission (native) / re-check Notification.permission (web) and
  // re-render so a newly granted permission reflects instantly instead of
  // looking stuck on "blocked" until something else triggers a re-render.
  if (window.pushNative?.refreshState) window.pushNative.refreshState();
  if (document.getElementById('s-settings')?.classList.contains('active')
      && typeof renderPermBanner === 'function') {
    renderPermBanner();
  }
});
