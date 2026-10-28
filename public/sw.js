// Quota 120 senza rete: il programma (pagina, mappe, PDF, lettore DJI) resta sul telefono.
// I dati non passano di qui: /api/ va sempre in rete; i dati per lavorare senza rete li tiene la pagina.
const C = 'q120-v1';
const BASE = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-192.png',
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
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/interno/')) return;
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
  // caratteri di Google: salvati alla prima volta
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) {
    e.respondWith(caches.open(C).then(c => c.match(r).then(m => m || fetch(r).then(x => { c.put(r, x.clone()); return x; }))));
  }
});
