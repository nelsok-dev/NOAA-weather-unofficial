// Notifications module — in-app toasts, push API, alert history, settings

// ── Settings helpers ─────────────────────────────────────────────────────────
function isQuiet() {
  if (!document.getElementById('quiet-tog')?.checked) return false;
  const h = new Date().getHours();
  const from = +(document.getElementById('q-from')?.value ?? 22);
  const to   = +(document.getElementById('q-to')?.value   ?? 7);
  return from > to ? h >= from || h < to : h >= from && h < to;
}

function masterOn() { return document.getElementById('master-tog')?.checked ?? false; }

function isNWSAlert(ev) {
  const e = (ev || '').toLowerCase();
  return e.includes('watch')      ||
         e.includes('warning')    ||
         e.includes('advisory')   ||
         e.includes('statement')  ||
         e.includes('alert')      ||   // Air Quality Alert, etc.
         e.includes('outlook')    ||   // Hazardous Weather Outlook, Hydrologic Outlook
         e.includes('danger')     ||   // Extreme Fire Danger
         e.includes('evacuation');     // Evacuation Immediate
}

function shouldFire(a) {
  if (!masterOn()) return false;
  const pr = a.properties || {};
  const ev = pr.event || '';

  // Watches, Warnings, Advisories, and Statements always pass the severity filter
  if (!isNWSAlert(ev) && sevOrder(pr.severity) < sevOrder(minSev)) return false;

  // Quiet hours: Warnings override; Watches, Advisories, Statements do not
  if (isQuiet()) {
    const overrideEl = document.getElementById('override-tog');
    const isWarning = ev.toLowerCase().includes('warning');
    const isExtreme = pr.severity === 'Extreme' || pr.severity === 'Severe';
    if (!(overrideEl?.checked && (isExtreme || isWarning))) return false;
  }

  return true;
}

// ── Incoming alert processing ────────────────────────────────────────────────
// Tracks the signature of the last batch so unchanged polls skip the loop.
// Critically the signature includes the `sent` timestamp (#8): when NWS
// reissues a corrected/extended alert the id stays the same but `sent`
// changes, and we must toast again. Previously the seenIds set was keyed on
// id-only, so updates were silently suppressed.
let _lastIncomingHash = '';

// Composite key: alert URN + sent (or updated) timestamp.
function _alertKey(a) {
  const id   = a.id || a.properties?.id;
  if (!id) return null;
  const sent = a.properties?.sent || a.properties?.updated || '';
  return id + '@' + sent;
}

function processIncoming(alerts) {
  const sig = alerts.map(_alertKey).filter(Boolean).sort().join('|');
  if (sig === _lastIncomingHash) return; // nothing changed this round
  _lastIncomingHash = sig;

  let added = 0;
  alerts.forEach(a => {
    const key = _alertKey(a) || ('rand:' + Math.random().toString(36));
    if (seenIds.has(key)) return;
    seenIds.add(key);
    const id = a.id || a.properties?.id || key;
    added++;
    const pr = a.properties || {};
    // Decide fire-or-suppress up front so the entry's `read` flag matches the
    // live badge. An alert the user's filters suppress is added to history but
    // marked read — otherwise it counted as unread only after a reload (boot
    // recomputes `unread` from notifLog's read flags), so the badge would jump
    // on restart for alerts that never fired a toast/push this session.
    const willFire = shouldFire(a);
    const entry = {
      id,
      nid: _nextNotifKey(),   // BUG-1: stable row key; `time` collides in a batch
      emoji: alertEmoji(pr.event),
      event: pr.event || 'Weather Alert',
      headline: pr.headline || pr.event || 'NWS Alert',
      area: (pr.areaDesc || '').split(';')[0].trim(),
      color: nwsEventColor(pr.event),
      severity: pr.severity || 'Unknown',
      nwsIconUrl: alertNWSIcon(pr.event),
      time: new Date(),
      read: !willFire
    };
    notifLog.unshift(entry);
    if (notifLog.length > 60) notifLog.pop();
    if (willFire) {
      unread++;
      syncNotifBadge();
      queueToast(entry);
      firePush(entry);
    }
  });
  if (added) {
    if (typeof saveSeenIds === 'function') saveSeenIds();
    if (typeof saveNotifLog === 'function') saveNotifLog();
  }
}

