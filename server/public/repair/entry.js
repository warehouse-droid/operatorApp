import {setTitle as rtitle,setText as rst} from './i18n.js?v=20261030-repair-language';
const route=location.pathname.replace(/\/+$/u,'');
const team=route==='/repair/workshop';
if(route==='/repair/office')history.replaceState(null,'','/repair'+location.search+location.hash);
function stylesheet(href){return new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(new Error('Unable to load Repair styles. Refresh to retry.'));document.head.append(link);});}
try{
 if(team){
  document.documentElement.dataset.appMode='standalone';
  const manifest=document.createElement('link');manifest.rel='manifest';manifest.href='/repair/team.webmanifest';document.head.append(manifest);
  const icon=document.createElement('link');icon.rel='apple-touch-icon';icon.href='/icons/mbbs-yard-192.png';document.head.append(icon);
  const capable=document.createElement('meta');capable.name='apple-mobile-web-app-capable';capable.content='yes';document.head.append(capable);
  document.body.classList.add('repair-team');document.querySelector('#repairApp').classList.add('tablet-shell');
  document.querySelector('meta[name="theme-color"]').content='#006f6b';rtitle('MBBS Repair Team');
  await Promise.all([stylesheet('/operator.css?v=20261027-repair-team'),stylesheet('/repair/workshop.css?v=20261030-repair-language')]);
  await import('./workshop.js?v=20261030-repair-language');
 }else{
  rtitle('Repair department · MBBS');
  await stylesheet('/repair/repair.css?v=20261030-repair-language');
  const portal=await import('./app.js?v=20261030-repair-language');await portal.ready;
  if(document.querySelector('.repair-topbar'))await import('/app-sidebar.js?repairNav=20261030-repair-language');
 }
}catch(error){rst(document.querySelector('#repairApp'),error.message);}
