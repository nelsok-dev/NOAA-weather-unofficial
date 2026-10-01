// Alerts module — api.weather.gov/alerts, matched by point (see fetchAlerts).
// Auto-retry: transient fetch failures (Wi-Fi drops, NWS rate-limit blips) are
// retried up to 3 times with exponential backoff (1.5s, 3s, 6s) before showing
// the manual retry UI.
let _alertsRetryHandle = null;

// Called from setActiveLocation (#11) so a retry queued against the previous
// zone doesn't fire after the user switches locations.
function _cancelAlertsRetry() {
  if (_alertsRetryHandle) { clearTimeout(_alertsRetryHandle); _alertsRetryHandle = null; }
}

// Push a settled alert list into the UI. Split out of fetchAlerts so the
// primary (selected-location) list and the later GPS merge can each paint
// through the same path. Safe to call twice in a row: processIncoming()
// de-dupes on seenIds, and renderAlerts() skips the DOM write when the card
// HTML is unchanged.
function _applyAlerts(list) {
  processIncoming(list);
  wxData.alerts = list;
  renderAlerts();
  syncNavDots();
  if (mapAlertsOn && lmap) drawMapAlerts();
  if (wxData.forecast.length) renderWx();
}

// Second pass: alerts for the device's actual GPS position, merged in once the
// GPS fix resolves. Deliberately NOT awaited by fetchAlerts — see the comment
// at the gpsPromise kickoff for why this can't sit on the critical path.
async function _mergeGPSAlerts(gpsPromise, fresh, myGen, zoneAtStart) {
  try {
    const gpsLoc = await gpsPromise;
    if (!gpsLoc || !gpsLoc.zone || gpsLoc.zone === zoneAtStart) return;
    if (gpsLoc.lat == null || gpsLoc.lon == null) return;
    if (_locGen !== myGen) return; // user switched while GPS was resolving
    // Point query here too, for the same reason as the primary fetch.
    const gr = await nwsFetch(`https://api.weather.gov/alerts/active?point=${gpsLoc.lat},${gpsLoc.lon}`);
    if (!gr.ok || _locGen !== myGen) return;
    const gd = await gr.json();
    if (_locGen !== myGen) return;
    const existingIds = new Set(fresh.map(f => f.properties?.id || f.id));
    const gpsOnly = (gd.features || [])
      .filter(f => !existingIds.has(f.properties?.id || f.id))
      .map(f => ({ ...f, _gpsOrigin: true }));
    if (!gpsOnly.length) return; // nothing new — leave the painted list alone
    const merged = [...fresh, ...gpsOnly]
      .sort((a, b) => new Date(b.properties?.sent || 0) - new Date(a.properties?.sent || 0));
    _applyAlerts(dedupeAlertFeatures(merged));
  } catch (_) {} // GPS side is best-effort — never fails the primary fetch
}