// ── Toast ────────────────────────────────────────────────────────────────────
// N21: cache toast element refs on first use. nextToast()/dismissToast() ran
// getElementById up to 5× per invocation; the nodes never move after boot.
let _toastEls = null;
function _getToastEls() {
  if (_toastEls) return _toastEls;
  _toastEls = {
    root:  document.getElementById('toast'),
    img:   document.getElementById('t-img'),
    fb:    document.getElementById('t-fb'),
    title: document.getElementById('t-title'),
    msg:   document.getElementById('t-msg'),
  };
  return _toastEls;
}

// N1 / N3: the auto-dismiss timeout and the queue-advance timeout used to
// run loose. After a manual dismiss the 6.5s auto-dismiss would still
// fire and call nextToast() in parallel with dismissToast()'s own 400ms
// advance, racing the queue forward twice. Both timers now live in
// module vars and every state transition routes through _toastEnd() so
// `toastActive`, the visible class, and the next-toast schedule stay in
// lockstep.
let _toastAutoTimer = null;
let _toastNextTimer = null;

function _toastEnd(els) {
  if (_toastAutoTimer) { clearTimeout(_toastAutoTimer); _toastAutoTimer = null; }
  if (_toastNextTimer) { clearTimeout(_toastNextTimer); _toastNextTimer = null; }
  els.root.classList.remove('show');
  toastActive = false;
  _toastNextTimer = setTimeout(() => {
    _toastNextTimer = null;
    nextToast();
  }, 400);
}

function queueToast(n) {
  toastQueue.push(n);
  // Only kick off a new toast from idle. If a transition timer is
  // pending (we're inside the 400ms gap after a manual or auto dismiss),
  // let it fire — it'll pick up `n` from the queue.
  if (!toastActive && !_toastNextTimer) nextToast();
}

function nextToast() {
  if (!toastQueue.length) { toastActive = false; return; }
  toastActive = true;
  const n = toastQueue.shift();
  const els = _getToastEls();
  if (n.nwsIconUrl) { els.img.src = n.nwsIconUrl; els.img.style.display = 'block'; els.fb.style.display = 'none'; }
  else { els.img.style.display = 'none'; els.fb.style.display = 'block'; els.fb.textContent = n.emoji; }
  els.title.textContent = n.event;
  els.msg.textContent = n.headline;
  els.root.classList.add('show');
  if (_toastAutoTimer) clearTimeout(_toastAutoTimer);
  _toastAutoTimer = setTimeout(() => {
    _toastAutoTimer = null;
    _toastEnd(els);
  }, TIMINGS.TOAST_DURATION_MS);
}

function dismissToast() {
  _toastEnd(_getToastEls());
}

// ── Push notifications ───────────────────────────────────────────────────────
function checkPerm() {
  if ('Notification' in window) pushPerm = Notification.permission;
}

async function requestPush() {
  if (_isNativePlatform()) {
    if (window.pushNative) {
      const granted = await window.pushNative.requestPermission();
      renderPermBanner();
      if (granted) fireTestNotif();
    }
    return;
  }
  if (!('Notification' in window)) { flashErrorToast('Notifications', 'Not supported on this device.'); return; }
  const r = await Notification.requestPermission();
  pushPerm = r;
  renderPermBanner();
  if (r === 'granted') fireTestNotif();
}

// Jumps the user straight to this app's page in iOS Settings so re-enabling a
// blocked permission is a single tap — no hunting through Settings → Apps →
// NOAA Weather Unofficial → Notifications by hand.
async function openNotifSettings() {
  const plugin = window.Capacitor?.Plugins?.NOAAEnv;
  if (!plugin || typeof plugin.openSettings !== 'function') return;
  // Bare console, not _warn(), for the same reason push.js and _syncWidget use
  // one: this only ever runs on native, and _warn() suppresses logging there —
  // which is exactly where you need it visible via Safari Web Inspector.
  try { await plugin.openSettings(); } catch (e) { console.warn('[notif] openSettings failed', e); }
}

// Web path: permission state can only change in the browser's own UI, and we
// have no event for "user came back after fixing it." Re-reading
// Notification.permission and re-rendering lets the banner reflect reality
// the moment they return to the tab, instead of staying stuck on "blocked."
function recheckNotifPerm() {
  const was = pushPerm;
  checkPerm();
  renderPermBanner();
  if (was !== 'granted' && pushPerm === 'granted') {
    queueToast({
      id: 'perm-' + Date.now(),
      emoji: '✓', event: 'Notifications enabled', headline: 'You’ll get NWS alerts for your area.',
      area: '', color: '#34C759', nwsIconUrl: null,
      time: new Date(), read: true
    });
  }
}

