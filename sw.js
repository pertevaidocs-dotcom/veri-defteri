const CACHE='veri-defteri-shell-v6-1';
const SHELL=['./','./index.html','./routing.js?v=0601','./purchases.js?v=0601','./app.js?v=0601','./style.css?v=0601','./manifest.webmanifest','./icon.svg','./ai.js?v=0601','./webllm-local.js?v=0601'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('veri-defteri-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request,{cache:'no-cache'}).then(response=>{
      if(!response.ok)throw Error('Navigation failed');
      const copy=response.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put('./index.html',copy)));return response;
    }).catch(()=>caches.match('./index.html').then(hit=>hit||caches.match('./'))));
  }else e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request)));
});
