import {formatDeadline} from './domain.js';
import {escapeHtml,notice,badge,agreementHtml,summaryHtml,signedHtml,drawSignature,downloadPdf} from './ui.js';
const app=document.getElementById('mbrApp'),token=location.hash.slice(1);
let contract,pad,submissionId,attemptFingerprint='';
const headers={'x-mbr-contract-token':token};
async function review(message='') {
  const response=await fetch('/api/mbr/public/contract',{headers,cache:'no-store'});
  const payload=await response.json();
  if(!response.ok) {throw new Error(payload.error || 'This signing link is unavailable. Contact MBR Sales.');}
  contract=payload;render();notice(message);
}
function render() {
  const completed=contract.status==='completed';
  app.innerHTML=`<section class="mbr-card"><div class="mbr-card-top"><h2>${escapeHtml(contract.number)}</h2>${badge(contract.status)}</div>${completed?'':`<p class="mbr-muted">Please sign by ${escapeHtml(formatDeadline(contract.expiresAt))}.</p>`}${summaryHtml(contract)}</section>${completed?signedHtml(contract):signingForm()}<section class="mbr-card"><h2>Rental agreement</h2>${agreementHtml(contract.paragraphs)}</section>`;
  if(completed) {document.querySelector('header h1').textContent='Your signed agreement';return;}
  pad=drawSignature(document.getElementById('mbrSignature'));submissionId=null;attemptFingerprint='';
  document.getElementById('mbrSigningForm').addEventListener('submit',sign);
}
function signingForm() {
  return `<section class="mbr-card" id="signing-section"><h2>Choose protection &amp; sign</h2><form id="mbrSigningForm"><fieldset><legend>Rental Protection Plan</legend><p class="mbr-field-help">Optional. Adds 15% of applicable rental charges. See section 8 for coverage and exclusions.</p><div class="mbr-plan-options"><label class="mbr-option"><input type="radio" name="protection" value="accept" required checked><span>Accept the Rental Protection Plan</span></label><label class="mbr-option"><input type="radio" name="protection" value="decline" required><span>Decline the Rental Protection Plan</span></label></div></fieldset><label><span>Signer name</span><input name="signerName" autocomplete="name" maxlength="300" required value="${escapeHtml(contract.fields.lessee)}"></label><label class="mbr-consent"><input type="checkbox" name="consent" required checked><span>I have reviewed and agree to the full rental agreement, including the insurance requirements and waiver in sections 4 and 13, and I am authorized to sign for the lessee.</span></label><label for="mbrSignature">Your signature</label><p id="signatureHelp" class="mbr-field-help">Draw with your finger or mouse in the box below.</p><canvas id="mbrSignature" class="mbr-signature" tabindex="0" aria-label="Draw your signature" aria-describedby="signatureHelp">Draw your signature using a finger or mouse.</canvas><button type="button" data-action="clear">Clear signature</button><div class="mbr-actions"><button class="primary" type="submit">Sign agreement</button></div><p class="mbr-field-help">You can download your signed agreement after signing.</p></form></section>`;
}
async function sign(event) {
  event.preventDefault();
  const form=event.currentTarget;
  if(!form.reportValidity()) {return;}
  if(!pad.hasInk()) {notice('Please draw your signature before signing.','error');document.getElementById('mbrSignature').focus();return;}
  const values=new FormData(form),body={revision:contract.revision,protectionPlanAccepted:values.get('protection')==='accept',
    consent:values.get('consent')==='on',signerName:String(values.get('signerName')).trim(),signatureDataUrl:pad.dataUrl()};
  const fingerprint=JSON.stringify(body);
  if(!submissionId || fingerprint!==attemptFingerprint) {submissionId=crypto.randomUUID();attemptFingerprint=fingerprint;}
  const button=form.querySelector('[type=submit]');button.disabled=true;button.textContent='Signing…';notice('');
  try {
    const response=await fetch('/api/mbr/public/sign',{method:'POST',headers:{...headers,'content-type':'application/json'},
      body:JSON.stringify({...body,submissionId})});
    const result=await response.json();
    if(result.code==='MBR_CONTRACT_CHANGED') {
      await review('The agreement changed. Please review the updated terms, choose protection, and sign again.');
      window.scrollTo({top:0,behavior:'smooth'});return;
    }
    if(result.code==='MBR_COMPLETED') {await review('This agreement is already signed. You can download the signed copy below.');return;}
    if(!response.ok) {throw new Error(result.error || 'Could not sign. Please try again.');}
    await review('Your agreement is signed. Download your copy below.');
    window.scrollTo({top:0,behavior:'smooth'});
  } catch(error) {notice(error instanceof TypeError?'Connection interrupted. Your signature is still here. Please try again.':error.message,'error');}
  finally {button.disabled=false;button.textContent='Sign agreement';}
}
app.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button) {return;}
  if(button.dataset.action==='clear') {pad?.clear();return;}
  if(button.dataset.action==='pdf') {
    button.disabled=true;
    try {await downloadPdf(await fetch('/api/mbr/public/pdf',{headers,cache:'no-store'}));}
    catch(error) {notice(error.message,'error');}finally {button.disabled=false;}
  }
});
if(!/^[A-Za-z0-9_-]{43}$/u.test(token)) {app.innerHTML='<section class="mbr-card"><h2>Signing link unavailable</h2><p>Please ask MBR Sales for your signing link.</p></section>';}
else {review().catch(error=>{app.innerHTML='<section class="mbr-card"><h2>Signing link unavailable</h2><p>Please contact MBR Sales for help or a renewed link.</p></section>';notice(error.message,'error');});}
