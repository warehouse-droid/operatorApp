/* global Notification, MutationObserver */
(() => {
  if(window.MBBSOSNotifications) {return;}
  const tokenKeys=['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'];
  const token=()=>tokenKeys.map(key=>localStorage.getItem(key)).find(Boolean) || '';
  const popupSelector='.delivery-request-dialog[open],.regular-stock-popup[open],.special-delivery-method-dialog[open],.special-po-reference-dialog[open]';
  let session='',actor=null,generation=0,authority=null,registration=null,controls=null,button=null,soundButton=null,status=null;
  let preferences=null,indicator=null,returnFocus=null;
  const pending=new Map(),seen=new Set(),soundSeen=new Set(),badgeSeen=new Set();
  const audio=()=>window.MBBSAlertSound;
  const supported=()=>window.isSecureContext && 'Notification' in window;
  const preferenceKey=()=>`mbbs.os-notifications.enabled.${actor.id}`;
  const seenKey=()=>`mbbs.os-notifications.seen.${actor.id}`;
  const soundPreferenceKey=()=>`mbbs.alert-sound.enabled.${actor.id}`;
  const soundSeenKey=()=>`mbbs.alert-sound.seen.${actor.id}`;
  const badgeCountKey=()=>`mbbs.app-badge.unread.${actor.id}`;
  const badgeSeenKey=()=>`mbbs.app-badge.seen.${actor.id}`;
  function stored(key,fallback) {try {return localStorage.getItem(key) ?? fallback;}catch {return fallback;}}
  function save(key,value) {try {localStorage.setItem(key,value);}catch {/* Memory deduplication still works without storage. */}}
  function enabled() {return supported() && actor && Notification.permission==='granted' && stored(preferenceKey(),'true')!=='false';}
  function soundPreferred() {return actor && stored(soundPreferenceKey(),'true')!=='false';}
  function soundEnabled() {return soundPreferred() && audio()?.ready();}
  function canCue() {return enabled() || soundEnabled();}
  function receipts(storageKey=seenKey()) {try {const value=JSON.parse(stored(storageKey,'{}'));return value && typeof value==='object'?value:{};}catch {return {};}}
  function current(version,expectedSession) {return version===generation && actor && session===expectedSession && token()===expectedSession;}
  function remember(storageKey,key,memory) {
    memory.add(key);if(memory.size>500) {memory.delete(memory.values().next().value);}
    const values=receipts(storageKey);values[key]=Date.now();
    save(storageKey,JSON.stringify(Object.fromEntries(Object.entries(values).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,500))));
  }
  function unreadCount() {
    const value=Number(stored(badgeCountKey(),'0'));
    return Number.isSafeInteger(value) && value>0?Math.min(value,500):0;
  }
  async function applyBadge() {
    const count=actor && token()===session && canCue()?unreadCount():0;
    try {
      if(count) {await navigator.setAppBadge(count);}
      else if(typeof navigator.clearAppBadge==='function') {await navigator.clearAppBadge();}
      else {await navigator.setAppBadge(0);}
      return true;
    } catch {return false;}
  }
  function syncBadge() {
    if(typeof navigator.setAppBadge!=='function') {return Promise.resolve(false);}
    try {return navigator.locks?navigator.locks.request('mbbs-staff-app-badge',applyBadge).catch(()=>false):applyBadge();}
    catch {return Promise.resolve(false);}
  }
  function readAttention() {
    if(actor && token()===session && !document.hidden && document.hasFocus()) {save(badgeCountKey(),'0');void syncBadge();}
  }
  function closeNotifications(previousActor) {
    registration?.then(async worker=>{
      const notices=await worker.getNotifications?.() || [];
      notices.filter(item=>item.data?.actorId===previousActor).forEach(item=>item.close());
    }).catch(()=>{});
  }
  function stop() {
    const previous=actor?.id;generation++;authority?.controller.abort();authority=null;actor=null;
    preferences?.close();preferences?.remove();indicator?.remove();
    preferences=null;indicator=null;returnFocus=null;controls=null;button=null;soundButton=null;status=null;
    paintPreferenceEntries();
    seen.clear();soundSeen.clear();badgeSeen.clear();pending.clear();audio()?.reset();
    if(previous) {save(`mbbs.app-badge.unread.${previous}`,'0');closeNotifications(previous);}
    void syncBadge();
  }
  function notificationHost() {
    return document.querySelector('.dispatch-topbar .topbar-actions,.topbar .topbar-actions,.topbar > .actions')
      || document.querySelector('.dispatch-topbar,.topbar,.mbt-app-topbar') || document.body;
  }
  function createControls() {
    if(controls) {return;}
    preferences=document.createElement('dialog');preferences.className='app-personal-preferences';
    preferences.setAttribute('aria-labelledby','appPersonalPreferencesTitle');
    preferences.innerHTML='<header><h2 id="appPersonalPreferencesTitle">Personal preferences</h2><button type="button" class="app-preferences-close" aria-label="Close personal preferences">Close</button></header><p>Saved for your account in this browser. Alerts are delivered while MBBS is open.</p>';
    const panel=preferences;
    panel.querySelector('.app-preferences-close').addEventListener('click',()=>panel.close());
    panel.addEventListener('close',()=>{
      if(preferences!==panel) {return;}
      if(actor && token()===session) {
        const target=returnFocus?.isConnected?returnFocus:document.querySelector('[data-personal-preferences]:not([hidden])');
        target?.focus();
      }
      returnFocus=null;
    });
    controls=document.createElement('div');controls.className='app-notification-controls';
    status=document.createElement('span');status.className='app-os-notification-status';status.setAttribute('role','status');
    controls.append(status);preferences.append(controls);document.body.append(preferences);
  }
  function paintPreferenceEntries() {
    const available=Boolean(actor && token()===session && (supported() || audio()?.available()));
    document.querySelectorAll('[data-personal-preferences]').forEach(entry=>{entry.hidden=!available;});
  }
  function openPreferences() {
    if(!actor || token()!==session) {return false;}
    paint();if(!preferences || preferences.open) {return false;}
    returnFocus=document.activeElement;preferences.showModal();return true;
  }
  function settingRow(label) {
    const row=document.createElement('div');row.className='app-preference-row';
    const heading=document.createElement('strong');heading.textContent=label;row.append(heading);
    controls.insertBefore(row,status);return row;
  }
  function paintOS() {
    if(!supported()) {return;}
    if(!button) {
      button=document.createElement('button');button.type='button';button.className='app-os-notifications';
      button.addEventListener('click',()=>void enable());settingRow('OS notifications').append(button);
    }
    const label=enabled()?'OS notifications on':Notification.permission==='denied'?'OS notifications blocked':'Enable OS notifications';
    if(button.textContent!==label) {button.textContent=label;}
    button.title=enabled()?'Click to turn off OS notifications on this browser.':'Enable alerts on this device while MBBS is open.';
    button.setAttribute('aria-pressed',enabled()?'true':'false');
  }
  function paintSound() {
    if(!audio()?.available()) {return;}
    if(!soundButton) {
      soundButton=document.createElement('button');soundButton.type='button';soundButton.className='app-alert-sound';
      soundButton.addEventListener('click',()=>void toggleSound());settingRow('Alert sound').append(soundButton);
    }
    const label=!soundPreferred()?'Alert sound off':soundEnabled()?'Alert sound on':'Enable alert sound';
    if(soundButton.textContent!==label) {soundButton.textContent=label;}
    soundButton.title=soundEnabled()?'Click to mute the Operator ding for alerts.':'Enable the Operator ding for alerts while MBBS is open.';
    soundButton.setAttribute('aria-pressed',soundEnabled()?'true':'false');
  }
  function paint() {
    paintPreferenceEntries();
    if(!actor || (!supported() && !audio()?.available())) {return;}
    createControls();paintOS();paintSound();
    if(!enabled()) {indicator?.remove();indicator=null;return;}
    if(!indicator) {
      indicator=document.createElement('button');indicator.type='button';indicator.className='app-notification-indicator';
      indicator.textContent='Notifications on';indicator.title='Open personal preferences';
      indicator.setAttribute('aria-haspopup','dialog');indicator.addEventListener('click',openPreferences);
    }
    const host=notificationHost();indicator.classList.toggle('app-notification-indicator-floating',host===document.body);
    if(indicator.parentElement!==host) {host.append(indicator);}
  }
  function acceptOperator(operator,version,expected) {
    if(version!==generation || token()!==expected) {return;}
    if(!operator?.id || operator.publicSales) {stop();return;}
    if(actor && actor.id!==operator.id) {stop();}
    actor=operator;paint();readAttention();void syncBadge();mirrorPopups();
  }
  async function lookupSession(expected,version,controller) {
    const response=await fetch('/api/auth/me',{cache:'no-store',headers:{Accept:'application/json',Authorization:`Bearer ${expected}`},signal:controller.signal});
    if(version!==generation || token()!==expected) {return;}
    if(response.status===401 || response.status===403) {stop();return;}
    if(!response.ok) {return;}
    const data=await response.json();acceptOperator(data.operator,version,expected);
  }
  async function verifySession(force=false) {
    const expected=token();
    if(expected!==session) {stop();session=expected;}
    if(!expected || (actor && !force)) {return;}
    if(authority) {return authority.promise;}
    const version=generation,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    const request={controller,promise:null};authority=request;
    request.promise=(async()=>{
      try {await lookupSession(expected,version,controller);}
      catch {/* Retry verification on the next update or focus. */}
      finally {clearTimeout(timeout);if(authority===request) {authority=null;}}
    })();
    return request.promise;
  }
  function unlockSound() {
    const version=generation,expected=session;
    if(!actor || !current(version,expected) || !soundPreferred() || !audio()?.available()) {return;}
    void audio().unlock().then(ready=>{if(ready && current(version,expected)) {paint();mirrorPopups();}});
  }
  async function toggleSound() {
    const version=generation,expected=session;
    if(!actor || !current(version,expected) || !audio()?.available()) {return false;}
    if(soundEnabled()) {
      save(soundPreferenceKey(),'false');audio().reset();status.textContent='Alert sound is muted on this browser.';
      paint();void syncBadge();return false;
    }
    const ready=await audio().unlock();
    if(!current(version,expected)) {return false;}
    if(!ready) {status.textContent='Alert sound could not be enabled. Interact with MBBS and try again.';paint();return false;}
    save(soundPreferenceKey(),'true');paint();status.textContent='The Operator alert sound is on while MBBS is open.';
    mirrorPopups();void syncBadge();return true;
  }
  async function enable() {
    if(!actor || token()!==session || !supported()) {return false;}
    if(enabled()) {save(preferenceKey(),'false');status.textContent='OS alerts are off on this browser.';paint();void syncBadge();return false;}
    const version=generation,expected=session;unlockSound();
    try {
      const permission=await Notification.requestPermission();
      if(!current(version,expected)) {return false;}
      if(permission!=='granted') {status.textContent='Allow notifications in your browser settings to receive OS alerts.';paint();return false;}
      save(preferenceKey(),'true');paint();status.textContent='OS alerts are enabled while MBBS is open.';
      mirrorPopups();void syncBadge();return true;
    } catch {if(current(version,expected)) {status.textContent='Notifications could not be enabled. Check your browser settings.';}return false;}
  }
  function activeWorker(worker) {
    if(worker.active?.state==='activated') {return Promise.resolve(worker);}
    const installing=worker.installing || worker.waiting || worker.active;
    if(!installing) {return Promise.reject(new Error('Notification worker is unavailable.'));}
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>finish(new Error('Notification worker timed out.')),10000);
      const finish=error=>{clearTimeout(timeout);installing.removeEventListener('statechange',changed);if(error) {reject(error);}else {resolve(worker);}};
      const changed=()=>{if(installing.state==='activated') {finish();}else if(installing.state==='redundant') {finish(new Error('Notification worker failed.'));}};
      installing.addEventListener('statechange',changed);changed();
    });
  }
  function notificationWorker() {
    if(!registration) {
      registration=navigator.serviceWorker.register('/app-notification-worker.js?v=20261014',{scope:'/staff-notifications/'})
        .then(activeWorker).catch(error=>{registration=null;throw error;});
    }
    return registration;
  }
  function localPath(value) {
    try {const url=new URL(value,location.origin);return url.origin===location.origin && ['http:','https:'].includes(url.protocol)?url.pathname+url.search+url.hash:'';}catch {return '';}
  }
  async function digest(value) {
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  async function cueSound(key,version,expected) {
    if(!soundEnabled() || soundSeen.has(key) || receipts(soundSeenKey())[key]) {return;}
    const played=await audio().play(()=>current(version,expected) && soundEnabled());
    if(played && current(version,expected) && soundEnabled()) {remember(soundSeenKey(),key,soundSeen);}
  }
  async function cueBadge(key,version,expected) {
    if(!current(version,expected) || !canCue() || typeof navigator.setAppBadge!=='function') {return;}
    readAttention();
    if(badgeSeen.has(key) || receipts(badgeSeenKey())[key]) {return;}
    if(document.hidden || !document.hasFocus()) {save(badgeCountKey(),String(Math.min(unreadCount()+1,500)));}
    remember(badgeSeenKey(),key,badgeSeen);await syncBadge();
  }
  function silenceOS(key) {
    return !soundPreferred() || soundSeen.has(key) || Boolean(receipts(soundSeenKey())[key]);
  }
  async function showOS(item,key,version,expected) {
    const options={body:item.body,tag:`mbbs-${actor.id}-${key}`,icon:'/icons/mbbs-yard-192.png',badge:'/icons/mbbs-yard-192.png',
      data:{url:item.url,actorId:actor.id},requireInteraction:true,silent:silenceOS(key)};
    try {
      if('serviceWorker' in navigator) {
        const worker=await notificationWorker();
        if(!current(version,expected) || !enabled()) {return false;}
        options.silent=silenceOS(key);
        await worker.showNotification(item.title,options);
      } else {
        const notice=new Notification(item.title,options);
        notice.onclick=()=>{notice.close();if(current(version,expected)) {window.focus();location.assign(item.url);}};
      }
      if(!current(version,expected)) {closeNotifications(options.data.actorId);return false;}
      remember(seenKey(),key,seen);return true;
    } catch {return false;}
  }
  async function deliver(item,key,version,expected) {
    if(!current(version,expected) || !canCue()) {return false;}
    await cueSound(key,version,expected);
    if(!current(version,expected)) {return false;}
    await cueBadge(key,version,expected);
    if(!current(version,expected) || !enabled() || seen.has(key) || receipts()[key]) {return false;}
    return showOS(item,key,version,expected);
  }
  async function notify(input) {
    if(!validNotice(input)) {return false;}
    const expected=input.session || token();
    if(!expected || expected!==token()) {return false;}
    await verifySession();
    if(!actor || expected!==session || !canCue()) {return false;}
    const url=localPath(input.url),version=generation;
    if(!url) {return false;}
    const key=await digest(input.id);
    if(!current(version,expected)) {return false;}
    if(pending.has(key)) {return pending.get(key);}
    const work=()=>deliver({...input,url},key,version,expected);
    const promise=(navigator.locks?navigator.locks.request(`mbbs-os-alert-${actor.id}`,work):work()).finally(()=>pending.delete(key));
    pending.set(key,promise);return promise;
  }
  function validNotice(input) {
    return Boolean(input) && typeof input.id==='string' && Boolean(input.id) && typeof input.title==='string' && typeof input.body==='string' && typeof input.url==='string';
  }
  function mirrorPopups() {
    if(!actor || !canCue()) {return;}
    for(const modal of document.querySelectorAll(popupSelector)) {
      const title=modal.querySelector('h2')?.textContent || 'MBBS update';
      const body=[...modal.children].filter(node=>node.tagName==='P' && !node.hasAttribute('role')).map(node=>node.textContent).filter(Boolean).join(' · ');
      const url=modal.querySelector('a[href]')?.getAttribute('href') || location.pathname+location.search;
      void notify({id:modal.dataset.osNotificationId || JSON.stringify([modal.className,title,body,url]),title,body,url,session});
    }
  }
  const style=document.createElement('style');style.textContent=`
    .app-personal-preferences{box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:20px;border:1px solid #c6d3da;border-radius:12px;background:#fff;color:#334155;font:14px/1.5 system-ui}
    .app-personal-preferences::backdrop{background:rgba(15,37,47,.45)}
    .app-personal-preferences header{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .app-personal-preferences h2{margin:0;font-size:20px}
    .app-personal-preferences p{margin:12px 0 20px;color:#475569}
    .app-notification-controls{display:grid;gap:16px}
    .app-preference-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
    .app-os-notifications,.app-alert-sound,.app-notification-indicator,.app-preferences-close{padding:5px 9px;min-height:32px;border:1px solid #64748b;border-radius:8px;background:#fff;color:#334155;font:600 12px/1.3 system-ui;cursor:pointer}
    .app-notification-indicator-floating{position:fixed;left:16px;bottom:16px;z-index:999;max-width:calc(100vw - 32px)}
    .app-os-notification-status{font:12px/1.5 system-ui;color:#475569}
    .app-personal-preferences button:focus-visible,.app-notification-indicator:focus-visible{outline:3px solid #0f766e;outline-offset:2px}
    [data-personal-preferences][hidden]{display:none}
  `;document.head.append(style);
  new MutationObserver(()=>{paint();mirrorPopups();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('mbbs-auth-operator-changed',()=>{stop();void verifySession();});
  window.addEventListener('storage',event=>{
    if(!event.key || tokenKeys.includes(event.key)) {stop();void verifySession();}
    else {
      if(!soundPreferred()) {audio()?.reset();}
      if(event.key.startsWith('mbbs.app-badge.unread.')) {readAttention();}
      paint();void syncBadge();
    }
  });
  window.addEventListener('focus',()=>{readAttention();void verifySession(true);});
  document.addEventListener('visibilitychange',readAttention);
  document.addEventListener('click',event=>{if(event.target?.closest?.('[data-personal-preferences]')) {openPreferences();}});
  const activateSound=event=>{if(!event.target?.closest?.('.app-personal-preferences,.app-notification-indicator,[data-personal-preferences]')) {unlockSound();}};
  document.addEventListener('pointerdown',activateSound);document.addEventListener('keydown',activateSound);
  window.addEventListener('pagehide',()=>{authority?.controller.abort();audio()?.reset();});
  window.addEventListener('pageshow',()=>{void verifySession();paint();readAttention();});
  window.MBBSOSNotifications={notify,enable,toggleSound,openPreferences};void verifySession();
})();