function firePush(n) {
  // Skip on native — Notification API is a no-op in WKWebView; push is
  // handled by @capacitor/push-notifications via the Cloudflare relay.
  // In-app toast still fires from queueToast() at the call site.
  if (_isNativePlatform()) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('NOAA NWS: ' + n.event, { body: n.headline + '\n' + n.area, tag: n.id });
  } catch (e) {
    _warn('firePush', e);
  }
}

function fireTestNotif() {
  const t = {
    id: 'test-' + Date.now(),
    nid: _nextNotifKey(),
    emoji: '🔔',
    event: 'Test Alert',
    headline: 'Notifications are working. Real NWS alerts will look like this, for example “Wind Advisory: south winds 20–30 mph.”',
    area: displayName(activeLocation),
    color: '#0085CA',
    severity: 'test',
    nwsIconUrl: null,
    time: new Date(),
    read: false
  };
  notifLog.unshift(t);
  if (notifLog.length > 60) notifLog.pop();
  unread++;
  syncNotifBadge();
  if (typeof saveNotifLog === 'function') saveNotifLog();
  queueToast(t);
  firePush(t);
  if (document.getElementById('s-alerts').classList.contains('active')) {
    renderNotifList();
    markRead();
  }
}

// ── Notification list ────────────────────────────────────────────────────────
function syncNotifBadge() {
  // Unread count merges onto the Alerts badge (ab IDs) alongside active alert dots.
  // Active alerts take precedence over unread notifications.
  const alertCount = wxData.alerts.length;
  const count = alertCount > 0 ? alertCount : unread;
  const show = count > 0;
  const label = count > 99 ? '99+' : String(count);
  document.querySelectorAll('.nav-badge').forEach(e => {
    e.classList.toggle('show', show);
    e.textContent = show ? label : '';
  });
}

