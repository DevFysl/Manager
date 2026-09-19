// Minimal service worker — mainly here so Android/Chrome will offer
// "Add to Home Screen" / "Install app". Always tries the network first
// (this app needs a live connection to Firestore anyway), and only
// falls back to a cached copy if the network request fails.

self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  self.clients.claim();
});

// Handles real Web Push messages sent from the backend (GitHub Actions job),
// which arrive here even if the app is fully closed and the phone is locked.
// This is what actually rings/shows the alert in that case — the in-app
// alert code only runs while a tab is open, so it can't be relied on alone.
self.addEventListener('push', function(event){
  let payload = {};
  try{
    payload = event.data ? event.data.json() : {};
  }catch(e){
    payload = { title: 'Contract Social Manager', options: { body: event.data ? event.data.text() : '' } };
  }

  const title = payload.title || 'Contract Social Manager';
  const options = payload.options || {};

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('fetch', function(e){
  e.respondWith(
    fetch(e.request).catch(function(){
      return caches.match(e.request);
    })
  );
});

// Handles taps on the notification itself, or on one of its action
// buttons ("Départ Pause", "Sortie", etc.). If the app is already open
// in a tab, we hand the action off to it via postMessage so it applies
// the change exactly as if you'd tapped the button inside the app. If
// no tab is open, we open one with the action encoded in the URL so the
// app can apply it as soon as it loads.
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const action = event.action || '';
  const data = event.notification.data || {};
  const badge = data.badge || '';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList){
      for(const client of clientList){
        if('focus' in client){
          client.postMessage({ type: 'notif-action', action: action, badge: badge });
          return client.focus();
        }
      }
      if(self.clients.openWindow){
        const url = './index.html' + (action ? ('?notifAction=' + encodeURIComponent(action) + '&notifBadge=' + encodeURIComponent(badge)) : '');
        return self.clients.openWindow(url);
      }
    })
  );
});
