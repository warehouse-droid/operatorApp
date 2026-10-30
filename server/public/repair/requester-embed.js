(function(){
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.data?.type!=='mbbs-repair-requester-size')return;
    const height=Number(event.data.height);
    if(!Number.isFinite(height)||height<100||height>12000)return;
    for(const frame of document.querySelectorAll('iframe[data-repair-requester]')){
      if(frame.contentWindow===event.source)frame.style.height=`${Math.ceil(height)}px`;
    }
  });
})();