function renderNotifList() {
  const el = document.getElementById('notif-list');
  const strip = document.getElementById('notif-count-strip')?.closest('.status-strip');

  const clearBtn = document.querySelector('#s-alerts .noaa-hdr ._s-fa9433');
  if (!notifLog.length) {
    // "Clear skies ahead" above already covers the all-clear state.
    // Hide the strip and empty the list — two back-to-back empty states looks broken.
    if (strip) strip.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  if (strip) strip.style.display = '';
  if (clearBtn) clearBtn.style.display = '';
  document.getElementById('notif-count-strip').textContent =
    notifLog.length + ' ALERT' + (notifLog.length !== 1 ? 'S' : '') + ' \xb7 HISTORY';

  const groups = new Map();
  const _now2 = new Date();
  const _todayStr = _now2.toDateString();
  const _yest = new Date(_now2); _yest.setDate(_yest.getDate() - 1);
  const _yesterdayStr = _yest.toDateString();
  notifLog.forEach(n => {
    const d = new Date(n.time);
    const ds = d.toDateString();
    const lbl = ds === _todayStr ? 'Today' : ds === _yesterdayStr ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    if (!groups.has(lbl)) groups.set(lbl, []);
    groups.get(lbl).push(n);
  });

  // Same label as the alert cards (alertLabel in app.js); the app's own
  // entries — the Day Ahead summary and the test notification — keep theirs.
  const ownLabels = { info: 'BRIEFING', test: 'TEST' };

  let html = '';
  for (const [day, items] of groups) {
    html += `<div class="_s-126748">${day}</div>`;
    items.forEach((n, i) => {
      // BUG-1: keyed by nid, not by timestamp — a batch of alerts stamped in one
      // forEach shares a `time` to the millisecond, and two rows answering the
      // same selector meant a dismiss could animate one row and splice another.
      // `time` is still used for display (agoStr, the day grouping above).
      const nid = esc(n.nid);
      const sevLbl = ownLabels[n.severity] || alertLabel(n.event, n.severity);
      const unreadDot = n.read ? '' : '&nbsp;<span class="_s-58d1af"></span>';
      const destLbl = n.id?.startsWith('briefing-') ? 'open today’s forecast' : 'open alerts';
      html += `<div class="nh-wrap" data-nid="${nid}">
        <button class="nh-del" data-click-action="removeNotifItem" data-nid="${nid}" aria-label="Dismiss notification">&#x2715;</button>
        <div class="notif-item ${n.read ? 'n-read' : ''}"
          role="button" tabindex="0"
          aria-label="${esc(n.event)} — ${destLbl}"
          data-click-action="nhItemClick"
          data-keydown-action="_kbdClick"
          data-touchstart-action="nhTouchStart"
          data-touchmove-action="nhTouchMove"
          data-touchend-action="nhTouchEnd"
          data-touchcancel-action="nhTouchCancel"
          data-nid="${nid}">
          <div class="acbar" data-css-bg="${n.color}"></div>
          <div class="achdr">
            <span class="acsev" data-css-color="${n.color}">
              ${imgFb(n.nwsIconUrl, n.emoji || '⚠️', 'ac-sev-img', null)}
              ${sevLbl}
            </span>
            <span class="acago">${agoStr(n.time)}</span>
          </div>
          <div class="actitle">${esc(n.event)}${unreadDot}</div>
          <div class="acarea">${esc(n.area)}</div>
        </div>
      </div>`;
    });
  }
  html += `<div class="_s-9750da">
    <button class="_s-f35538" data-click-action="clearAllNotifs">Clear all</button>
  </div>`;
  _setInnerIfChanged(el, html);
}

function markRead() {
  notifLog.forEach(n => n.read = true);
  unread = 0;
  syncNotifBadge();
  if (typeof saveNotifLog === 'function') saveNotifLog();
}

// Two-tap confirmation guard — first tap arms it (shows "Sure?" feedback via
// the button text), second tap within 3 s executes. Prevents accidental wipes
// of the full notification history from a stray header tap.
let _clearConfirmPending = false;
let _clearConfirmTimer  = null;

function clearAllNotifs() {
  if (!_clearConfirmPending) {
    _clearConfirmPending = true;
    // Reflect "Sure?" on all .clear-notifs buttons (header + list footer).
    document.querySelectorAll('[data-click-action="clearAllNotifs"]').forEach(b => {
      b._origText = b._origText || b.textContent;
      b.textContent = 'Sure?';
      b.style.color = '#ff6b6b';
    });
    clearTimeout(_clearConfirmTimer);
    _clearConfirmTimer = setTimeout(() => {
      _clearConfirmPending = false;
      document.querySelectorAll('[data-click-action="clearAllNotifs"]').forEach(b => {
        b.textContent = b._origText || 'Clear';
        b.style.color = '';
      });
    }, 3000);
    return;
  }
  // Second tap confirmed — execute.
  clearTimeout(_clearConfirmTimer);
  _clearConfirmPending = false;
  document.querySelectorAll('[data-click-action="clearAllNotifs"]').forEach(b => {
    b.textContent = b._origText || 'Clear';
    b.style.color = '';
  });
  notifLog = [];
  unread = 0;
  syncNotifBadge();
  renderNotifList();
  if (typeof saveNotifLog === 'function') saveNotifLog();
}

// ── Settings UI ──────────────────────────────────────────────────────────────
// True when we're running inside the Capacitor native iOS shell. The Web
// Notifications API does NOT work in a WKWebView — `Notification.requestPermission`
// returns 'denied' immediately and even 'granted' calls to `new Notification`
// never deliver to the system notification center. Native push is handled by
// @capacitor/push-notifications + the Cloudflare relay instead.
function _isNativePlatform() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

function renderPermBanner() {
  const w = document.getElementById('perm-wrap');

  // Native iOS: push goes through @capacitor/push-notifications + the Cloudflare
  // relay (noaa-alert-relay.nelsok.workers.dev). Background delivery is always
  // active once permission is granted — the relay polls NWS independently of
  // whether the app is open. pushNative.getState() reports the current state.
  if (_isNativePlatform()) {
    const st = window.pushNative ? window.pushNative.getState() : { regState: 'unknown' };
    if (st.regState === 'granted') {
      // Describe the actual coverage: watches/warnings/advisories always push;
      // other NWS events follow the user's minSev filter.
      const sevLabel = (typeof minSev !== 'undefined' && minSev !== 'Severe')
        ? minSev.toLowerCase() + ' and above'
        : 'severe and extreme';
      w.innerHTML = ''
        + '<div class="perm granted">'
        +   '<div class="perm-title _s-016eb5">✓ Background push active</div>'
        +   '<div class="perm-sub _s-ef0b7a">NWS watches, warnings and advisories reach you even when the app is closed. Other NWS alerts notify at ' + sevLabel + ' severity.</div>'
        + '</div>';
    } else if (st.regState === 'denied') {
      w.innerHTML = ''
        + '<div class="perm denied">'
        +   '<div class="perm-title">🔕 Severe weather alerts are off</div>'
        +   '<div class="perm-sub">Turn notifications back on in Settings to get tornado warnings, flash flood alerts and other NWS alerts, even when the app is closed.</div>'
        +   '<button class="perm-btn" data-click-action="openNotifSettings">Open Settings</button>'
        + '</div>';
    } else {
      w.innerHTML = ''
        + '<div class="perm default">'
        +   '<div class="perm-title">🔔 Enable background push</div>'
        +   '<div class="perm-sub">Get tornado warnings, flash flood alerts and other NWS alerts, even when the app is closed.</div>'
        +   '<button class="perm-btn" data-click-action="requestPush">Enable Notifications</button>'
        + '</div>';
    }
    return;
  }

  if (!('Notification' in window)) {
    w.innerHTML = '<div class="perm default"><div class="perm-title">🔔 Notifications unavailable</div><div class="perm-sub _s-ef0b7a">In-app toasts remain active.</div></div>';
    return;
  }
  checkPerm();
  if (pushPerm === 'granted') {
    w.innerHTML = '<div class="perm granted"><div class="perm-title _s-016eb5">✓ Notifications enabled</div><div class="perm-sub _s-ef0b7a">NWS alerts delivered while the browser tab is open. For background push, use the iOS app.</div></div>';
  } else if (pushPerm === 'denied') {
    // Provide platform-specific guidance — iOS Safari and desktop Chrome handle
    // re-enabling differently, and the user has no in-app button that can flip
    // a denied permission back to "default".
    const ua = navigator.userAgent || '';
    let how = 'Re-enable in your browser\'s site settings.';
    if (/iPhone|iPad|iPod/.test(ua)) {
      how = 'iOS: Settings → Apps → Safari → Advanced → Website Data → noaa-* → Notifications → Allow.';
    } else if (/Android/.test(ua) && /Chrome/.test(ua)) {
      how = 'Android Chrome: tap ⋮ → Settings → Site Settings → Notifications → find this site → Allow.';
    } else if (/Chrome/.test(ua)) {
      how = 'Chrome: click the 🔒 icon in the address bar → Site settings → Notifications → Allow.';
    } else if (/Safari/.test(ua)) {
      how = 'macOS Safari: Safari menu → Settings → Websites → Notifications → set this site to Allow.';
    } else if (/Firefox/.test(ua)) {
      how = 'Firefox: click the 🔒 icon in the address bar → Connection secure → More info → Permissions → Notifications → Allow.';
    }
    w.innerHTML = '<div class="perm denied">'
      + '<div class="perm-title">🔕 Severe weather alerts are off</div>'
      + `<div class="perm-sub">Turn them back on to get tornado warnings, flash flood alerts and other NWS alerts as soon as they’re issued.<br><br><strong>${how}</strong></div>`
      + '<button class="perm-btn" data-click-action="recheckNotifPerm">Check again</button>'
      + '</div>';
  } else {
    w.innerHTML = '<div class="perm default"><div class="perm-title">🔔 Enable browser notifications</div><div class="perm-sub">Receive NWS alerts while this tab is open.</div><button class="perm-btn" data-click-action="requestPush">Enable Notifications</button></div>';
  }
}

function onMasterChange(on) {
  if (on && pushPerm === 'default' && !_isNativePlatform()) requestPush();
  // Native: keep the Cloudflare relay in sync with the toggle. Off must
  // unregister the device token, otherwise background APNs pushes keep
  // arriving even though the user disabled alerts in-app. On re-registers
  // (no permission dialog if the OS grant already exists) and re-syncs.
  if (_isNativePlatform() && window.pushNative) {
    if (on) window.pushNative.requestPermission();
    // true = a deliberate in-app opt-out, so the relay subscription must stay
    // gone rather than being re-created on the next foreground.
    else    window.pushNative.unregister(true);
  }
  _syncBriefingInterval(); // #22: briefing also gated on masterOn()
  if (typeof saveSettings === 'function') saveSettings();
}

function setSev(s, btn) {
  minSev = s;
  document.querySelectorAll('#sev-chips .sev-chip').forEach(b => {
    b.classList.remove('sel');
    b.textContent = b.textContent.replace(' ✓', '');
  });
  btn.classList.add('sel');
  btn.textContent += ' ✓';
  if (typeof saveSettings === 'function') saveSettings();
  // Re-sync the relay so the new severity filter takes effect immediately for
  // background push — not just the next time the location changes.
  if (window.pushNative) window.pushNative.syncLocation();
}

function setPoll(mins) {
  clearInterval(pollHandle);
  // Poll weather alongside alerts so the hero/hourly data stays fresh while
  // the app is foregrounded and _checkConditionsChanged actually runs on
  // every poll as documented (previously only alerts were on the timer).
  pollHandle = setInterval(() => {
    fetchAlerts(); fetchWx();
    if (typeof refreshStormCenterIfOpen === 'function') refreshStormCenterIfOpen();
  }, mins * 60000);
  if (typeof saveSettings === 'function') saveSettings();
}

// ── Day Ahead (the daily forecast summary) ───────────────────────────────────

function onBriefingChange() {
  const on = document.getElementById('briefing-tog').checked;
  const row = document.getElementById('briefing-time-row');
  row.style.opacity = on ? '1' : '0.4';
  row.style.pointerEvents = on ? 'auto' : 'none';
  const h = +document.getElementById('briefing-time').value;
  const fmt = h => (h % 12 || 12) + ':00 ' + (h >= 12 ? 'PM' : 'AM');
  document.getElementById('briefing-time-sub').textContent = fmt(h);
  _syncBriefingInterval(); // #22
  if (typeof saveSettings === 'function') saveSettings();
  // The briefing is delivered by the relay on native, so a change here has to
  // reach it. Skipped while applyStoredSettings() is hydrating — it calls this
  // on every boot purely to set the row's appearance, and syncLocation()
  // already runs at registration.
  const hydrating = typeof _applyingSettings !== 'undefined' && _applyingSettings;
  if (!hydrating && window.pushNative) window.pushNative.syncLocation();
}

// #22: the once-per-minute briefing poll only does meaningful work when the
// toggle is on (it short-circuits otherwise). Keep the interval lazy so the
// app isn't running an idle setInterval forever for users who never enable
// the Day Ahead summary.
let _briefingInterval = null;
function _syncBriefingInterval() {
  // On native the relay delivers the briefing as a real push, so the in-app
  // timer is not just redundant — it never worked. fireBriefingNotif() skips
  // its notification branch when _isNativePlatform(), and this interval lives
  // in the WebView, which iOS suspends in the background. Running it would only
  // append a duplicate history row on the rare occasion the app happened to be
  // open at the briefing hour. Web builds keep it: there the Notification API
  // path is real and there is no relay push.
  if (_isNativePlatform()) {
    if (_briefingInterval) { clearInterval(_briefingInterval); _briefingInterval = null; }
    return;
  }
  const tog = document.getElementById('briefing-tog');
  const on  = tog?.checked && masterOn();
  if (on && !_briefingInterval) {
    _briefingInterval = setInterval(checkDailyBriefing, TIMINGS.BRIEFING_POLL_MS);
  } else if (!on && _briefingInterval) {
    clearInterval(_briefingInterval);
    _briefingInterval = null;
  }
}

function buildBriefingMessage() {
  const today = (wxData.forecast || []).find(p => p.isDaytime) || wxData.forecast?.[0];
  const tonight = (wxData.forecast || []).find(p => !p.isDaytime);
  if (!today) return null;

  // Format through ft() / fmtWind() so the briefing honors the user's unit
  // prefs — a °C / km/h user was previously always shown °F / mph here.
  const hi = today.temperature != null ? ft(today.temperature) : '--°';
  const lo = tonight?.temperature != null ? ft(tonight.temperature) : null;
  const cond = today.shortForecast || '';
  const wind = today.windSpeed ? ' · Wind ' + fmtWind(today.windSpeed) : '';
  const alerts = wxData.alerts || [];

  let msg = `High ${hi}${lo ? ', Low ' + lo : ''} · ${cond}${wind}`;
  if (alerts.length) {
    const ev = alerts[0].properties?.event || 'Weather alert';
    msg += ` · ⚠️ ${ev} in effect`;
  }
  return msg;
}

function fireBriefingNotif(force) {
  if (!force && !masterOn()) return false;

  // C5: the briefing is a "Minor" severity event by NWS classification — it
  // should respect the user's quiet-hours setting. Without this gate, a 6 AM
  // briefing fires inside the 10 PM–7 AM quiet window. `force=true` (the
  // "Send test Day Ahead" button in Settings) bypasses the gate.
  if (!force && isQuiet()) {
    // The "Override for Warnings" toggle only escapes quiet hours for
    // actual warnings — the briefing is not one, so always suppress here.
    return false;
  }

  const msg = buildBriefingMessage();
  if (!msg) return false;

  const now = new Date();
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  // Keep in step with the relay's own title (noaa-alert-relay src/briefing.ts)
  // — on native the relay sends this banner, not the app, so a rename here
  // alone leaves the real notification saying something else.
  const title = `☀️ Day Ahead · ${dateStr}`;
  // Abbreviated state: the body has to survive iOS truncating a banner to two
  // lines, and "Seattle, WA" leaves room the spelled-out state was taking.
  const place = briefingPlaceName(activeLocation);
  const body = `${place}: ${msg}`;

  // Push notification (web only — native uses @capacitor/push-notifications).
  if (!_isNativePlatform() && 'Notification' in window && Notification.permission === 'granted') {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(sw =>
        sw.showNotification(title, { body, tag: 'daily-briefing', renotify: true })
      ).catch(() => { try { new Notification(title, { body }); } catch (_) {} });
    } else {
      try { new Notification(title, { body }); } catch (_) {}
    }
  }

  // Add to in-app history
  const entry = {
    id: 'briefing-' + now.getTime(),
    nid: _nextNotifKey(),
    emoji: '☀️', event: 'Day Ahead',
    headline: body, area: place || activeLocation.name || '',
    color: '#0085CA', severity: 'info',
    nwsIconUrl: null, time: now, read: false
  };
  notifLog.unshift(entry);
  if (notifLog.length > 60) notifLog.pop();
  unread++;
  syncNotifBadge();
  if (typeof saveNotifLog === 'function') saveNotifLog();
  if (document.getElementById('s-alerts')?.classList.contains('active')) {
    renderNotifList(); markRead();
  }
  return true;
}

