(() => {
  if(window.MBBSAlertSound) {return;}
  const contexts=new Set();
  let allowed=false,generation=0,unlocking=null;
  const available=()=>typeof (window.AudioContext || window.webkitAudioContext)==='function';
  function create() {
    const Type=window.AudioContext || window.webkitAudioContext;
    const context=new Type();contexts.add(context);return context;
  }
  function dispose(context) {
    contexts.delete(context);
    try {if(context.state!=='closed') {void context.close().catch(()=>{});}}catch {/* Audio failure leaves alerts usable. */}
  }
  async function resume(context) {
    let timer;
    try {
      return await Promise.race([
        context.resume().then(()=>context.state==='running'),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(false),500);})
      ]);
    } catch {return false;}
    finally {clearTimeout(timer);}
  }
  async function authorize(version) {
    let context;
    try {
      context=create();
      const running=await resume(context);
      if(version!==generation) {return false;}
      allowed=running;return allowed;
    } catch {return false;}
    finally {if(context) {dispose(context);}}
  }
  function unlock() {
    if(!available()) {return Promise.resolve(false);}
    if(allowed) {return Promise.resolve(true);}
    if(unlocking) {return unlocking;}
    const work=authorize(generation).finally(()=>{if(unlocking===work) {unlocking=null;}});
    unlocking=work;return work;
  }
  function bell(context,master,start,frequency,duration) {
    const oscillator=context.createOscillator(),gain=context.createGain();
    oscillator.type='triangle';
    oscillator.frequency.setValueAtTime(frequency,context.currentTime+start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency*1.18,context.currentTime+start+0.08);
    gain.gain.setValueAtTime(0.0001,context.currentTime+start);
    gain.gain.exponentialRampToValueAtTime(1,context.currentTime+start+0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001,context.currentTime+start+duration);
    oscillator.connect(gain);gain.connect(master);
    oscillator.start(context.currentTime+start);oscillator.stop(context.currentTime+start+duration+0.03);
  }
  async function play(isCurrent=()=>true) {
    if(!allowed || !isCurrent()) {return false;}
    const version=generation;
    let context;
    try {
      context=create();
      if(!await resume(context) || version!==generation || !isCurrent()) {dispose(context);return false;}
      const master=context.createGain();master.gain.setValueAtTime(1,context.currentTime);master.connect(context.destination);
      // Reuse the existing Operator playDeliveryDing waveform and timing.
      bell(context,master,0,1046.5,0.34);
      bell(context,master,0.18,1568,0.52);
      bell(context,master,0.28,2093,0.36);
      setTimeout(()=>dispose(context),1100);return true;
    } catch {if(context) {dispose(context);}return false;}
  }
  function reset() {
    generation++;allowed=false;unlocking=null;[...contexts].forEach(dispose);
  }
  window.MBBSAlertSound={available,ready:()=>allowed,unlock,play,reset};
})();
