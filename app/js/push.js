// Native push registration — bridges @capacitor/push-notifications to the
// noaa-alert-relay Cloudflare Worker. No-op on web (the existing browser
// Notification path in notifications.js handles that case).
//
// APNs environment (sandbox vs production) is detected at runtime by the
// NOAAEnv Capacitor plugin reading the embedded provisioning profile, so the
// is_sandbox flag is always correct regardless of build configuration.

const RELAY_URL = 'https://noaa-alert-relay.nelsok.workers.dev';
const TOKEN_KEY = 'pushDeviceToken';
const REG_STATE_KEY = 'pushRegState';   // 'unknown' | 'denied' | 'granted'
const SECRET_KEY = 'pushInstallSecret'; // fallback storage only — see _installSecret()
// Set when the user turns alerts off with the in-app toggle, cleared when they
// turn it back on. Distinct from REG_STATE_KEY, which records what the *OS*
// says: the two are independent, and conflating them is what let a deliberate
// opt-out be undone automatically (see refreshState).
const OPT_OUT_KEY = 'pushUserOptOut';

let _token = null;
let _regState = 'unknown';
let _optedOut = false;                  // user turned alerts off in-app
let _secret = null;                     // per-install secret proving we own our relay row
// Key includes token + coords + APNs env + severity so any of these changing
// triggers a fresh POST to the relay (previously severity changes were silent).
let _lastSyncedKey = null;              // `${token}:${lat}:${lon}:${env}:${sev}` of the last successful POST
let _pluginReady = false;
let _apnsEnv = null;                    // 'development' | 'production' (set during init)

function _isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function _plugin() {
  // The plugin attaches to Capacitor.Plugins.PushNotifications when the iOS
  // bridge loads. If the user has run `npx cap sync ios` after `npm install`,
  // it'll be there.
  return window.Capacitor?.Plugins?.PushNotifications || null;
}

// Per-install secret sent with every /register write. The relay stores only its
// SHA-256 and, once a row has one, rejects any register/unregister that can't
// present it — so knowing a device's APNs token is no longer enough to delete
// that device's subscription or re-point it (e.g. flipping is_sandbox, which
// would leave the app reporting "notifications enabled" while every push
// silently died in Apple's sandbox).
//
// Preferred storage is the native App Group via NOAAEnv.getInstallSecret: iOS
// can evict WKWebView localStorage under storage pressure *without* changing
// the APNs token, and a secret that outlives its token's storage would lock the
// device out of its own row. localStorage is only the fallback for the web
// build and for native builds predating the plugin method — the relay treats a
// row with no secret as unclaimed, so those keep working and claim the row as
// soon as they can produce one.
async function _installSecret() {
  if (_secret) return _secret;

  const env = window.Capacitor?.Plugins?.NOAAEnv;
  if (env && typeof env.getInstallSecret === 'function') {
    try {
      const r = await env.getInstallSecret();
      if (r?.secret && r.secret.length >= 16) {
        _secret = r.secret;
        return _secret;
      }
    } catch (e) {
      console.warn('[push] getInstallSecret failed, falling back to localStorage', e);
    }
  }

  try {
    const stored = localStorage.getItem(SECRET_KEY);
    if (stored && stored.length >= 16) { _secret = stored; return _secret; }
  } catch (_) {}

  _secret = _randomSecret();
  try { localStorage.setItem(SECRET_KEY, _secret); } catch (_) {}
  return _secret;
}

function _randomSecret() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const b = new Uint8Array(32);
  window.crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function _detectApnsEnv() {
  const env = window.Capacitor?.Plugins?.NOAAEnv;
  if (!env || typeof env.getApnsEnvironment !== 'function') return 'production';
  try {
    const r = await env.getApnsEnvironment();
    return r?.env === 'development' ? 'development' : 'production';
  } catch (_) {
    return 'production';
  }
}

// init() runs from boot() and again when first-run onboarding completes. Each
// run added another 'registration' listener, so every token hand-off fired
// syncLocation() twice. Once is enough.
let _initStarted = false;