function checkDailyBriefing() {
  const tog = document.getElementById('briefing-tog');
  if (!tog?.checked || !masterOn()) return;

  const now = new Date();
  const targetH = parseInt(document.getElementById('briefing-time')?.value ?? '7');
  if (now.getHours() !== targetH) return;

  const today = now.toDateString();
  try { if (localStorage.getItem('lastBriefingDate') === today) return; } catch (_) {}

  // Only mark today as briefed if the notification actually fired —
  // otherwise (e.g. no forecast loaded yet at cold start) we'll retry next minute.
  if (fireBriefingNotif(false)) {
    try { localStorage.setItem('lastBriefingDate', today); } catch (_) {}
  }
}

function onQuietChange() {
  const on = document.getElementById('quiet-tog').checked;
  const row = document.getElementById('quiet-time-row');
  row.style.opacity = on ? '1' : '0.4';
  row.style.pointerEvents = on ? 'auto' : 'none';
  const fv = +document.getElementById('q-from').value, tv = +document.getElementById('q-to').value;
  const fmt = h => (h % 12 || 12) + ':00 ' + (h >= 12 ? 'PM' : 'AM');
  document.getElementById('quiet-sub').textContent = fmt(fv) + ' – ' + fmt(tv);
  if (typeof saveSettings === 'function') saveSettings();
  // Quiet hours are enforced by the relay (the in-app path only ever gated
  // toasts), so a change here has to reach it or the setting does nothing on
  // native. Skipped during applyStoredSettings(), which calls this on every
  // boot purely to hydrate the row's appearance — syncLocation() already runs
  // at registration and would otherwise fire twice on every launch.
  const hydrating = typeof _applyingSettings !== 'undefined' && _applyingSettings;
  if (!hydrating && window.pushNative) window.pushNative.syncLocation();
}

