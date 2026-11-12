let _alertsRetryHandle=null;function _cancelAlertsRetry(){_alertsRetryHandle&&(clearTimeout(_alertsRetryHandle),_alertsRetryHandle=null)}function _applyAlerts(e){if(processIncoming(e),wxData.alerts=e,renderAlerts(),typeof _paintLocAlert=="function"){const a=SAVED_LOCS.find(o=>o.id===activeLocation.id);a&&(_paintLocAlert(a),_applyLocActiveState())}syncNavDots(),mapAlertsOn&&lmap&&drawMapAlerts(),wxData.forecast.length&&renderWx()}function _withGPSAlerts(e,a){if(!a.length)return dedupeAlertFeatures(e);const o=[...e,...a].sort((r,s)=>new Date(s.properties?.sent||0)-new Date(r.properties?.sent||0));return dedupeAlertFeatures(o)}async function _mergeGPSAlerts(e,a,o,r,s){let l=[];try{const i=await e;if(_locGen!==o)return;if(i&&i.zone&&i.zone!==r&&i.lat!=null&&i.lon!=null){const n=await nwsFetch(`https://api.weather.gov/alerts/active?status=actual&point=${i.lat},${i.lon}`);if(!n.ok||_locGen!==o)return;const d=await n.json();if(_locGen!==o)return;const t=new Set(a.map(c=>c.properties?.id||c.id));l=(d.features||[]).filter(c=>!t.has(c.properties?.id||c.id)).map(c=>({...c,_gpsOrigin:!0}))}}catch{return}!l.length&&!s||_applyAlerts(_withGPSAlerts(a,l))}async function fetchAlerts(e=0){_cancelAlertsRetry();const a=_locGen,o=activeLocation.zone;try{const r=typeof _resolveGPSZone=="function"?Promise.resolve(_resolveGPSZone(!1)).catch(()=>null):Promise.resolve(null),s=await nwsFetch(`https://api.weather.gov/alerts/active?status=actual&point=${activeLocation.lat},${activeLocation.lon}`);if(!s.ok)throw new Error("HTTP "+s.status);const l=await s.json();if(_locGen!==a)return;const i=l.features||[],n=new Set(i.map(t=>t.properties?.id||t.id)),d=(wxData.alerts||[]).filter(t=>t._gpsOrigin&&!n.has(t.properties?.id||t.id));_applyAlerts(_withGPSAlerts(i,d)),_mergeGPSAlerts(r,i,a,o,d.length>0)}catch{if(_locGen!==a)return;if(e<3){const n=TIMINGS.ALERTS_RETRY_BASE_MS*Math.pow(2,e);_alertsRetryHandle=setTimeout(()=>{_alertsRetryHandle=null,_locGen===a&&activeLocation.zone===o&&fetchAlerts(e+1)},n);return}const s=document.getElementById("alerts-body"),i=typeof navigator<"u"&&navigator.onLine===!1?"You’re offline. Alerts will refresh when you reconnect.":"Could not load alerts";s&&(s.innerHTML=`<div class="ldg"><div>${i}</div><button class="retry-btn" data-click-action="fetchAlerts">Retry</button></div>`)}}let _pinnedMapAlerts=[];function clearPinnedMapAlerts(){_pinnedMapAlerts.length&&(_pinnedMapAlerts=[])}function openAlertInAlertsTab(e,a,o){_pinnedMapAlerts=(wxData.alerts||[]).some(s=>alertFeatureId(s)===e)||!a?[]:[{id:e,properties:a,_fromMap:!0,_areaLead:o>=0?o:null}],e&&_openAlertCards.add(e),typeof closeMapPopup=="function"&&closeMapPopup(),goNav("s-alerts"),renderAlerts(),setTimeout(()=>{[...document.querySelectorAll("#alerts-body .ac")].find(l=>l.dataset.alertId===e)?.scrollIntoView({block:"start",behavior:"smooth"})},60)}const _openAlertCards=new Set;function _toggleAlertCard(e,a){const o=e.querySelector(".acbody");if(!o)return;const r=o.style.display==="block";o.style.display=r?"none":"block",e.setAttribute("aria-expanded",String(!r)),r?_openAlertCards.delete(a):_openAlertCards.add(a);const s=e.querySelector(".ac-chev");s&&(s.style.transform=r?"":"rotate(180deg)")}function renderAlerts(){const e=wxData.alerts||[],a=new Set(e.map(alertFeatureId).filter(Boolean)),r=[..._pinnedMapAlerts.filter(n=>!a.has(n.id)),...e],s=displayName(activeLocation).toUpperCase();if(document.getElementById("alerts-sub").textContent=(e.length?e.length+" ACTIVE ALERT"+(e.length!==1?"S":""):"NO ACTIVE ALERTS")+(s?" · "+s:""),!r.length){document.getElementById("alerts-body").innerHTML=`
      <div class="alerts-empty">
        <div class="alerts-empty-icon" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div class="alerts-empty-title">No alerts</div>
        <div class="alerts-empty-sub">No active NWS alerts for ${esc(displayName(activeLocation))}</div>
      </div>`;return}const l=new Set(r.map(alertFeatureId).filter(Boolean));for(const n of[..._openAlertCards])l.has(n)||_openAlertCards.delete(n);const i=r.map(n=>{const d=alertFeatureId(n),t=n.properties||{},c=t.severity||"Unknown",u=nwsEventColor(t.event),A=alertLabel(t.event,c),p=t.sent?new Date(t.sent):null,_=p&&!isNaN(p)?agoStr(p):"",b=n._areaLead!=null?n._areaLead:alertAreaLeadByZone(t,activeLocation.zone),w=areaListHTML(t.areaDesc,"acarea-list",b),L=(t.description||"").trim().replace(/\n{3,}/g,`

`),v=(t.instruction||"").trim(),f=alertNWSIcon(t.event),g=_openAlertCards.has(d),$=n._fromMap?'<span class="ac-nearme">FROM MAP</span>':n._gpsOrigin?'<span class="ac-nearme">NEAR YOU</span>':"",h=[...alertTimeLabels(t),n._versions>1?`latest of ${n._versions}`:""].filter(Boolean).join(" · "),m=alertMotion(t),y=stormApproach(t,activeLocation);return`<div class="ac" role="button" tabindex="0" aria-expanded="${g?"true":"false"}" aria-label="${esc(t.event||"Alert")} — tap to expand" data-click-action="_toggleAlertCard" data-keydown-action="_kbdClick" data-alert-id="${esc(d)}">
      <div class="acbar" data-css-bg="${u}"></div>
      <div class="achdr">
        <div class="achdr-left">
          <span class="acsev" data-css-color="${readableAlertColor(u)}">
            ${f||alertEmoji(t.event)!=="⚠️"?imgFb(f,alertEmoji(t.event),"ac-sev-img",null):""}
            ${A}
          </span>
          ${$}
        </div>
        <span class="acago">${_}</span>
      </div>
      <div class="actitle">${esc(t.event||"Alert")}</div>
      <div class="acarea">${w}<span class="ac-tap-hint"> · tap to expand</span></div>
      ${h?`<div class="ac-times">${esc(h)}</div>`:""}
      ${alertTagsHTML(t)}
      ${m?`<div class="ac-motion">${esc(m)}</div>`:""}
      ${y?`<div class="ac-approach">${esc(y)}</div>`:""}
      <div class="acbody"${g?' data-css-display="block"':""}>
        <div class="ac-desc">${esc(L)}</div>
        ${v?`<div class="ac-instr"><b>What to do:</b> ${esc(v)}</div>`:""}
        <div class="ac-src">Full alert text as issued by the National Weather Service</div>
      </div>
    </div>`}).join("");_setInnerIfChanged(document.getElementById("alerts-body"),i+`<div class="_s-c902e8">api.weather.gov/alerts · ${esc(displayName(activeLocation))}</div>`)}function syncNavDots(){syncNotifBadge()}
