(function(global){
  'use strict';
  let active=null;
  /** @param {SorSignatureDialogOptions} options */
  function open({terms='',orderRefs=[],preview=false,initial=null,onSave=async(_value)=>{},onRemove=null}={}) {
    if(active){return;}
    const previousFocus=/** @type {HTMLElement} */(document.activeElement);
    const dialog=document.createElement('dialog');
    dialog.className='sor-signature-dialog';
    dialog.innerHTML='<form method="dialog"><h2>Customer signature <small>(optional)</small></h2><p data-sor-refs></p><h3>Terms &amp; conditions</h3><div class="sor-signature-terms" tabindex="0"></div><label>Signer name (optional)<input name="signer" maxlength="300" autocomplete="name"></label><label>Signature<canvas width="900" height="320" aria-label="Draw customer signature" tabindex="0"></canvas></label><p role="status" data-sor-status></p><div class="sor-signature-actions"><button type="button" data-sor-clear>Clear</button><button type="button" data-sor-cancel>Cancel</button><button type="button" data-sor-save>Save signature</button></div></form>';
    dialog.querySelector('[data-sor-refs]').textContent=orderRefs.join(', ');
    dialog.querySelector('.sor-signature-terms').textContent=terms;
    const signer=/** @type {HTMLInputElement} */(dialog.querySelector('[name=signer]'));
    signer.value=initial?.signedBy || '';
    const canvas=dialog.querySelector('canvas');const ctx=canvas.getContext('2d');
    ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#182b39';ctx.lineWidth=3;ctx.lineCap='round';
    let drawing=false,hasInk=false,loadInitial=true;
    const point=event=>{const box=canvas.getBoundingClientRect();return {x:(event.clientX-box.left)*canvas.width/box.width,y:(event.clientY-box.top)*canvas.height/box.height};};
    canvas.addEventListener('pointerdown',event=>{loadInitial=false;drawing=true;canvas.setPointerCapture(event.pointerId);const p=point(event);ctx.beginPath();ctx.moveTo(p.x,p.y);event.preventDefault();});
    canvas.addEventListener('pointermove',event=>{if(!drawing){return;}const p=point(event);ctx.lineTo(p.x,p.y);ctx.stroke();hasInk=true;});
    for(const name of ['pointerup','pointercancel']){canvas.addEventListener(name,()=>{drawing=false;});}
    if(initial?.dataUrl){const img=new Image();img.onload=()=>{if(loadInitial){ctx.drawImage(img,0,0,canvas.width,canvas.height);hasInk=true;}};img.src=initial.dataUrl;}
    dialog.querySelector('[data-sor-clear]').addEventListener('click',()=>{loadInitial=false;ctx.fillRect(0,0,canvas.width,canvas.height);hasInk=false;});
    const close=()=>{dialog.close();dialog.remove();active=null;previousFocus?.focus();};
    dialog.querySelector('[data-sor-cancel]').addEventListener('click',close);
    if(onRemove){const remove=document.createElement('button');remove.type='button';remove.textContent='Remove saved signature';remove.onclick=async()=>{try{await onRemove();close();}catch(error){dialog.querySelector('[data-sor-status]').textContent=error.message;}};dialog.querySelector('.sor-signature-actions').prepend(remove);}
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    const saveButton=/** @type {HTMLButtonElement} */(dialog.querySelector('[data-sor-save]'));
    saveButton.addEventListener('click',async()=>{
      const status=dialog.querySelector('[data-sor-status]');
      if(!hasInk){status.textContent='Please draw a signature, or cancel to continue without signing.';return;}
      saveButton.disabled=true;
      try{
        if(!preview){await onSave({signedBy:signer.value.trim(),capturedAt:new Date().toISOString(),dataUrl:canvas.toDataURL('image/jpeg',0.9)});}
        close();
      }catch(error){status.textContent=error.message;saveButton.disabled=false;}
    });
    active=dialog;document.body.append(dialog);dialog.showModal();
  }
  global.SorSignature={open,isOpen:()=>Boolean(active)};
})(window);