// ── Notification history swipe-to-dismiss ────────────────────────────────────

const _nhTouch = {};
// Blocks the synthetic click that fires after a swipe gesture, mirroring the
// _lcSuppressClick pattern used by location cards. The touchend delegation
// listener is passive so e.preventDefault() is a no-op there; this flag
// is checked by nhItemClick instead.
let _nhSuppressClick = false;

// Notification item click — routes by entry type (unless a swipe just finished).
// A "Day Ahead" entry is a summary of *today's* forecast, not an NWS
// alert — sending it to s-alerts dead-ends on "Clear skies ahead, no active
// alerts," which reads as broken and trains people to stop tapping the
// briefing entirely. Route it to the Weather tab — the actual content it
// was summarizing — so the daily-briefing habit has a payoff every time.
function nhItemClick(el) {
  if (_nhSuppressClick) { _nhSuppressClick = false; return; }
  if (typeof goNav !== 'function') return;
  const nid = el?.dataset?.nid;
  const entry = nid ? notifLog.find(n => n.nid === nid) : null;
  const isBriefing = entry?.id?.startsWith('briefing-');
  goNav(isBriefing ? 's-wx' : 's-alerts', null);
}

function nhTouchStart(e, nid) {
  _nhTouch[nid] = { x: e.touches[0].clientX, dx: 0, moved: false };
}

