(() => {
  if(window.MBBSAppEventStream) {return;}
  const streams=new Map();
  const capture=options=>typeof options==='boolean'?options:Boolean(options?.capture);
  function connect(path) {
    const target=new URL(path,location.origin);
    if(target.origin!==location.origin || target.pathname!=='/api/events') {throw new Error('Only local application events can be shared.');}
    const token=target.searchParams.get('token') || '',key=token;
    let stream=streams.get(key);
    if(!stream) {
      const url=new URL('/api/events',location.origin);url.searchParams.set('client','shared-alerts');
      if(token) {url.searchParams.set('token',token);}
      stream={source:new EventSource(url.pathname+url.search),subscribers:0};streams.set(key,stream);
    }
    stream.subscribers++;
    const listeners=[];let closed=false;
    return {
      addEventListener(type,listener,options) {
        if(closed || !listener || listeners.some(item=>item.type===type && item.listener===listener && capture(item.options)===capture(options))) {return;}
        const wrapped=event=>{
          if(options?.once) {this.removeEventListener(type,listener,options);}
          if(typeof listener==='function') {listener.call(this,event);} else {listener.handleEvent(event);}
        };
        listeners.push({type,listener,options,wrapped});stream.source.addEventListener(type,wrapped,options);
      },
      removeEventListener(type,listener,options) {
        for(let index=listeners.length-1;index>=0;index--) {
          const item=listeners[index];
          if(item.type===type && item.listener===listener && capture(item.options)===capture(options)) {
            stream.source.removeEventListener(type,item.wrapped,item.options);listeners.splice(index,1);
          }
        }
      },
      get readyState() {return closed?EventSource.CLOSED:stream.source.readyState;},
      close() {
        if(closed) {return;}
        closed=true;
        for(const item of listeners) {stream.source.removeEventListener(item.type,item.wrapped,item.options);}
        stream.subscribers--;
        if(stream.subscribers===0) {stream.source.close();streams.delete(key);}
      }
    };
  }
  window.MBBSAppEventStream={connect};
})();
