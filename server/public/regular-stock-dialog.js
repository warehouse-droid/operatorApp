(() => {
  let active=null;
  const t=(en,zh)=>window.RegularStockUI.t(en,zh);
  function begin(message,{lockFields=false}={}) {
    if(active)throw new Error(t('An operation is already in progress.','正在处理中，请稍候。'));
    const focus=document.activeElement,disabled=new Map();
    const dialog=document.createElement('dialog');dialog.className='regular-stock-dialog';
    dialog.setAttribute('aria-labelledby','regularStockDialogTitle');
    dialog.setAttribute('aria-describedby','regularStockDialogMessage');
    dialog.innerHTML='<div class="regular-dialog-icon" aria-hidden="true"></div><h2 id="regularStockDialogTitle" tabindex="-1"></h2><p id="regularStockDialogMessage" aria-live="polite" role="status"></p><p class="regular-dialog-expiry" aria-live="polite"></p><div class="regular-dialog-actions"></div>';
    const title=dialog.querySelector('h2'),text=dialog.querySelector('#regularStockDialogMessage'),actions=dialog.querySelector('.regular-dialog-actions'),expiry=dialog.querySelector('.regular-dialog-expiry');
    let mode='busy',settle=null,timer=null;
    const lockButtons=()=>{
      for(const button of document.querySelectorAll(lockFields?'button,input,select,textarea':'button')){
        if(dialog.contains(button))continue;
        if(!disabled.has(button))disabled.set(button,button.disabled);
        if(!button.disabled)button.disabled=true;
      }
    };
    const observer=new MutationObserver(lockButtons);
    const finish=answer=>{if(settle){const resolve=settle;settle=null;window.clearInterval(timer);resolve(answer);}};
    const operation={
      wait(message){
        finish(false);mode='busy';dialog.dataset.state='busy';dialog.setAttribute('aria-busy','true');
        title.textContent=t('Processing request','正在处理申请');text.textContent=message;
        expiry.textContent=t('Processing your request. Please wait.','正在处理您的申请，请稍候。');actions.replaceChildren();title.focus();
      },
      confirm(preview){
        mode='confirm';dialog.dataset.state='confirm';dialog.setAttribute('aria-busy','false');
        title.textContent=preview.action.mode==='location'?t('Confirm SO location change','确认销售订单地点变更'):t('Confirm Transfer Orders','确认调货单');
        text.textContent=window.RegularStockUI.confirmationMessage(preview.action,preview.resuming);
        actions.replaceChildren();
        const cancel=document.createElement('button');cancel.type='button';cancel.textContent=t('Cancel','取消');cancel.dataset.regularDialogCancel='';
        const confirm=document.createElement('button');confirm.type='button';confirm.className='primary';confirm.dataset.regularDialogConfirm='';
        confirm.textContent=preview.action.mode==='location'?t('Confirm location change','确认更改地点'):t('Confirm and issue TO','确认并开立调货单');
        actions.append(cancel,confirm);
        const updateExpiry=()=>{
          if(!preview.approvalExpiresAt){expiry.textContent='';return;}
          const seconds=Math.max(0,Math.ceil((new Date(preview.approvalExpiresAt).getTime()-Date.now())/1000));
          confirm.disabled=seconds===0;
          expiry.textContent=seconds?t(`Approval expires in ${Math.floor(seconds/60)}m ${seconds%60}s.`,`批准将在 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒后过期。`)
            :t('Approval expired. Cancel and re-raise the request.','批准已过期，请取消并重新提交申请。');
        };
        updateExpiry();timer=window.setInterval(updateExpiry,1000);cancel.focus();
        return new Promise(resolve=>{settle=resolve;cancel.onclick=()=>finish(false);confirm.onclick=()=>{
          updateExpiry();if(confirm.disabled||!settle)return;
          cancel.disabled=true;confirm.disabled=true;finish(true);
        };});
      },
      close(){
        finish(false);window.clearInterval(timer);observer.disconnect();dialog.close();dialog.remove();
        for(const [button,wasDisabled] of disabled)if(button.isConnected)button.disabled=wasDisabled;
        active=null;if(focus?.isConnected)focus.focus();
      }
    };
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(mode==='confirm')finish(false);});
    document.body.append(dialog);active=operation;lockButtons();observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
    dialog.showModal();operation.wait(message);return operation;
  }
  async function withBusy(message,work) {
    const operation=begin(message);
    try{return await work();}finally{operation.close();}
  }
  window.RegularStockDialog={begin,withBusy,isBusy:()=>!!active};
})();
