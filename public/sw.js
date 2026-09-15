// 仓库里信号差的时候，让已经打开过的拣货单和照片还能看。
// 页面本身走「网络优先，失败回缓存」；照片走「缓存优先」（照片不会变）。
var CACHE = 'picking-v1';
var SHELL = ['/app.css', '/picker.js', '/manifest.webmanifest'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 登录、登出、写操作不缓存
  if (url.pathname === '/login' || url.pathname === '/logout' || url.pathname.startsWith('/api/')) return;

  // 照片：缓存优先
  if (url.pathname.startsWith('/media/')) {
    event.respondWith(caches.open(CACHE).then(function (cache) {
      return cache.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (res) {
          if (res.ok) cache.put(request, res.clone());
          return res;
        });
      });
    }));
    return;
  }

  // 其他：网络优先，断网时回缓存
  event.respondWith(fetch(request).then(function (res) {
    if (res.ok && (url.pathname === '/w' || url.pathname.startsWith('/w/') || SHELL.indexOf(url.pathname) >= 0)) {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(request).then(function (hit) {
      return hit || new Response('<main style="padding:2rem;font:16px system-ui">Sem conexão. Abra de novo quando tiver sinal.</main>',
        {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}});
    });
  }));
});