async function init() {
  if (!_isNative() || _initStarted) return;
  _initStarted = true;
  const p = _plugin();
  if (!p) {
    console.warn('[push] PushNotifications plugin missing — run `npx cap sync ios`');
    return;
  }
  _pluginReady = true;
  _apnsEnv = await _detectApnsEnv();

  try { _token = localStorage.getItem(TOKEN_KEY); } catch (_) {}
  try { _regState = localStorage.getItem(REG_STATE_KEY) || 'unknown'; } catch (_) {}
  try { _optedOut = localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (_) {}

  p.addListener('registration', async (info) => {
    _token = info?.value || null;
    if (!_token) return;
    try { localStorage.setItem(TOKEN_KEY, _token); } catch (_) {}
    _regState = 'granted';
    try { localStorage.setItem(REG_STATE_KEY, _regState); } catch (_) {}
    _renderBanner();
    await syncLocation();
  });

  p.addListener('registrationError', (err) => {
    console.warn('[push] registrationError', err);
  });

  // If we already have a stored 'granted' state from a prior launch, re-register
  // silently so the OS hands us a fresh token (tokens can rotate on restore).
  if (_regState === 'granted') {
    try { await p.register(); } catch (e) { console.warn('[push] silent re-register failed', e); }
  }
}

async function requestPermission() {
  // Reaching here means the user asked for alerts — via the in-app toggle or
  // the permission banner — so any earlier opt-out is over. Cleared even if the
  // OS prompt is then declined: the in-app intent is "on", and if the OS grant
  // arrives later refreshState should be free to register.
  _optedOut = false;
  try { localStorage.removeItem(OPT_OUT_KEY); } catch (_) {}

  if (!_isNative() || !_pluginReady) return false;
  const p = _plugin();
  if (!p) return false;
  try {
    const perm = await p.requestPermissions();
    if (perm.receive === 'granted') {
      _regState = 'granted';
      try { localStorage.setItem(REG_STATE_KEY, _regState); } catch (_) {}
      await p.register();
      return true;
    } else {
      _regState = 'denied';
      try { localStorage.setItem(REG_STATE_KEY, _regState); } catch (_) {}
      _renderBanner();
      return false;
    }
  } catch (e) {
    console.warn('[push] requestPermission failed', e);
    return false;
  }
}

// Map the user's minSev setting to the comma-separated severity list the relay
// expects.  NWS watches, warnings, advisories, and statements are always pushed
// by the relay regardless of this filter — the filter controls other event
// types (Air Quality Alerts, Special Statements, Outlooks, etc.).
function _severityFilter() {
  // Fallback matches the app-wide default minSev ('Moderate' — see app.js).
  const sev = (typeof minSev !== 'undefined' ? minSev : null) || 'Moderate';
  const map = {
    Minor:    'minor,moderate,severe,extreme',
    Moderate: 'moderate,severe,extreme',
    Severe:   'severe,extreme',
    Extreme:  'extreme',
  };
  return map[sev] || map.Moderate;
}

// Quiet-hours settings, read straight from the Settings controls (the same
// source isQuiet() uses, so the two can't disagree).
//
// These have to reach the relay because quiet hours previously did nothing on
// iOS: isQuiet() only gated in-app toasts and firePush(), and firePush() is a
// no-op on native — so the background pushes that can actually wake someone
// ignored the setting entirely. The relay evaluates the window itself, which
// needs the device's IANA timezone: 10 PM is a wall-clock time where the *user*
// is, not where the watched coordinates are.
function _quietSettings() {
  const el = id => document.getElementById(id);
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) {}
  return {
    quiet_enabled:  el('quiet-tog')?.checked ?? false,
    quiet_from:     +(el('q-from')?.value ?? 22),
    quiet_to:       +(el('q-to')?.value ?? 7),
    // Matches the checked-by-default "Override for Warnings" toggle.
    quiet_override: el('override-tog')?.checked ?? true,
    timezone:       tz,
  };
}

