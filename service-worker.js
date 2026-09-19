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

self.addEventListener('fetch', function(e){
  e.respondWith(
    fetch(e.request).catch(function(){
      return caches.match(e.request);
    })
  );
});
