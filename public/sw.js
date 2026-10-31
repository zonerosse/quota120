// Quota 120 senza rete: il programma (pagina, mappe, PDF, lettore DJI) resta sul telefono.
// I dati non passano di qui: /api/ va sempre in rete; i dati per lavorare senza rete li tiene la pagina.
const C = 'q120-v4';
const BASE = ['/', '/manifest.webmanifest', '/icon.svg', '/fonts/barlow.css', '/icon-180.png', '/icon-192.png',
  '/leaflet/leaflet.js', '/leaflet/leaflet.css', '/lib/jspdf.umd.min.js', '/lib/html2canvas.min.js', '/dji/dji_log_parser_js.mjs'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => Promise.all(BASE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/interno/') || u.pathname.startsWith('/corso/video/')) return;   // i video vanno sempre in rete (sono grandi e alcuni sono firmati)
    // la pagina: prima la rete (così arrivano gli aggiornamenti), senza rete quella salvata
    if (r.mode === 'navigate' || u.pathname === '/' || u.pathname === '/index.html') {
      e.respondWith(fetch(r).then(x => { if (x.ok) { const y = x.clone(); caches.open(C).then(c => c.put('/', y)); } return x; })
        .catch(() => caches.match('/')));
      return;
    }
    // il resto: subito quello salvato, intanto si aggiorna
    e.respondWith(caches.open(C).then(c => c.match(r).then(m => {
      const f = fetch(r).then(x => { if (x.ok) c.put(r, x.clone()); return x; }).catch(() => m);
      return m || f;
    })));
    return;
  }
});

// Android: «Condividi › Quota 120» dall'app File. I file vanno nella coda del telefono, la pagina li manda a «Voli arrivati».
function idbSW() { return new Promise((ok, no) => { const r = indexedDB.open('q120', 1); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('coda')) d.createObjectStore('coda', { keyPath: 'id' }); if (!d.objectStoreNames.contains('zone')) d.createObjectStore('zone', { keyPath: 'k' }); }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'POST' || u.origin !== location.origin || u.pathname !== '/condividi') return;
  e.respondWith((async () => {
    try {
      const fd = await r.formData(), files = fd.getAll('file').filter(f => f && f.size), d = await idbSW();
      await new Promise((ok, no) => { const t = d.transaction('coda', 'readwrite'), o = t.objectStore('coda');
        files.forEach((f, i) => o.put({ id: 'c' + Date.now() + '-' + i, disp: null, tipo: 'log', nome: f.name || 'volo.txt', mime: f.type || 'text/plain', blob: f, quando: new Date().toLocaleString('it-IT') }));
        t.oncomplete = ok; t.onerror = () => no(t.error); });
    } catch (x) {}
    return Response.redirect('/?condivisi=1', 303);
  })());
});