// Morning-briefing settings. Like quiet hours these have to reach the relay,
// and for the same underlying reason: the in-app path can't deliver a
// notification on native. fireBriefingNotif() skips its notification branch
// when _isNativePlatform(), and the timer driving it lives in the WebView,
// which iOS suspends in the background — so the briefing only ever appended a
// row to the in-app list, and only if the app happened to be open at the time.
//
// The gridpoint (wfo/gx/gy) goes with it so the relay can fetch a forecast in
// one request instead of resolving /points/{lat},{lon} first, and units so the
// pushed text matches what the user sees in-app.
function _briefingSettings(loc) {
  const el = id => document.getElementById(id);
  const s = {
    briefing_enabled: el('briefing-tog')?.checked ?? false,
    briefing_hour:    +(el('briefing-time')?.value ?? 7),
    unit_temp:        typeof uTemp !== 'undefined' ? uTemp : 'F',
    unit_wind:        typeof uWind !== 'undefined' ? uWind : 'mph',
  };
  if (loc && typeof loc.gx === 'number' && typeof loc.gy === 'number') {
    s.gx = loc.gx;
    s.gy = loc.gy;
  }
  // What to call this place in the pushed briefing. The relay knows where the
  // subscriber is (lat/lon, zone, wfo/grid) but not what that place is named,
  // so without this the Day Ahead push read "High 89°, Low 82° · Partly Cloudy"
  // with nothing saying which location it was for — while the in-app copy in
  // fireBriefingNotif() has always been prefixed with it. Same source of truth
  // here (briefingPlaceName, so the state is abbreviated in both), so the two
  // read identically.
  const nm = loc && typeof briefingPlaceName === 'function' ? briefingPlaceName(loc) : loc?.name;
  if (nm) s.loc_name = String(nm);
  return s;
}

