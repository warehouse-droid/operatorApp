(() => {
  if(window.MBBSAlertSound) {return;}
  const contexts=new Set();
  let allowed=false,generation=0,unlocking=null,selected=null,preset='default';
  const presets=Object.freeze([
    {id:'default',label:'Default ding'},
    {id:'bottle-open',label:'Bottle open',duration:0.5},
    {id:'classic-ding',label:'Classic ding',duration:1.4},
    {id:'soft-chime',label:'Soft chime',duration:1.3},
    {id:'bell',label:'Bell',duration:1.2},
    {id:'digital-beep',label:'Digital beep',duration:0.38},
    {id:'bubble-pop',label:'Bubble pop',duration:0.3}
  ].map(Object.freeze));
  const presetBuffers=new Map();
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
  // Original synthesized sounds: no external recordings, downloads or licence fees.
  function presetBuffer(context,id) {
    if(presetBuffers.has(id)) {return presetBuffers.get(id);}
    const definition=presets.find(item=>item.id===id);
    if(!definition?.duration) {return null;}
    const rate=44100,buffer=context.createBuffer(1,Math.ceil(rate*definition.duration),rate),samples=buffer.getChannelData(0);
    const sine=(frequency,time)=>Math.sin(2*Math.PI*frequency*time);
    const plop=(time,base,drop,speed)=>Math.sin(2*Math.PI*(base*time+drop*speed*(1-Math.exp(-time/speed))));
    const chime=(time,frequency)=>time<0?0:(1-Math.exp(-time/0.006))*(sine(frequency,time)*Math.exp(-4*time)+0.24*sine(frequency*2.76,time)*Math.exp(-8*time));
    const beep=(time,frequency)=>time<0 || time>0.11?0:sine(frequency,time)*Math.min(time/0.008,1,(0.11-time)/0.015);
    let seed=173,previousNoise=0,peak=0;
    for(let index=0;index<samples.length;index++) {
      const time=index/rate;
      let value=0;
      switch(id) {
        case 'bottle-open': {
          seed=(Math.imul(seed,1664525)+1013904223)>>>0;
          const noise=seed/2147483648-1,air=noise-previousNoise;previousNoise=noise;
          value=0.75*plop(time,220,1400,0.013)*Math.exp(-23*time)+0.2*air*Math.exp(-20*time);
          break;
        }
        case 'classic-ding': value=sine(880,time)*Math.exp(-3.5*time)+0.4*sine(1760,time)*Math.exp(-6*time)+0.16*sine(2400,time)*Math.exp(-8*time);break;
        case 'soft-chime': value=chime(time,523.25)+0.8*chime(time-0.18,783.99);break;
        case 'bell': value=sine(660,time)*Math.exp(-4*time)+0.5*sine(1821.6,time)*Math.exp(-7*time)+0.2*sine(3564,time)*Math.exp(-10*time);break;
        case 'digital-beep': value=beep(time,880)+beep(time-0.17,1174.66);break;
        case 'bubble-pop': value=plop(time,350,900,0.02)*Math.exp(-19*time);break;
      }
      samples[index]=value*Math.min(time/0.002,1,(definition.duration-time)/0.03);
      peak=Math.max(peak,Math.abs(samples[index]));
    }
    // Consistent preview volume with headroom; short fades prevent clicks.
    for(let index=0;index<samples.length;index++) {samples[index]*=0.5/Math.max(peak,0.0001);}
    presetBuffers.set(id,buffer);return buffer;
  }
  async function prepare(bytes) {
    let context;
    try {
      context=create();
      const buffer=await context.decodeAudioData(bytes);
      if(!Number.isFinite(buffer.duration) || buffer.duration<=0 || buffer.duration>10) {
        throw new Error('Choose a sound no longer than 10 seconds.');
      }
      return buffer;
    } finally {if(context) {dispose(context);}}
  }
  function stopPlayback() {
    generation++;unlocking=null;[...contexts].forEach(dispose);
  }
  function select(buffer) {stopPlayback();selected=buffer;preset='default';}
  function selectPreset(id) {
    if(!presets.some(item=>item.id===id)) {return false;}
    stopPlayback();selected=null;preset=id;return true;
  }
  async function play(isCurrent=()=>true) {
    if(!allowed || !isCurrent()) {return false;}
    const version=generation;
    let context;
    try {
      context=create();
      if(!await resume(context) || version!==generation || !isCurrent()) {dispose(context);return false;}
      const master=context.createGain();master.gain.setValueAtTime(1,context.currentTime);master.connect(context.destination);
      const buffer=selected || presetBuffer(context,preset);
      if(buffer) {
        const source=context.createBufferSource();source.buffer=buffer;source.connect(master);source.start();
        setTimeout(()=>dispose(context),Math.ceil(buffer.duration*1000)+100);return true;
      }
      // Reuse the existing Operator playDeliveryDing waveform and timing.
      bell(context,master,0,1046.5,0.34);
      bell(context,master,0.18,1568,0.52);
      bell(context,master,0.28,2093,0.36);
      setTimeout(()=>dispose(context),1100);return true;
    } catch {if(context) {dispose(context);}return false;}
  }
  function reset() {
    stopPlayback();allowed=false;selected=null;preset='default';
  }
  window.MBBSAlertSound={available,ready:()=>allowed,unlock,play,reset,prepare,select,selectPreset,presets,stopPlayback};
})();
