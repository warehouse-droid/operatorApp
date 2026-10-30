/* global Notification, MutationObserver, Event, FileReader, atob */
(() => {
  if(window.MBBSOSNotifications) {return;}
  const tokenKeys=['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'];
  const token=()=>tokenKeys.map(key=>localStorage.getItem(key)).find(Boolean) || '';
  const popupSelector='.delivery-request-dialog[open],.regular-stock-popup[open],.special-delivery-method-dialog[open],.special-po-reference-dialog[open]';
  let session='',actor=null,generation=0,authority=null,registration=null,controls=null,button=null,soundButton=null,status=null;
  let preferences=null,indicator=null,returnFocus=null;
  let roleControls=null,soundControls=null,soundName=null,soundRevision=0,soundLoading=Promise.resolve();
  let soundBusy=false,soundChoice='default',soundRecord=null;
  const roleLabels={sales:'Sales',dispatch:'Dispatch',scm:'SCM'};
  const soundLimit=1024*1024;
  const pending=new Map(),seen=new Set(),soundSeen=new Set(),badgeSeen=new Set();
  const audio=()=>window.MBBSAlertSound;
  const supported=()=>window.isSecureContext && 'Notification' in window;
  const preferenceKey=()=>`mbbs.os-notifications.enabled.${actor.id}`;
  const seenKey=()=>`mbbs.os-notifications.seen.${actor.id}`;
  const soundPreferenceKey=()=>`mbbs.alert-sound.enabled.${actor.id}`;
  const customSoundKey=()=>`mbbs.alert-sound.custom.${actor.id}`;
  const rolePreferenceKey=role=>`mbbs.alert-role.muted.${actor.id}.${role}`;
  const soundSeenKey=()=>`mbbs.alert-sound.seen.${actor.id}`;
  const badgeCountKey=()=>`mbbs.app-badge.unread.${actor.id}`;
  const badgeSeenKey=()=>`mbbs.app-badge.seen.${actor.id}`;
  function stored(key,fallback) {try {return localStorage.getItem(key) ?? fallback;}catch {return fallback;}}
  function save(key,value) {try {localStorage.setItem(key,value);}catch {/* Memory deduplication still works without storage. */}}
  function enabled() {return supported() && actor && Notification.permission==='granted' && stored(preferenceKey(),'true')!=='false';}
  function soundPreferred() {return actor && stored(soundPreferenceKey(),'true')!=='false';}
  function soundEnabled() {return soundPreferred() && audio()?.ready();}
  function canCue() {return enabled() || soundEnabled();}
  function allowsRole(role) {return Boolean(actor && token()===session && (!Object.hasOwn(roleLabels,role) || stored(rolePreferenceKey(role),'false')!=='true'));}
  function noticeRole(input) {
    if(Object.hasOwn(roleLabels,input.role)) {return input.role;}
    return /^\/(sales|dispatch|scm)(?:\/|\?|$)/.exec(localPath(input.url))?.[1] || '';
  }
  function availableRoles() {
    const roles=[actor.role,...(Array.isArray(actor.roles)?actor.roles:[])].map(value=>String(value || '').trim().toLowerCase().replaceAll('-','_'));
    if(roles.includes('admin')) {return Object.keys(roleLabels);}
    return Object.keys(roleLabels).filter(role=>({sales:['sales'],dispatch:['dispatcher'],scm:['scm','scm_staff','yard_manager']})[role].some(value=>roles.includes(value)));
  }
  function preferencesChanged() {window.dispatchEvent(new Event('mbbs-notification-preferences-changed'));}
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
    roleControls=null;soundControls=null;soundName=null;soundRevision++;soundLoading=Promise.resolve();soundBusy=false;soundChoice='default';soundRecord=null;
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
    soundButton.title=soundEnabled()?'Click to mute notification sounds.':'Enable notification sounds while MBBS is open.';
    soundButton.setAttribute('aria-pressed',soundEnabled()?'true':'false');
  }
  function paintRoles() {
    const roles=availableRoles();
    if(!roleControls) {
      roleControls=document.createElement('fieldset');roleControls.className='app-role-preferences';
      roleControls.innerHTML='<legend>Mute alerts by role</legend><p>Muted roles do not show popups, desktop alerts, or play sounds. Updates remain in your work lists.</p>';
      controls.insertBefore(roleControls,status);
    }
    if(roleControls.hidden!==!roles.length) {roleControls.hidden=!roles.length;}
    for(const role of Object.keys(roleLabels)) {
      let input=roleControls.querySelector(`[data-notification-role="${role}"]`);
      if(!input) {
        const label=document.createElement('label');input=document.createElement('input');input.type='checkbox';input.dataset.notificationRole=role;
        label.append(input,`Mute ${roleLabels[role]} alerts`);roleControls.append(label);
        input.addEventListener('change',()=>{
          if(!actor || token()!==session) {return;}
          try {localStorage.setItem(rolePreferenceKey(role),String(input.checked));}
          catch {status.textContent='Could not save this preference. Check your browser storage settings.';paint();return;}
          if(input.checked) {audio()?.stopPlayback();closeRoleNotifications(role);}
          status.textContent=`${roleLabels[role]} alerts ${input.checked?'muted':'enabled'}.`;
          paint();preferencesChanged();mirrorPopups();
        });
      }
      if(input.parentElement.hidden!==!roles.includes(role)) {input.parentElement.hidden=!roles.includes(role);}
      input.checked=!allowsRole(role);
    }
  }
  function closeRoleNotifications(role) {
    const account=actor?.id;
    registration?.then(async worker=>{
      const notices=await worker.getNotifications?.() || [];
      notices.filter(item=>item.data?.actorId===account && item.data?.role===role).forEach(item=>item.close());
    }).catch(()=>{});
  }
  function createSoundControls() {
    soundControls=document.createElement('fieldset');soundControls.className='app-custom-sound';
    soundControls.innerHTML='<legend>Notification sound</legend><label for="appNotificationSoundChoice">Choose a sound</label><select id="appNotificationSoundChoice" aria-describedby="appNotificationPresetHelp"></select><p id="appNotificationPresetHelp">Built-in sounds are free. Choose one, then use Preview sound to listen.</p><p class="app-custom-sound-name"></p><label for="appNotificationSoundFile">Upload your sound</label><input id="appNotificationSoundFile" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" aria-describedby="appNotificationSoundHelp"><p id="appNotificationSoundHelp">Audio files up to 1 MB and 10 seconds. Saved for your account in this browser.</p><div class="app-sound-actions"><button type="button" data-preview-sound>Preview sound</button><button type="button" data-reset-sound>Use default sound</button></div>';
    const choice=soundControls.querySelector('select');
    for(const preset of audio().presets) {
      const option=document.createElement('option');option.value=preset.id;option.textContent=preset.label;choice.append(option);
    }
    const custom=document.createElement('option');custom.value='custom';custom.hidden=true;choice.append(custom);
    choice.addEventListener('change',()=>{soundLoading=chooseSound(choice.value);});
    soundControls.querySelector('input').addEventListener('change',event=>{
      const file=event.target.files?.[0];event.target.value='';if(file) {void uploadSound(file);}
    });
    soundControls.querySelector('[data-preview-sound]').addEventListener('click',()=>void previewSound());
    soundControls.querySelector('[data-reset-sound]').addEventListener('click',resetSound);
    controls.insertBefore(soundControls,status);
  }
  function selectedSoundLabel() {
    return soundName || audio().presets.find(preset=>preset.id===soundChoice)?.label || 'Default ding';
  }
  function paintCustomSound() {
    if(!audio()?.available()) {return;}
    if(!soundControls) {createSoundControls();}
    const choice=soundControls.querySelector('select'),custom=choice.querySelector('[value="custom"]');
    const uploaded=Boolean(soundRecord?.data),customLabel=uploaded?`Uploaded: ${soundRecord.name}`:'Your uploaded sound';
    if(custom.textContent!==customLabel) {custom.textContent=customLabel;}
    custom.hidden=!uploaded;custom.disabled=!uploaded;choice.value=soundChoice;choice.disabled=soundBusy;
    const name=soundControls.querySelector('.app-custom-sound-name'),label=selectedSoundLabel();
    if(name.textContent!==label) {name.textContent=label;}
    soundControls.querySelector('[data-reset-sound]').disabled=soundBusy || (soundChoice==='default' && !soundRecord);
    soundControls.querySelector('[data-preview-sound]').disabled=soundBusy;
    soundControls.querySelector('input').disabled=soundBusy;
  }
  function readSound(file) {
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);
      reader.onerror=()=>reject(new Error('The sound file could not be read. Please try again.'));reader.readAsDataURL(file);
    });
  }
  function parseSound(raw) {
    const record=JSON.parse(raw);
    if(!record || typeof record!=='object' || (record.preset!==undefined && !audio().presets.some(preset=>preset.id===record.preset))) {throw new Error('Invalid saved sound');}
    if(!record.preset || record.data!==undefined || record.name!==undefined) {
      if(typeof record.name!=='string' || typeof record.data!=='string' || !record.data || record.data.length>Math.ceil(soundLimit/3)*4) {throw new Error('Invalid saved sound');}
    }
    return record;
  }
  const soundBytes=record=>Uint8Array.from(atob(record.data),character=>character.charCodeAt(0)).buffer;
  async function restoreSound() {
    const revision=++soundRevision,version=generation,expected=session;
    soundName=null;soundChoice='default';soundRecord=null;audio()?.select(null);
    try {
      const raw=stored(customSoundKey(),'');if(!raw) {return;}
      const record=parseSound(raw);
      if(record.preset) {audio().selectPreset(record.preset);soundChoice=record.preset;soundRecord=record;return;}
      const buffer=await audio().prepare(soundBytes(record));
      if(!current(version,expected) || revision!==soundRevision) {return;}
      audio().select(buffer);soundName=record.name;soundChoice='custom';soundRecord=record;
    } catch {
      if(current(version,expected) && revision===soundRevision) {status.textContent='Your saved sound could not be loaded. Using the default ding; you can upload it again.';}
    } finally {if(current(version,expected) && revision===soundRevision) {paint();}}
  }
  async function prepareSoundChoice(choice) {
    if(choice==='custom') {
      if(!soundRecord?.data) {throw new Error('Upload a notification sound first.');}
      const record={name:soundRecord.name,data:soundRecord.data};
      return {record,buffer:await audio().prepare(soundBytes(record))};
    }
    if(!audio().presets.some(preset=>preset.id===choice)) {throw new Error('Choose an available notification sound.');}
    return {record:{...soundRecord,preset:choice},buffer:null};
  }
  async function chooseSound(choice) {
    const version=generation,expected=session,revision=++soundRevision;
    if(!current(version,expected)) {return;}
    soundBusy=true;paint();
    try {
      const custom=choice==='custom';
      const {record,buffer}=await prepareSoundChoice(choice);
      if(!current(version,expected) || revision!==soundRevision) {return;}
      try {localStorage.setItem(customSoundKey(),JSON.stringify(record));}
      catch {throw new Error('Could not save your sound. Check your browser storage settings.');}
      if(custom) {audio().select(buffer);}else {audio().selectPreset(choice);}
      soundRecord=record;soundChoice=choice;soundName=custom?record.name:null;
      status.textContent='Notification sound saved. Use Preview sound to listen.';
    } catch(error) {
      if(current(version,expected) && revision===soundRevision) {status.textContent=error.message;}
    } finally {if(current(version,expected) && revision===soundRevision) {soundBusy=false;paint();}}
  }
  function validateSound(file) {
    if(!file.size || file.size>soundLimit) {throw new Error('Choose a non-empty audio file up to 1 MB.');}
    if(!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name)) {throw new Error('Choose an audio file such as MP3, WAV, OGG, or M4A.');}
  }
  async function uploadSound(file) {
    const version=generation,expected=session,revision=++soundRevision;
    if(!current(version,expected)) {return;}
    soundBusy=true;status.textContent='Checking your sound…';paint();
    try {
      validateSound(file);
      const buffer=await audio().prepare(await file.arrayBuffer());
      const data=await readSound(file);
      if(!current(version,expected) || revision!==soundRevision) {return;}
      const name=file.name.slice(0,200);
      const record={name,data};
      try {localStorage.setItem(customSoundKey(),JSON.stringify(record));}
      catch {throw new Error('Could not save your sound. Free some browser storage and try again.');}
      audio().select(buffer);soundName=name;soundChoice='custom';soundRecord=record;status.textContent='Your notification sound is saved. Use Preview sound to listen.';
    } catch(error) {
      if(current(version,expected) && revision===soundRevision) {status.textContent=error.name==='EncodingError'?'This file could not be played. Try another audio file.':error.message;}
    } finally {if(current(version,expected) && revision===soundRevision) {soundBusy=false;paint();}}
  }
  function resetSound() {
    if(!actor || token()!==session) {return;}
    try {localStorage.removeItem(customSoundKey());}
    catch {status.textContent='Could not reset your sound. Check your browser storage settings.';return;}
    soundRevision++;soundBusy=false;soundName=null;soundChoice='default';soundRecord=null;audio().select(null);paint();status.textContent='Default notification sound restored.';
  }
  async function previewSound() {
    const version=generation,expected=session;
    const ready=await audio().unlock();await soundLoading;
    if(!current(version,expected)) {return;}
    const played=ready && await audio().play(()=>current(version,expected));
    if(current(version,expected)) {status.textContent=played?'Playing your notification sound.':'Sound could not be played. Check your browser sound settings and try again.';paint();}
  }
  async function playSound() {
    await verifySession();
    const version=generation,expected=session;
    if(!actor || !soundPreferred() || !audio()?.available()) {return false;}
    await soundLoading;
    if(!current(version,expected) || !soundPreferred() || !await audio().unlock()) {return false;}
    return audio().play(()=>current(version,expected) && soundPreferred());
  }
  function paint() {
    paintPreferenceEntries();
    if(!actor || (!supported() && !audio()?.available())) {return;}
    createControls();paintOS();paintSound();paintRoles();paintCustomSound();
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
    const first=!actor;actor=operator;paint();
    if(first && audio()?.available()) {soundLoading=restoreSound();}
    readAttention();void syncBadge();preferencesChanged();mirrorPopups();
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
      save(soundPreferenceKey(),'false');audio().stopPlayback();status.textContent='Alert sound is muted on this browser.';
      paint();void syncBadge();return false;
    }
    const ready=await audio().unlock();
    if(!current(version,expected)) {return false;}
    if(!ready) {status.textContent='Alert sound could not be enabled. Interact with MBBS and try again.';paint();return false;}
    save(soundPreferenceKey(),'true');paint();status.textContent='Notification sound is on while MBBS is open.';
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
  async function cueSound(key,version,expected,role) {
    await soundLoading;
    if(!current(version,expected) || !allowsRole(role) || !soundEnabled() || soundSeen.has(key) || receipts(soundSeenKey())[key]) {return;}
    const played=await audio().play(()=>current(version,expected) && allowsRole(role) && soundEnabled());
    if(played && current(version,expected) && allowsRole(role) && soundEnabled()) {remember(soundSeenKey(),key,soundSeen);}
  }
  async function cueBadge(key,version,expected) {
    if(!current(version,expected) || !canCue() || typeof navigator.setAppBadge!=='function') {return;}
    readAttention();
    if(badgeSeen.has(key) || receipts(badgeSeenKey())[key]) {return;}
    if(document.hidden || !document.hasFocus()) {save(badgeCountKey(),String(Math.min(unreadCount()+1,500)));}
    remember(badgeSeenKey(),key,badgeSeen);await syncBadge();
  }
  function silenceOS(key) {
    // An unlocked tab plays the chosen sound; the OS must not substitute its own ding.
    return !soundPreferred() || soundChoice!=='default' || soundSeen.has(key) || Boolean(receipts(soundSeenKey())[key]);
  }
  async function showOS(item,key,version,expected) {
    const options={body:item.body,tag:`mbbs-${actor.id}-${key}`,icon:'/icons/mbbs-yard-192.png',badge:'/icons/mbbs-yard-192.png',
      data:{url:item.url,actorId:actor.id,role:item.role},requireInteraction:true,silent:silenceOS(key)};
    try {
      if('serviceWorker' in navigator) {
        const worker=await notificationWorker();
        if(!current(version,expected) || !enabled() || !allowsRole(item.role)) {return false;}
        options.silent=silenceOS(key);
        await worker.showNotification(item.title,options);
      } else {
        const notice=new Notification(item.title,options);
        notice.onclick=()=>{notice.close();if(current(version,expected)) {window.focus();location.assign(item.url);}};
      }
      if(!current(version,expected)) {closeNotifications(options.data.actorId);return false;}
      if(!allowsRole(item.role)) {closeRoleNotifications(item.role);return false;}
      // The OS may supply the sound before any tab has unlocked Web Audio.
      // Count that cue too, so another tab cannot play the same event again.
      if(!options.silent) {remember(soundSeenKey(),key,soundSeen);}
      remember(seenKey(),key,seen);return true;
    } catch {return false;}
  }
  async function deliver(item,key,version,expected) {
    if(!current(version,expected) || !canCue() || !allowsRole(item.role)) {return false;}
    await cueSound(key,version,expected,item.role);
    if(!current(version,expected) || !allowsRole(item.role)) {return false;}
    await cueBadge(key,version,expected);
    if(!current(version,expected) || item.desktop===false || !enabled() || !allowsRole(item.role) || seen.has(key) || receipts()[key]) {return false;}
    return showOS(item,key,version,expected);
  }
  async function notify(input) {
    if(!validNotice(input)) {return false;}
    const expected=input.session || token();
    if(!expected || expected!==token()) {return false;}
    await verifySession();
    if(!actor || expected!==session || !canCue()) {return false;}
    const url=localPath(input.url),version=generation,role=noticeRole(input);
    if(!url || !allowsRole(role)) {return false;}
    const key=await digest(input.id);
    if(!current(version,expected)) {return false;}
    return deliverOnce({...input,url,role},key,version,expected);
  }
  function deliverOnce(item,key,version,expected) {
    if(pending.has(key)) {return pending.get(key);}
    const work=()=>deliver(item,key,version,expected);
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
      void notify({id:modal.dataset.osNotificationId || JSON.stringify([modal.className,title,body,url]),title,body,url,role:modal.dataset.notificationRole,session});
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
    .app-personal-preferences fieldset{min-width:0;margin:0;padding:12px;border:1px solid #cbd5e1;border-radius:8px}
    .app-personal-preferences legend{padding:0 5px;font-weight:700}
    .app-personal-preferences fieldset p{margin:0 0 10px;font-size:12px}
    .app-role-preferences label{display:flex;align-items:center;gap:8px;min-height:36px;cursor:pointer}
    .app-role-preferences input{width:18px;height:18px;accent-color:#0f766e}
    .app-personal-preferences [hidden]{display:none}
    .app-custom-sound label{display:block;font-weight:600}.app-custom-sound input{max-width:100%;margin:8px 0;font:inherit}
    .app-custom-sound select{box-sizing:border-box;display:block;width:100%;margin:8px 0;padding:8px;border:1px solid #64748b;border-radius:6px;background:#fff;color:#334155;font:inherit}
    .app-custom-sound-name{overflow-wrap:anywhere}.app-sound-actions{display:flex;flex-wrap:wrap;gap:8px}
    .app-os-notifications,.app-alert-sound,.app-notification-indicator,.app-preferences-close,.app-sound-actions button{padding:5px 9px;min-height:32px;border:1px solid #64748b;border-radius:8px;background:#fff;color:#334155;font:600 12px/1.3 system-ui;cursor:pointer}
    .app-sound-actions button:disabled{opacity:.5;cursor:default}
    .app-notification-indicator-floating{position:fixed;left:16px;bottom:16px;z-index:999;max-width:calc(100vw - 32px)}
    .app-os-notification-status{font:12px/1.5 system-ui;color:#475569}
    .app-personal-preferences button:focus-visible,.app-personal-preferences select:focus-visible,.app-notification-indicator:focus-visible{outline:3px solid #0f766e;outline-offset:2px}
    [data-personal-preferences][hidden]{display:none}
  `;document.head.append(style);
  new MutationObserver(()=>{paint();mirrorPopups();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('mbbs-auth-operator-changed',()=>{stop();void verifySession();});
  window.addEventListener('storage',event=>{
    if(!event.key || tokenKeys.includes(event.key)) {stop();void verifySession();}
    else {
      if(!soundPreferred()) {audio()?.stopPlayback();}
      if(actor && event.key===customSoundKey()) {soundBusy=false;soundLoading=restoreSound();}
      if(actor && event.key.startsWith(`mbbs.alert-role.muted.${actor.id}.`)) {
        const role=event.key.split('.').at(-1);
        if(!allowsRole(role)) {audio()?.stopPlayback();closeRoleNotifications(role);}
        preferencesChanged();mirrorPopups();
      }
      if(event.key.startsWith('mbbs.app-badge.unread.')) {readAttention();}
      paint();void syncBadge();
    }
  });
  window.addEventListener('focus',()=>{readAttention();void verifySession(true);});
  document.addEventListener('visibilitychange',readAttention);
  document.addEventListener('click',event=>{if(event.target?.closest?.('[data-personal-preferences]')) {openPreferences();}});
  const activateSound=event=>{if(!event.target?.closest?.('.app-personal-preferences,.app-notification-indicator,[data-personal-preferences]')) {unlockSound();}};
  document.addEventListener('pointerdown',activateSound);document.addEventListener('keydown',activateSound);
  window.addEventListener('pagehide',()=>{authority?.controller.abort();audio()?.stopPlayback();});
  window.addEventListener('pageshow',()=>{void verifySession();paint();readAttention();});
  window.MBBSOSNotifications={notify,enable,toggleSound,openPreferences,allowsRole,playSound};void verifySession();
})();