async function fetchAlerts(attempt = 0) {
  _cancelAlertsRetry();
  // #12: capture the location generation. If it changes while we're awaiting,
  // the user has switched and we must not mutate UI for the previous zone.
  const myGen = _locGen;
  const zoneAtStart = activeLocation.zone;
  try {
    // Kick the GPS resolve off in PARALLEL with the primary fetch, and merge
    // its results in afterwards (_mergeGPSAlerts). This used to be awaited
    // between the primary fetch and the first render, which put a cold GPS fix
    // — seconds on iOS — directly on the critical path: the Alerts screen sat
    // on its spinner for ~8s to display data that takes ~300ms of network to
    // fetch. Nothing in the primary list depends on the GPS side, so it must
    // not block the paint.
    const gpsPromise = typeof _resolveGPSZone === 'function'
      ? Promise.resolve(_resolveGPSZone(false)).catch(() => null)
      : Promise.resolve(null);
    // Query by POINT, not by forecast zone. Convective warnings — tornado,
    // severe thunderstorm, flash flood, the only ones that carry severe-weather
    // tags — are issued against COUNTY zones (NEC025) with a polygon, while
    // activeLocation.zone is the FORECAST zone (NEZ067). A zone query therefore
    // returned zero of them: a severe thunderstorm warning covering the user's
    // town never appeared on the Alerts screen, even though the push relay
    // (which does its own point-in-polygon) had already sent a banner for it.
    //
    // `?point=` is a strict superset of the old query — verified live: it
    // matches polygon alerts by point-in-polygon AND still returns zone-based
    // alerts with null geometry (heat, air quality) via the zones containing
    // the point. activeLocation.zone stays untouched; push registration and the
    // GPS-origin comparison below still key off it.
    const r = await nwsFetch(`https://api.weather.gov/alerts/active?point=${activeLocation.lat},${activeLocation.lon}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (_locGen !== myGen) return; // user switched mid-flight
    const fresh = d.features || [];

    // Collapse re-transmissions before anything consumes the list: NWS keeps
    // every earlier copy of a re-issued advisory in /alerts/active (NWS Boise
    // relayed one smoke advisory five times), so without this the screen listed
    // the same alert five times, the nav badge counted five, and the Weather
    // hero banner could headline a superseded copy. See
    // groupAlertTransmissions() in app.js for why the key is VTEC.
    _applyAlerts(dedupeAlertFeatures(fresh));

    // Also surface alerts for the device's actual GPS location — e.g.
    // traveling with a saved "home" location still active in the app. Only
    // fires if location permission is already granted (never prompts) and the
    // GPS zone differs from the selected one. Runs after the paint above, so
    // a slow fix delays only the "NEAR YOU" cards, never the user's own list.
    _mergeGPSAlerts(gpsPromise, fresh, myGen, zoneAtStart);
  } catch (e) {
    if (_locGen !== myGen) return; // stale failure, ignore
    if (attempt < 3) {
      const delay = TIMINGS.ALERTS_RETRY_BASE_MS * Math.pow(2, attempt);
      _alertsRetryHandle = setTimeout(() => {
        // N30: clear the handle on fire so a later _cancelAlertsRetry()
        // can't be tricked by a stale id, and gate on the zone as well as
        // _locGen — belt-and-suspenders if any future code path bumps the
        // generation counter without going through setActiveLocation.
        _alertsRetryHandle = null;
        if (_locGen === myGen && activeLocation.zone === zoneAtStart) {
          fetchAlerts(attempt + 1);
        }
      }, delay);
      // Don't tear down the existing alerts body during transient retries —
      // only show the failure state once retries are exhausted.
      return;
    }
    const alertsBody = document.getElementById('alerts-body');
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const msg = offline ? 'You’re offline. Alerts will refresh when you reconnect.' : 'Could not load alerts';
    if (alertsBody) alertsBody.innerHTML = `<div class="ldg"><div>${msg}</div><button class="retry-btn" data-click-action="fetchAlerts">Retry</button></div>`;
  }
}

// ── Opening a map alert on the Alerts screen ─────────────────────────────────
// The map shows every active alert in the country, while this screen shows the
// ones for the user's saved location — so an alert tapped on the map often
// isn't in the list. Rather than refuse the link for those (which would make it
// appear and vanish depending on where you tapped), the alert is pinned to the
// top of the screen with a badge saying where it came from.
//
// Pins live in a module variable, not in wxData.alerts, so the next alerts poll
// can't wipe the card mid-read and the nav badge keeps counting only the alerts
// that actually apply to the user. goNav() drops them on leaving the screen.
let _pinnedMapAlerts = [];

function clearPinnedMapAlerts() {
  if (!_pinnedMapAlerts.length) return;
  _pinnedMapAlerts = [];
}

// `props` is the NWS alert `properties` object from the map popup.
// `areaLead` is the index of the location that was tapped on the map, carried
// over so the pinned card leads with the same place the popup did.
function openAlertInAlertsTab(id, props, areaLead) {
  const inList = (wxData.alerts || []).some(a => alertFeatureId(a) === id);
  _pinnedMapAlerts = inList || !props
    ? []
    : [{ id, properties: props, _fromMap: true, _areaLead: areaLead >= 0 ? areaLead : null }];
  if (id) _openAlertCards.add(id); // land on the screen with the alert already open
  if (typeof closeMapPopup === 'function') closeMapPopup();
  goNav('s-alerts');
  renderAlerts();
  // After the screen has painted, bring the card into view.
  setTimeout(() => {
    const card = [...document.querySelectorAll('#alerts-body .ac')]
      .find(c => c.dataset.alertId === id);
    card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 60);
}

// Expanded card IDs preserved across re-renders so the poll doesn't collapse
// any card the user has opened.
const _openAlertCards = new Set();
function _toggleAlertCard(el, id) {
  const body = el.querySelector('.acbody');
  if (!body) return;
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  // B1: keep aria-expanded in sync — without this, screen readers permanently
  // announce the initial state from renderAlerts even after the user toggles.
  el.setAttribute('aria-expanded', String(!isOpen));
  if (isOpen) _openAlertCards.delete(id);
  else _openAlertCards.add(id);
  // Rotate chevron if present
  const chev = el.querySelector('.ac-chev');
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(180deg)';
}

function renderAlerts() {
  const local = wxData.alerts || [];
  // Alerts pinned from the map sit on top of the location's own list, but never
  // count towards it — the subtitle and the nav badge stay about the user's area.
  const localIds = new Set(local.map(alertFeatureId).filter(Boolean));
  const pinned = _pinnedMapAlerts.filter(p => !localIds.has(p.id));
  const al = [...pinned, ...local];
  // #29: card color comes from nwsEventColor (the same lookup used for map
  // polygons) so each alert's bar matches the polygon you'd see on the map.
  // Severity is kept only as a coarse text label (EXTREME / SEVERE / …).

  const areaLbl = displayName(activeLocation).toUpperCase();
  document.getElementById('alerts-sub').textContent =
    (local.length ? local.length + ' ACTIVE ALERT' + (local.length !== 1 ? 'S' : '') : 'NO ACTIVE ALERTS')
    + (areaLbl ? ' \xb7 ' + areaLbl : '');

  if (!al.length) {
    document.getElementById('alerts-body').innerHTML = `
      <div class="alerts-empty">
        <div class="alerts-empty-icon" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div class="alerts-empty-title">No alerts</div>
        <div class="alerts-empty-sub">No active NWS alerts for ${esc(displayName(activeLocation))}</div>
      </div>`;
    return;
  }

  // Prune _openAlertCards down to currently-active IDs so cleared alerts
  // don't accumulate in the set across location switches.
  const activeIds = new Set(al.map(alertFeatureId).filter(Boolean));
  for (const id of [..._openAlertCards]) if (!activeIds.has(id)) _openAlertCards.delete(id);

  const cardsHTML = al.map(a => {
    const id = alertFeatureId(a);
    const pr = a.properties || {}, sv = pr.severity || 'Unknown';
    const col = nwsEventColor(pr.event), lbl = alertLabel(pr.event, sv);
    const issued = pr.sent ? new Date(pr.sent) : null;
    const ag = issued ? Math.round((Date.now() - issued) / 3600000) + 'h ago' : '';
    // Every county the alert covers, first few visible with the rest a tap away.
    // Showing only areaDesc's first entry (what this did before) hid the other
    // 61 counties of a statewide advisory with no sign they existed.
    //
    // The list leads with the reader's own location: their forecast zone for
    // their own alerts, or the county they tapped for one pinned from the map.
    // Otherwise a statewide advisory opens with counties hundreds of miles away
    // purely because NWS lists them first.
    const lead = a._areaLead != null ? a._areaLead
               : alertAreaLeadByZone(pr, activeLocation.zone);
    const areaHTML = areaListHTML(pr.areaDesc, 'acarea-list', lead);
    // Full text exactly as issued by the NWS office — description (the body) plus
    // the call-to-action 'instruction'. Shown untruncated in the expanded card,
    // so this already *is* the full alert — no need to send anyone to NWS's raw
    // JSON API record for the same text.
    const descFull = (pr.description || '').trim().replace(/\n{3,}/g, '\n\n');
    const instr = (pr.instruction || '').trim();
    const aIcon = alertNWSIcon(pr.event);
    const wasOpen = _openAlertCards.has(id);
    // Alerts pulled in for the device's actual GPS location (not the
    // selected one) get a small badge so it's clear why an alert for a
    // different area is showing here — see the GPS side-fetch in fetchAlerts.
    const nearMeBadge = a._fromMap ? '<span class="ac-nearme">FROM MAP</span>'
                      : a._gpsOrigin ? '<span class="ac-nearme">NEAR YOU</span>' : '';
    // Issued + runs-until, always both. `ends` rather than `expires`: expires is
    // only the office's refresh deadline and understates how long an alert runs
    // — see alertEndsAt() in app.js. `_versions` is set when re-transmissions of
    // this same alert were folded in, so the count is stated rather than hidden.
    const times = [
      ...alertTimeLabels(pr),
      a._versions > 1 ? `latest of ${a._versions}` : '',
    ].filter(Boolean).join(' \xb7 ');
    // Severe-weather tags + storm motion, shown on the COLLAPSED card — the
    // whole point is reading "TORNADO OBSERVED" without having to tap in.
    const motion = alertMotion(pr);
    return `<div class="ac" role="button" tabindex="0" aria-expanded="${wasOpen ? 'true' : 'false'}" aria-label="${esc(pr.event || 'Alert')} — tap to expand" data-click-action="_toggleAlertCard" data-keydown-action="_kbdClick" data-alert-id="${esc(id)}">
      <div class="acbar" data-css-bg="${col}"></div>
      <div class="achdr">
        <div class="achdr-left">
          <span class="acsev" data-css-color="${col}">
            ${aIcon ? imgFb(aIcon, alertEmoji(pr.event), 'ac-sev-img', null) : ''}
            ${lbl}
          </span>
          ${nearMeBadge}
        </div>
        <span class="acago">${ag}</span>
      </div>
      <div class="actitle">${esc(pr.event || 'Alert')}</div>
      <div class="acarea">${areaHTML}<span class="ac-tap-hint"> \xb7 tap to expand</span></div>
      ${times ? `<div class="ac-times">${esc(times)}</div>` : ''}
      ${alertTagsHTML(pr)}
      ${motion ? `<div class="ac-motion">${esc(motion)}</div>` : ''}
      <div class="acbody _s-2a1b75"${wasOpen ? ' data-css-display="block"' : ''}>
        <div class="ac-desc">${esc(descFull)}</div>
        ${instr ? `<div class="ac-instr"><b>What to do:</b> ${esc(instr)}</div>` : ''}
        <div class="ac-src">Full alert text as issued by the National Weather Service</div>
      </div>
    </div>`;
  }).join('');

  // #18: skip the rebuild when the alert set is identical to last render.
  // Mid-poll this is the common case; rebuilding 100+ card divs trashes any
  // active text-selection and re-runs every <img loading="lazy">.
  _setInnerIfChanged(
    document.getElementById('alerts-body'),
    // Credit line names how the alerts were actually matched. It used to read
    // "Zone {forecastZone}", which stopped being true when the query moved to
    // point-in-polygon matching.
    cardsHTML + `<div class="_s-c902e8">api.weather.gov/alerts \xb7 ${esc(displayName(activeLocation))}</div>`
  );
}

function syncNavDots() {
  syncNotifBadge();
}