function nhTouchMove(e, nid) {
  if (!_nhTouch[nid]) return;
  const dx = e.touches[0].clientX - _nhTouch[nid].x;
  if (dx >= 0) { _nhTouch[nid].dx = 0; return; } // block right swipe
  _nhTouch[nid].dx = dx;
  _nhTouch[nid].moved = Math.abs(dx) > 8;
  const item = document.querySelector(`.nh-wrap[data-nid="${nid}"] .notif-item`);
  if (item) item.style.transform = `translateX(${Math.max(dx, -72)}px)`;
}

function nhTouchEnd(e, nid) {
  if (!_nhTouch[nid]) return;
  const dx = _nhTouch[nid].dx || 0;
  const moved = _nhTouch[nid].moved;
  const item = document.querySelector(`.nh-wrap[data-nid="${nid}"] .notif-item`);
  if (Math.abs(dx) > 50) {
    if (item) item.style.transform = 'translateX(-72px)'; // hold open to reveal ✕
  } else {
    if (item) item.style.transform = ''; // snap back
  }
  if (Math.abs(dx) > 50) {
    _nhSuppressClick = true;
    setTimeout(() => { _nhSuppressClick = false; }, TIMINGS.PTR_CLICK_SUPPRESS_MS);
  }
  delete _nhTouch[nid];
}

