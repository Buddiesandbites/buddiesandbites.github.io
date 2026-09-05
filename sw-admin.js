/* Buddies & Bites — standards-based Web Push service worker.
 * Background/closed-app alerts use the browser/Android notification system.
 * Foreground clients receive a message so the Ledger can show its full-screen
 * overlay and tone.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function safeJson(event){
  try { return event.data ? event.data.json() : {}; } catch(e) { return {}; }
}

async function notifyVisibleClients(data){
  const list = await self.clients.matchAll({type:'window', includeUncontrolled:true});
  const visible = list.find(c => c.visibilityState === 'visible');
  if(visible){
    visible.postMessage({type:'BNB_PUSH_ORDER_ALERT', event:data.event || 'new', order:data});
    return true;
  }
  return false;
}

self.addEventListener('push', event => {
  event.waitUntil((async() => {
    const d=safeJson(event);
    if(d.cancelled==='true') return;

    // If the Ledger is currently visible, let the page own the full-screen
    // alert/tone. If it is backgrounded or closed, show a persistent OS notice.
    if(await notifyVisibleClients(d)) return;

    const isDue=d.event==='due';
    const title=isDue?'🚚 DELIVERY TIME REACHED':'🔔 NEW ORDER';
    const order=d.orderNumber || d.hungerbayOrderId || '';
    const customer=d.customerName || 'Customer';
    const item=d.description || d.flavour || 'New order';
    const body=order ? `#${order} · ${customer} · ${item}` : `${customer} · ${item}`;

    await self.registration.showNotification(title,{
      body,
      tag:`bnb-${d.event || 'order'}-${d.orderId || order}`,
      renotify:true,
      requireInteraction:true,
      vibrate:[300,150,300,150,600],
      data:{url:d.url || '/', orderId:d.orderId || '', event:d.event || 'new', order:d}
    });
  })());
});

self.addEventListener('notificationclick',event=>{
  const data=event.notification.data || {};
  event.notification.close();
  event.waitUntil((async()=>{
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of list){
      if('focus' in c){
        try{ c.postMessage({type:'BNB_PUSH_OPEN_ORDER',orderId:data.orderId || ''}); }catch(e){}
        return c.focus();
      }
    }
    return self.clients.openWindow(data.url || '/');
  })());
});

// A fetch handler must be registered for the PWA to remain installable, but
// this service worker doesn't cache anything (see install/activate above) —
// so it must never fall back to caches.match(), which always resolves to
// undefined here and crashes with "Failed to convert value to 'Response'"
// on any transient network hiccup. Let the browser handle requests normally.
self.addEventListener('fetch', () => {});
