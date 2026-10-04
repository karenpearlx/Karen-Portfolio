(() => {
  'use strict';
  if (location.pathname.startsWith('/admin') || navigator.doNotTrack === '1') return;
  const pageId = crypto.randomUUID();
  const params = new URLSearchParams(location.search);
  const utm = Object.fromEntries(['source','medium','campaign','term','content'].map(k => [k, params.get('utm_' + k) || '']));
  const base = {pageId, path: location.pathname, hostname: location.hostname, referrer: document.referrer, utm, screen: screen.width + 'x' + screen.height};
  let activeMs = 0;
  let visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
  function elapsed() { return Math.floor((activeMs + (visibleSince === null ? 0 : performance.now() - visibleSince)) / 1000); }
  function send(kind) {
    const payload = JSON.stringify({...base,kind,seconds:elapsed()});
    if (kind !== 'pageview' && navigator.sendBeacon) {
      if (navigator.sendBeacon('/api/track', new Blob([payload],{type:'application/json'}))) return;
    }
    fetch('/api/track',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:payload,keepalive:true}).catch(() => {});
  }
  send('pageview');
  setInterval(() => { if(document.visibilityState === 'visible') send('heartbeat'); },15000);
  document.addEventListener('visibilitychange',() => {
    if(document.visibilityState === 'hidden') {
      if(visibleSince !== null) { activeMs += performance.now()-visibleSince; visibleSince=null; }
      send('heartbeat');
    } else visibleSince=performance.now();
  });
  addEventListener('pagehide',() => send('heartbeat'));
  addEventListener('pageshow',e => { if(e.persisted) visibleSince=performance.now(); });
})();