// C6: snap the row back to closed if iOS cancels the gesture mid-swipe.
function nhTouchCancel(e, nid) {
  if (!_nhTouch[nid]) return;
  const item = document.querySelector(`.nh-wrap[data-nid="${nid}"] .notif-item`);
  if (item) item.style.transform = '';
  delete _nhTouch[nid];
}

function removeNotifItem(nid) {
  if (!nid) return;
  // Both lookups below now key on the same unique nid, so they cannot resolve
  // to different rows. Previously both matched on a millisecond timestamp and
  // each took its FIRST match — the array's and the DOM's — which for a batch
  // stamped in one forEach were not necessarily the same entry.
  const findIdx = () => notifLog.findIndex(n => n.nid === nid);
  if (findIdx() === -1) return;
  const wrap = document.querySelector(`.nh-wrap[data-nid="${nid}"]`);
  const doRemove = () => {
    // Re-find the index at removal time — a poll can unshift new entries
    // during the 270ms exit animation, which would shift a captured index
    // onto the wrong row. (Still required: the index moves even though the
    // key is now stable.)
    const idx = findIdx();
    if (idx !== -1) notifLog.splice(idx, 1);
    unread = notifLog.filter(n => !n.read).length;
    syncNotifBadge();
    renderNotifList();
    if (typeof saveNotifLog === 'function') saveNotifLog();
  };
  if (wrap) {
    // Animate the row to zero height before removing
    wrap.style.transition = 'max-height .25s ease, opacity .2s ease';
    wrap.style.maxHeight = wrap.offsetHeight + 'px';
    wrap.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      wrap.style.maxHeight = '0';
      wrap.style.opacity = '0';
    });
    setTimeout(doRemove, 270);
  } else {
    doRemove();
  }
}
