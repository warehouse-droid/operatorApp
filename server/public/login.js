import {staffReturnPath} from './staff-login-routes.js';

const app=document.getElementById('loginApp');
const roleRoutes={boss:'/boss',admin:'/admin',operator:'/operator',dispatcher:'/dispatch',scm:'/scm',scm_staff:'/scm',yard_manager:'/control',sales:'/sales',field_sales:'/field-sales/',mbt_frontdesk:'/mbt/frontdesk',mbt_billing:'/mbt/billing'};
const moduleTokens={admin:'mbbs.control.token',yard_manager:'mbbs.control.token',operator:'mbbs.operator.token',dispatcher:'mbbs.dispatch.token',scm:'mbbs.dispatch.token',scm_staff:'mbbs.dispatch.token',sales:'mbbs.dispatch.token'};
const staffKeys=['mbbs.staff.token','mbbs.staff.role','mbbs.staff.roles','mbbs.control.token','mbbs.dispatch.token','mbbs.operator.token','mbbs.delivery.token'];
const cleanRole=value=>String(value||'').trim().toLowerCase().replaceAll('-','_').replaceAll(' ','_');
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
let stage='login',identity={},challengeId='',resetToken='',expiresAt=0,resendAt=0,busy=false;
const notice=message=>message?`<div class="login-notice" role="alert">${escape(message)}</div>`:'';
const field=(label,name,type='text',extra='')=>`<label><span>${label}</span><input name="${name}" type="${type}" required ${extra}></label>`;
function panel(title,body,message=''){
  app.innerHTML=`<section class="login-panel"><div class="login-title"><p>MBBS Operation</p><h1>${title}</h1></div>${notice(message)}${body}</section>`;
}
function renderLogin(message='',username=''){
  stage='login';resetToken='';challengeId='';
  panel('Staff login',`<p class="login-help">Sign in to your MBBS workspace.</p><form class="login-form" data-form="login">${field('Username','username','text',`autocomplete="username" value="${escape(username)}"`)}${field('Password','password','password','autocomplete="current-password"')}<button class="login-button" type="submit">Sign in</button></form><button class="login-link" data-action="forgot" type="button">Forgot password?</button><div class="login-footer"><span>Driving today?</span> <a href="/driver">Driver login</a></div>`,message);
}
function renderRequest(message=''){
  stage='request';panel('Reset password',`<p class="login-help">Enter your username and the email saved in your account. We’ll send a 6-digit code.</p><form class="login-form" data-form="request">${field('Username','username','text',`autocomplete="username" value="${escape(identity.username||'')}"`)}${field('Account email','email','email',`autocomplete="email" value="${escape(identity.email||'')}"`)}<button class="login-button" type="submit">Send code</button></form><button class="login-link" data-action="back" type="button">Back to sign in</button>`,message);
}
function renderCode(message=''){
  stage='code';panel('Check your email',`<p class="login-help">If your details match an active account, a code has been sent to <strong>${escape(identity.email)}</strong>. Check your inbox and spam folder.</p><form class="login-form" data-form="verify"><label><span>6-digit code</span><input name="passcode" class="passcode" type="text" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" spellcheck="false" required aria-describedby="code-time"></label><p class="code-time" id="code-time" role="status"></p><button class="login-button" type="submit">Verify code</button></form><button class="login-link" data-action="resend" type="button"></button><p class="login-help small">A new code replaces the previous code.</p><button class="login-link" data-action="back" type="button">Back to sign in</button>`,message);tick();app.querySelector('[name=passcode]').focus();
}
function renderPassword(message=''){
  stage='password';panel('Choose a password',`<p class="login-help">Use at least 6 characters. Your other staff sessions will be signed out.</p><form class="login-form" data-form="complete">${field('New password','password','password','autocomplete="new-password" minlength="6" maxlength="256"')}${field('Confirm password','confirmation','password','autocomplete="new-password" minlength="6" maxlength="256"')}<button class="login-button" type="submit">Reset password</button></form><button class="login-link" data-action="back" type="button">Back to sign in</button>`,message);
}
function tick(){
  if(stage!=='code'){return;}
  const seconds=Math.max(0,Math.ceil((expiresAt-Date.now())/1000)),wait=Math.max(0,Math.ceil((resendAt-Date.now())/1000));
  app.querySelector('#code-time').textContent=seconds?`Code expires in ${seconds}s`:'Code expired. Request a new code.';
  const resend=app.querySelector('[data-action=resend]');resend.textContent=wait?`Resend code in ${wait}s`:'Resend code';resend.disabled=busy||wait>0;
  app.querySelector('[data-form=verify] button').disabled=busy||seconds===0;
}
async function post(path,body){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){throw new Error(payload.error||'Unable to complete the request. Please try again.');}return payload;
}
async function signIn(data){
  const result=await post('/api/auth/login',data),operator=result.operator;
  const roles=[...new Set([...(operator?.roles||[]),operator?.role].map(cleanRole))];
  const home=staffReturnPath(operator?.homeRoute,roles)||roleRoutes[cleanRole(operator?.role)];
  if(!home||!result.token){throw new Error('This account does not have an application route.');}
  for(const key of staffKeys){localStorage.removeItem(key);}
  localStorage.setItem('mbbs.staff.token',result.token);localStorage.setItem('mbbs.staff.role',cleanRole(operator.role));localStorage.setItem('mbbs.staff.roles',JSON.stringify(roles));
  for(const role of roles){if(moduleTokens[role]){localStorage.setItem(moduleTokens[role],result.token);}}
  localStorage.setItem('mbbs.delivery.token',result.token);
  location.assign(staffReturnPath(new URLSearchParams(location.search).get('next'),roles)||home);
}
async function sendCode(){
  const result=await post('/api/auth/password-reset/request',identity);challengeId=result.challengeId;
  expiresAt=Date.now()+result.expiresIn*1000;resendAt=Date.now()+result.retryAfter*1000;resetToken='';renderCode();
}
function setBusy(value){busy=value;for(const button of app.querySelectorAll('button')){button.disabled=value;}tick();}
function showError(error){
  const existing=app.querySelector('[role=alert]');if(existing){existing.remove();}
  const element=document.createElement('div');element.className='login-notice';element.setAttribute('role','alert');element.textContent=error.message||'Please try again.';
  app.querySelector('.login-title').after(element);
}
app.addEventListener('input',event=>{if(event.target.name==='passcode'){event.target.value=event.target.value.replace(/[^0-9]/g,'').slice(0,6);}});
app.addEventListener('click',async event=>{
  const action=event.target.closest('[data-action]')?.dataset.action;if(!action||busy){return;}
  if(action==='back'){identity={};renderLogin();return;}
  if(action==='forgot'){identity={username:app.querySelector('[name=username]')?.value||''};renderRequest();return;}
  if(action==='resend'&&Date.now()>=resendAt){setBusy(true);try{await sendCode();}catch(error){showError(error);}finally{setBusy(false);}}
});
app.addEventListener('submit',async event=>{
  const form=event.target.closest('[data-form]');if(!form){return;}event.preventDefault();if(busy){return;}
  const data=Object.fromEntries(new FormData(form));setBusy(true);
  try {
    if(form.dataset.form==='login'){await signIn(data);}
    if(form.dataset.form==='request'){identity={username:data.username,email:data.email};await sendCode();}
    if(form.dataset.form==='verify'){
      if(Date.now()>=expiresAt){throw new Error('Code expired. Request a new code.');}
      const result=await post('/api/auth/password-reset/verify',{challengeId,passcode:data.passcode});resetToken=result.resetToken;renderPassword();
    }
    if(form.dataset.form==='complete'){
      if(data.password!==data.confirmation){throw new Error('Passwords do not match.');}
      await post('/api/auth/password-reset/complete',{resetToken,password:data.password});
      for(const key of staffKeys){localStorage.removeItem(key);}
      renderLogin('Password updated. Sign in with your new password.',identity.username);
    }
  }catch(error){showError(error);}finally{setBusy(false);}
});
setInterval(tick,250);
renderLogin();