async function syncLocation() {
  if (!_isNative() || !_token) return;
  const loc = typeof activeLocation !== 'undefined' ? activeLocation : null;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return;

  if (!_apnsEnv) _apnsEnv = await _detectApnsEnv();
  const isSandbox = _apnsEnv === 'development';
  const sevFilter = _severityFilter();

  // The device's actual GPS location, independent of whichever location the
  // app has selected/active — so background push fires for both at once
  // (e.g. traveling with a saved "home" location still active). Never
  // prompts for permission; only used if it's already granted elsewhere
  // (see _resolveGPSZone in app.js). Best-effort — a relay that only got the
  // selected-location fields still works exactly as before.
  const gpsLoc = typeof _resolveGPSZone === 'function' ? await _resolveGPSZone(false).catch(() => null) : null;

  const quiet = _quietSettings();
  const briefing = _briefingSettings(loc);

  // Include severity, the GPS zone, and the quiet-hours settings in the key so
  // changing any of them always triggers a re-sync, even if the selected
  // location's token/coordinates haven't moved. Without the quiet fields here,
  // toggling quiet hours would be a no-op until something else happened to
  // change the key.
  const key = [
    _token,
    loc.lat.toFixed(4), loc.lon.toFixed(4),
    isSandbox ? 's' : 'p',
    sevFilter,
    // County codes belong in the key too: they're resolved asynchronously by
    // resolveGridpoint(), so on the sync that runs before that lands they're
    // empty. Without them here, that first key would match forever and the
    // county would never reach the relay.
    loc.county || '',
    gpsLoc?.zone || '',
    gpsLoc?.county || '',
    quiet.quiet_enabled ? `${quiet.quiet_from}-${quiet.quiet_to}` : 'off',
    quiet.quiet_override ? 'ovr' : 'noovr',
    quiet.timezone || '',
    briefing.briefing_enabled ? `b${briefing.briefing_hour}` : 'boff',
    `${briefing.unit_temp}${briefing.unit_wind}`,
    // In the key as well: a GPS location's name resolves asynchronously
    // ("Current Location" first, then "Miami, FL"), and renaming a saved
    // location moves nothing else here. Without this the relay would keep
    // pushing the placeholder name indefinitely.
    briefing.loc_name || '',
  ].join(':');
  if (key === _lastSyncedKey) return;

  // Include the NWS zone and WFO office if already resolved — the relay can
  // use these to poll the zone-based alerts endpoint directly instead of
  // reverse-geocoding the coordinates on every check.
  const body = {
    token: _token,
    secret: await _installSecret(),
    lat: loc.lat,
    lon: loc.lon,
    severity_filter: sevFilter,
    is_sandbox: isSandbox,
    ...quiet,
    ...briefing,
  };
  if (loc.zone) body.zone = loc.zone;         // e.g. "WAZ316"
  if (loc.wfo)  body.wfo  = loc.wfo;          // e.g. "SEW"
  // County UGC as well as the forecast zone — the relay needs both, because
  // which UGC type a null-geometry product is filed against is a property of
  // the product and of the issuing office, not of the subscriber. Measured
  // across 29 simultaneously-active Air Quality Alerts: 88 county UGCs
  // ("WAC033", "COC059") and 39 forecast-zone UGCs (Wyoming files its as
  // WYZ###). The relay matched `zone` alone, so the county-filed majority
  // found no subscriber and never pushed, while the zone-filed ones delivered
  // — which is why this looked intermittent rather than broken.
  //
  // The in-app Alerts screen was never affected: it uses a `?point=` query,
  // which resolves both UGC types server-side.
  if (loc.county) body.county = loc.county;   // e.g. "WAC033"
  if (gpsLoc) {
    body.gps_lat = gpsLoc.lat;
    body.gps_lon = gpsLoc.lon;
    body.gps_zone = gpsLoc.zone;
    if (gpsLoc.county) body.gps_county = gpsLoc.county;
  }

  try {
    const resp = await fetch(`${RELAY_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      // 403 means the relay holds a different secret for this token — i.e. this
      // install's secret was lost while APNs kept handing back the same token.
      // Nothing the app can do unilaterally (unregister needs the same proof),
      // so surface it loudly rather than retrying into the same wall: the row
      // stays at its last-known location and keeps delivering alerts for there.
      if (resp.status === 403) {
        console.error('[push] /register rejected — install secret does not match the relay record for this device token');
      } else {
        console.warn('[push] /register returned', resp.status);
      }
      return;
    }
    _lastSyncedKey = key;
  } catch (e) {
    console.warn('[push] /register fetch failed', e);
  }
}

// `userOptOut` records intent, not mechanism. Called with true when the user
// turns the in-app alerts toggle off, and false when the subscription is being
// dropped for some other reason (the OS revoked permission). refreshState()
// re-registers automatically in the second case and must not in the first.
async function unregister(userOptOut = false) {
  if (userOptOut) {
    _optedOut = true;
    try { localStorage.setItem(OPT_OUT_KEY, '1'); } catch (_) {}
  }
  if (!_isNative() || !_token) return;
  try {
    await fetch(`${RELAY_URL}/register`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: _token, secret: await _installSecret() }),
    });
  } catch (_) {}
  _token = null;
  _regState = 'unknown';
  _lastSyncedKey = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  try { localStorage.removeItem(REG_STATE_KEY); } catch (_) {}
  _renderBanner();
}

function getState() {
  return { native: _isNative(), pluginReady: _pluginReady, regState: _regState, hasToken: !!_token, apnsEnv: _apnsEnv };
}

// Re-reads the OS-level permission directly (bypassing our cached _regState).
// The cache only updates on requestPermission()/registration events — if the
// user flips the toggle in iOS Settings and switches straight back to the app,
// nothing fires either of those, so the banner would stay stuck on "blocked"
// until something else happened to re-register. Called on app foreground.
async function refreshState() {
  if (!_isNative() || !_pluginReady) return;
  const p = _plugin();
  if (!p || typeof p.checkPermissions !== 'function') return;
  try {
    const perm = await p.checkPermissions();
    const next = perm.receive === 'granted' ? 'granted'
               : perm.receive === 'denied'  ? 'denied'
               : 'unknown';
    if (next === _regState) return;
    _regState = next;
    try { localStorage.setItem(REG_STATE_KEY, _regState); } catch (_) {}
    if (next === 'granted' && !_token && !_optedOut) {
      // Only auto-register when the OS grant is the thing that was missing. If
      // the user switched alerts off in-app, this branch is exactly how that
      // used to be undone: the toggle called unregister(), which cleared the
      // token and left the cached state 'unknown', so the next foreground saw
      // "OS says granted, we have no token" and silently registered again —
      // resuming the background pushes the toggle had just stopped.
      try { await p.register(); } catch (_) {}
    } else if (next === 'denied' && _token) {
      // Permission was revoked in iOS Settings while we still hold a token.
      //
      // Tell the relay, because it cannot find this out for itself. Revoking
      // permission does not invalidate the device token — iOS just discards
      // what arrives — so APNs answers 200 to every push and never returns the
      // 410 that would let the relay drop the row. Left alone, that device is
      // matched on every alert dispatch and pushed to forever, for a phone that
      // shows nothing.
      //
      // Re-granting is handled by the branch above: refreshState sees 'granted'
      // with no token and registers again.
      await unregister();
      // unregister() clears the cached state, but the OS permission really is
      // denied and the banner needs to keep saying so.
      _regState = 'denied';
      try { localStorage.setItem(REG_STATE_KEY, _regState); } catch (_) {}
    }
    _renderBanner();
  } catch (_) {}
}

window.pushNative = { init, requestPermission, syncLocation, unregister, getState, refreshState };

function _renderBanner() {
  if (typeof renderPermBanner === 'function') {
    try { renderPermBanner(); } catch (_) {}
  }
}
