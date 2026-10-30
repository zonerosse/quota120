// Quota 120 – gestionale per operatori di droni (prova).
// Cloudflare Worker: serve i file di «public» e le API /api/*; i dati stanno in un Durable Object (SQLite), niente database da creare.
//
// Accessi (stessa logica del gestionale dei cantieri):
//  - un solo indirizzo per tutti; ogni telefono o computer sceglie «Admin» oppure «Pilota»: il pilota scrive nome e cognome + matricola aziendale;
//  - l'Admin entra con il suo codice di 4 cifre (prova: 1234); il primo ingresso prepara i dati di esempio;
//  - un Operatore resta «In attesa dell'Admin» con un codice di 4 cifre: l'Admin lo approva;
//  - ogni dispositivo approvato ha una chiave segreta (id:chiave nell'intestazione X-Disp) e rientra da solo.
// Permessi: l'Admin vede e cambia tutto. Ogni operatore riceve solo quello che l'Admin gli ha concesso (vista)
// e quando salva il server prende solo i suoi voli e le sue verifiche delle zone (unisci).
// Documenti: si caricano su /api/doc, restano nel Durable Object a pezzi da 1 MB, Claude li legge (/api/doc/leggi)
// e con /api/doc/conferma vanno nella scheda giusta.
import { DurableObject } from "cloudflare:workers";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const cod4 = () => String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
const esc = (v, max = 500) => String(v == null ? "" : v).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c])).slice(0, max);
const DATA = v => /^\d{2}\/\d{2}\/\d{4}$/.test(v || "") ? v : "";
const oggi = () => { const n = new Date(); return String(n.getDate()).padStart(2, "0") + "/" + String(n.getMonth() + 1).padStart(2, "0") + "/" + n.getFullYear(); };
const PEZZO = 1000000;                       // byte per pezzo di documento
const MAXDOC = 10 * 1024 * 1024;             // 10 MB per documento
const TIPI_FILE = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "text/plain": "txt" };
const MODELLO = "claude-sonnet-5-5";         // Sonnet per leggere i documenti (non Haiku)
const DJI_KEYCHAINS = "https://dev.dji.com/openapi/v1/flight-records/keychains";   // chiavi per aprire i registri DJI dalla versione 13

// ---- ore e minuti scritti come «117 h 05 min» o «2 ore 55 min» ----
const minDi = s => { const t = String(s || ""), h = /(\d+)\s*(?:h|ore|ora)\b/.exec(t), m = /(\d+)\s*min/.exec(t); return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0); };
const hDi = m => { m = Math.max(0, Math.round(m)); return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min"; };
const oreDi = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), mi = m % 60; return (h ? h + (h === 1 ? " ora" : " ore") : "") + (h && mi ? " " : "") + (mi || !h ? mi + " min" : ""); };
const NUM = (v, min, max) => { const n = +v; return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0; };

// un volo letto dal registro DJI aggiorna da solo drone, manutenzione, batteria e pilota
function applicaVolo(d, v) {
  const min = v.min || 0, dr = (d.DRONI || []).find(x => x.nome === v.drone);
  if (dr && d.SCHEDE && d.SCHEDE[dr.id]) {
    const sc = d.SCHEDE[dr.id];
    sc.ore = hDi(minDi(sc.ore) + min); sc.voli = (+sc.voli || 0) + 1;
    if (sc.man) { const r = minDi(sc.man.mancano) - min; sc.man.mancano = r > 0 ? oreDi(r) : "da fare subito"; sc.man.liv = r <= 0 ? "ko" : r <= 300 ? "warn" : sc.man.liv === "ko" ? "warn" : sc.man.liv;
      if (r <= 300 && sc.man.liv === "ok") sc.man.liv = "warn"; }
  }
  // il numero di serie del drone resta come matricola: la volta dopo il volo si riconosce da solo
  if (dr && v.sn) { d.MATR = d.MATR || {}; if (!d.MATR[dr.nome]) d.MATR[dr.nome] = String(v.sn).slice(0, 40); }
  const b = (d.BATT || []).find(x => x.id === v.batt);
  if (b) { b.cicli = (+b.cicli || 0) + 1; b.ultimo = v.data; if (v.bsn && !b.sn) b.sn = v.bsn;
    if (Array.isArray(v.celle) && v.celle.length) b.celle = v.celle.slice(0, 14);
    if (v.dev > 0.1) b.stato = "warn"; }
  const p = (d.PILOTI || []).find(x => x.nome === v.pilota);
  if (p) { const sp = (d.SCHEDEP = d.SCHEDEP || {})[p.id] = (d.SCHEDEP || {})[p.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
    sp.ore = hDi(minDi(sp.ore) + min); sp.voli = (+sp.voli || 0) + 1; sp.ore90 = hDi(minDi(sp.ore90) + min); }
  return d;
}
// toglie un volo: ore, voli e cicli tornano come prima (solo se il volo era stato contato)
function togliVolo(d, v) {
  if (!(v.contato || (v.importato && v.stato === "completo"))) return d;
  const min = v.min || 0, dr = (d.DRONI || []).find(x => x.nome === v.drone), giu = (h, m) => hDi(Math.max(0, minDi(h) - m));
  if (dr && d.SCHEDE && d.SCHEDE[dr.id]) { const sc = d.SCHEDE[dr.id]; sc.ore = giu(sc.ore, min); sc.voli = Math.max(0, (+sc.voli || 0) - 1);
    if (sc.man && minDi(sc.man.mancano) > 0) sc.man.mancano = oreDi(minDi(sc.man.mancano) + min); }
  const b = (d.BATT || []).find(x => x.id === v.batt); if (b) b.cicli = Math.max(0, (+b.cicli || 0) - 1);
  const p = (d.PILOTI || []).find(x => x.nome === v.pilota), sp = p && (d.SCHEDEP || {})[p.id];
  if (sp) { sp.ore = giu(sp.ore, min); sp.voli = Math.max(0, (+sp.voli || 0) - 1); sp.ore90 = giu(sp.ore90, min); }
  return d;
}
// i campi di un volo letto dal registro, ripuliti
function pulisciLetto(v) {
  return { letto: !!v.letto, quotaMax: NUM(v.quotaMax, 0, 9999), oltre120: NUM(v.oltre120, 0, 99999), km: NUM(v.km, 0, 9999), velMax: NUM(v.velMax, 0, 999),
    foto: NUM(v.foto, 0, 99999), video: NUM(v.video, 0, 9999), videoS: NUM(v.videoS, 0, 999999), cIni: NUM(v.cIni, 0, 100), cFin: NUM(v.cFin, 0, 100), tMax: NUM(v.tMax, -50, 150),
    dev: NUM(v.dev, 0, 5), celle: Array.isArray(v.celle) ? v.celle.slice(0, 14).map(x => NUM(x, 0, 10)) : [], batt: esc(v.batt, 40), bsn: esc(v.bsn, 60),
    sn: esc(v.sn, 60), logKey: esc(v.logKey, 120), fine: esc(v.fine, 5), sec: NUM(v.sec, 0, 86400),
    prof: Array.isArray(v.prof) ? v.prof.slice(0, 160).map(x => Math.round(NUM(x, -999, 9999))) : [],
    trk: Array.isArray(v.trk) ? v.trk.slice(0, 420).filter(p => Array.isArray(p) && p.length >= 2).map(p => [NUM(p[0], -90, 90), NUM(p[1], -180, 180), Math.round(NUM(p[2], -999, 9999))]) : [],
    distMax: NUM(v.distMax, 0, 999999), haTrk: !!v.haTrk, daFoto: !!v.daFoto, fotoDoc: esc(v.fotoDoc, 40) };
}

// ---- zone di volo D-Flight: il file ufficiale (formato europeo) caricato dall'Admin, il controllo del punto ----
const ZR = { P: "vietata", A: "serve un'autorizzazione", C: "con condizioni", N: "solo informazione" };
function metriXY(lat0) { const k = Math.PI / 180, R = 6371000; return (la, lo, la1, lo1) => [(lo - lo1) * k * R * Math.cos(lat0 * k), (la - la1) * k * R]; }
// distanza (m) dal punto alla zona: 0 se ci sei dentro
function distZona(z, lat, lon) {
  const xy = metriXY(lat); let best = Infinity;
  for (const g of z.g || []) {
    if (g.t === "c") { const [x, y] = xy(g.c[0], g.c[1], lat, lon); best = Math.min(best, Math.max(0, Math.hypot(x, y) - g.r)); continue; }
    const P = (g.c || []).map(q => xy(q[0], q[1], lat, lon)); if (P.length < 3) continue;
    let dentro = false, dmin = Infinity;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i], [xj, yj] = P[j];
      if ((yi > 0) !== (yj > 0) && 0 < (xj - xi) * (0 - yi) / (yj - yi) + xi) dentro = !dentro;
      const dx = xj - xi, dy = yj - yi, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, -(xi * dx + yi * dy) / l2)) : 0;
      dmin = Math.min(dmin, Math.hypot(xi + t * dx, yi + t * dy));
    }
    best = Math.min(best, dentro ? 0 : dmin);
  }
  return best;
}
function versoZona(z, lat, lon) {
  const b = z.b || [lat, lon, lat, lon], cl = (b[0] + b[2]) / 2, co = (b[1] + b[3]) / 2, a = Math.atan2((co - lon) * Math.cos(lat * Math.PI / 180), cl - lat) * 180 / Math.PI;
  return ["nord", "nord-est", "est", "sud-est", "sud", "sud-ovest", "ovest", "nord-ovest"][Math.round(((a + 360) % 360) / 45) % 8];
}
function attivaOra(z) { const t = Date.now(); return !((z.da && Date.parse(z.da) > t) || (z.a && Date.parse(z.a) < t)); }
function controllaZone(Z, lat, lon) {
  const dentro = [], vicino = [], DEG = 0.02;
  for (const z of Z) {
    const b = z.b; if (b && (lat < b[0] - DEG || lat > b[2] + DEG || lon < b[1] - DEG * 1.5 || lon > b[3] + DEG * 1.5)) continue;
    if (!attivaOra(z)) continue;
    const d = distZona(z, lat, lon); if (d > 1000) continue;
    (d === 0 ? dentro : vicino).push(Object.assign({}, z, { dist: Math.round(d), verso: d ? versoZona(z, lat, lon) : "" }));
  }
  let liv = "ok", max = 120; const motivi = [];
  for (const z of dentro) {
    const lo = +z.lo || 0;
    if (z.r === "N" || lo >= 120) continue;
    if (lo > 0) { max = Math.min(max, lo); if (liv === "ok") liv = "warn"; continue; }
    if (z.r === "P" || z.r === "A") { liv = "ko"; motivi.push(z.r); } else if (liv === "ok") liv = "warn";
  }
  vicino.sort((a, b) => a.dist - b.dist);
  return { liv, max, motivi, dentro: dentro.slice(0, 12), vicino: vicino.slice(0, 8) };
}

// ---- segnalazioni di incidenti e guasti (regole del foglio ENAC SPL 21: ENAC su ECCAIRS 2 entro 72 ore; incidenti gravi anche ANSV, subito) ----
const SG_TIPI = { perso: "Il drone è volato via o è andato perso", segnale: "Perdita del segnale (il drone è tornato)", urto: "Urto o caduta", aereo: "Aereo o elicottero vicino (quasi collisione)", guasto: "Guasto del drone o della batteria", fuori: "Uscito dalla zona autorizzata o sopra i 120 m", altro: "Altro" };
function livSegn(x) { const grave = !!x.feriti || x.tipo === "perso" || x.tipo === "aereo"; return grave ? "grave" : ["segnale", "urto", "guasto", "fuori"].includes(x.tipo) ? "enac" : "facolt"; }

// ---- permessi ----
const permDi = (d, n) => { const p = (d.PILOTI || []).find(x => x.nome === n); return p ? ((d.PERM || {})[p.id] || {}) : {}; };
const pilotaDi = (d, n) => (d.PILOTI || []).find(x => x.nome === n);
// nome e matricola si confrontano senza badare a maiuscole, spazi in più e accenti
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const ASPETTI = ["A", "B", "C"];                // Cabina, Plancia, Flotta
const ASP_BASE = "B";                           // di base: Plancia

// cosa riceve l'operatore n: solo quello che l'Admin gli ha concesso
function vista(d, n) {
  const P = permDi(d, n), me = pilotaDi(d, n), v = {};
  // sempre: i droni (servono al controllo prima del volo), lui stesso, l'operatore, i suoi voli e i suoi permessi
  v.OP = Object.assign({}, d.OP, { firma: undefined }); v.MATR = d.MATR;
  v.DRONI = d.DRONI;
  v.ASSIC = { scad: (d.ASSIC || {}).scad, ok: (d.ASSIC || {}).ok };
  v.AUT_ENAC = { agricola: !!(d.AUT_ENAC || {}).agricola };
  // la matricola serve per entrare: ognuno vede solo la sua
  v.PILOTI = (P.documenti ? (d.PILOTI || []) : (me ? [me] : [])).map(p => p === me ? p : Object.assign({}, p, { matr: undefined }));
  v.SCHEDEP = {}; for (const p of v.PILOTI) if ((d.SCHEDEP || {})[p.id]) v.SCHEDEP[p.id] = d.SCHEDEP[p.id];
  v.PATENTINO = {}; for (const p of v.PILOTI) if ((d.PATENTINO || {})[p.id]) v.PATENTINO[p.id] = d.PATENTINO[p.id];
  v.VOLI = P.voliTutti ? d.VOLI : (d.VOLI || []).filter(x => x.pilota === n);
  v.ZONE = P.enac ? d.ZONE : (d.ZONE || []).filter(x => x.pilota === n);
  v.PERM = me ? { [me.id]: (d.PERM || {})[me.id] || {} } : {};
  // a scelta dell'Admin
  if (P.flotta) { v.SCHEDE = d.SCHEDE; v.BATT = d.BATT; v.INV = d.INV; }
  if (P.clienti && P.prezzi) v.CLIDATI = d.CLIDATI;
  if (P.clienti) { v.CLIENTI = d.CLIENTI; v.LAVORI = (d.LAVORI || []).map(l => P.prezzi ? l : Object.assign({}, l, { importo: null })); }
  // i lavori assegnati a lui li vede sempre (senza prezzi né fatture), anche senza il permesso «clienti»
  if (!P.clienti && me) v.LAVORI = (d.LAVORI || []).filter(l => l.pilota === me.id).map(l => ({ id: l.id, codice: l.codice, cliente: l.cliente, titolo: l.titolo, tipo: l.tipo, luogo: l.luogo, data: l.data, drone: l.drone, pilota: l.pilota, stato: l.stato, missione: l.missione, importo: null }));
  if (P.prezzi) v.PREV = d.PREV;
  if (P.enac) { v.AUT_ENAC = d.AUT_ENAC; v.DOMANDA = d.DOMANDA; v.ASSIC = d.ASSIC; }
  if (P.agri) { v.CAMPI = d.CAMPI; v.TRATT = d.TRATT; if (!v.CLIENTI) v.CLIENTI = d.CLIENTI; }
  v.DOCS = (d.DOCS || []).filter(x => docVisibile(d, x, n));
  v.ZONEINFO = d.ZONEINFO || null;
  if (d.CHECK) v.CHECK = d.CHECK;
  v.RISCHI = d.RISCHI || [];
  // segnalazioni: le sue per intero; degli altri solo i droni fermi
  v.SEGN = (d.SEGN || []).map(x => x.pilota === n ? x : (x.fermo ? { id: x.id, drone: x.drone, data: x.data, tipo: x.tipo, fermo: true } : null)).filter(Boolean);
  return v;
}
function docVisibile(d, doc, n) {
  const P = permDi(d, n), me = pilotaDi(d, n);
  if (doc.da === n) return true;
  if (doc.dest && doc.dest.k === "pilota") return (me && doc.dest.id === me.id) || !!P.documenti;
  if (doc.dest && doc.dest.k === "drone") return !!P.flotta;
  return !!P.enac;
}
// quello che manda l'operatore n: si prendono solo i suoi voli e le sue verifiche delle zone, ripuliti
function pulisciMissione(x) {
  if (!x || typeof x !== "object") return null;
  const pt = a => Array.isArray(a) && a.length === 2 && isFinite(+a[0]) && isFinite(+a[1]) && Math.abs(+a[0]) <= 90 && Math.abs(+a[1]) <= 180 ? [+(+a[0]).toFixed(7), +(+a[1]).toFixed(7)] : null;
  const pts = (Array.isArray(x.pts) ? x.pts : []).slice(0, 200).map(pt).filter(Boolean);
  const num = (v, a, b, def) => { v = +v; return isFinite(v) ? Math.max(a, Math.min(b, v)) : def; };
  return { tipo: ["area", "percorso", "punti"].includes(x.tipo) ? x.tipo : "area", pts, home: pt(x.home), quota: num(x.quota, 10, 120, 80), fo: num(x.fo, 50, 90, 80), fs: num(x.fs, 50, 90, 70),
    vel: num(x.vel, 0, 15, 0), giro: !!x.giro, fine: ["goHome", "noAction", "autoLand"].includes(x.fine) ? x.fine : "goHome", gimbal: num(x.gimbal, -90, 0, -90), drone: +x.drone || null, il: String(x.il || "").slice(0, 10) };
}
function unisci(full, m, n) {
  const d = JSON.parse(JSON.stringify(full));
  const vecchi = new Map((d.VOLI || []).map(v => [String(v.id), v]));
  for (const v of (m.VOLI || []).slice(0, 2000)) {
    if (!v || v.pilota !== n) continue;
    const id = String(v.id || ""); if (!/^\d{1,16}$/.test(id)) continue;
    const o = vecchi.get(id);
    if (o && o.pilota !== n) continue;                       // non può toccare i voli degli altri
    const pulito = { id: +id, data: DATA(v.data) || oggi(), ora: esc(v.ora, 5), drone: esc(v.drone, 80), pilota: n, luogo: esc(v.luogo, 120),
      min: Math.max(0, Math.min(600, +v.min || 0)), stato: ["completo", "dacompl", "attesa"].includes(v.stato) ? v.stato : "dacompl",
      ctrl: !!v.ctrl, ctrlOra: esc(v.ctrlOra, 5), cliente: esc(v.cliente, 200), note: esc(v.note, 2000), importato: !!v.importato, amano: !!v.amano,
      cat: esc(v.cat, 60), inc: esc(v.inc, 60), codLav: esc(v.codLav, 20), meteo: esc(v.meteo, 160), zona: esc(v.zona, 200), notam: esc(v.notam, 300), ck: esc(v.ck, 400), dopo: v.dopo && typeof v.dopo === "object" ? { drone: !!v.dopo.drone, batt: !!v.dopo.batt, succ: !!v.dopo.succ } : undefined, docLog: (o && o.docLog) || esc(v.docLog, 40), logNome: esc(v.logNome, 120) };
    // i dati letti dal registro li scrive solo il server (/api/volo/importa): il telefono non li può cambiare
    if (o && o.letto) Object.assign(pulito, pulisciLetto(o), { drone: o.drone, data: o.data, ora: o.ora, min: o.min, pilota: o.pilota });
    if (o) Object.assign(o, pulito); else { d.VOLI = d.VOLI || []; d.VOLI.unshift(pulito); }
  }
  const zk = z => z.data + "|" + z.ora + "|" + z.drone + "|" + z.pilota, zs = new Set((d.ZONE || []).map(zk));
  for (const z of (m.ZONE || []).slice(0, 50)) {
    if (!z || z.pilota !== n) continue;
    const pz = { data: DATA(z.data) || oggi(), ora: esc(z.ora, 5), drone: esc(z.drone, 80), pilota: n, esito: esc(z.esito, 200) };
    if (!zs.has(zk(pz))) { d.ZONE = d.ZONE || []; d.ZONE.unshift(pz); zs.add(zk(pz)); }
  }
  d.ZONE = (d.ZONE || []).slice(0, 2000);
  // polizza RC personale: il pilota cambia solo la sua; la verifica e il documento li tiene il server
  const me = pilotaDi(d, n), mp = me && ((m.SCHEDEP || {})[me.id] || {}).polizza;
  if (me && m.SCHEDEP && (m.SCHEDEP[me.id] || m.SCHEDEP[String(me.id)])) {
    const sp = (d.SCHEDEP = d.SCHEDEP || {})[me.id] = d.SCHEDEP[me.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} }, o = sp.polizza;
    if (mp && typeof mp === "object") {
      const q = { comp: esc(mp.comp, 80), num: esc(mp.num, 60), mass: esc(mp.mass, 40), scad: DATA(mp.scad) || "" };
      if (o && o.doc) q.doc = o.doc;
      if (o && o.ver && o.scad === q.scad && o.num === q.num) q.ver = o.ver;
      sp.polizza = q;
    } else if (o) delete sp.polizza;
  }
  // telefono ed email del pilota: li scrive lui nel suo Account
  if (me && m.SCHEDEP) {
    const x = m.SCHEDEP[me.id] || m.SCHEDEP[String(me.id)];
    if (x && typeof x === "object") { const sp = (d.SCHEDEP = d.SCHEDEP || {})[me.id] = d.SCHEDEP[me.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
      if (typeof x.tel === "string") sp.tel = esc(x.tel, 30); if (typeof x.email === "string") sp.email = EMAIL(x.email) ? x.email.trim().slice(0, 120) : "";       if (x.dfOk && typeof x.dfOk === "object") sp.dfOk = { il: DATA(x.dfOk.il) || oggi() }; else if ("dfOk" in sp) delete sp.dfOk; }
  }
  // la firma del pilota: la mette solo lui, dal suo telefono (immagine PNG piccola)
  if (me && m.SCHEDEP) {
    const f = ((m.SCHEDEP[me.id] || m.SCHEDEP[String(me.id)] || {}).firma) || null;
    const sp = (d.SCHEDEP = d.SCHEDEP || {})[me.id] = d.SCHEDEP[me.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
    if (f && typeof f.img === "string" && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(f.img) && f.img.length <= 80000) sp.firma = { img: f.img, il: DATA(f.il) || oggi() };
  }
  // manutenzioni: i piloti con il permesso «Droni, batterie e manutenzioni» registrano gli interventi
  if (permDi(d, n).flotta && m.SCHEDE && typeof m.SCHEDE === "object") {
    for (const dr of d.DRONI || []) {
      const x = m.SCHEDE[dr.id] || m.SCHEDE[String(dr.id)], sc = (d.SCHEDE || {})[dr.id]; if (!x || !sc || !Array.isArray(x.storia)) continue;
      const ha = new Set((sc.storia || []).map(r => JSON.stringify(r))), nuovi = [];
      for (const r of x.storia.slice(0, 10)) { if (!Array.isArray(r) || ha.has(JSON.stringify(r))) continue; const p = [DATA(r[0]) || oggi(), esc(r[1], 300)]; if (!/registrato da /.test(p[1])) p[1] += " · registrato da " + n; nuovi.push(p); }
      if (!nuovi.length) continue;
      sc.storia = nuovi.concat(sc.storia || []).slice(0, 200);
      if (x.man && typeof x.man === "object") sc.man = Object.assign(sc.man || {}, { perc: Math.max(0, Math.min(100, +x.man.perc || 0)), liv: ["ok", "warn", "ko"].includes(x.man.liv) ? x.man.liv : (sc.man || {}).liv, mancano: esc(x.man.mancano, 40), prox: esc(x.man.prox, 120) });
      const md = (m.DRONI || []).find(y => y && y.id === dr.id); if (md && ["ok", "warn", "ko"].includes(md.manut)) dr.manut = md.manut;
    }
  }
  // missione pianificata: il pilota la salva nei lavori assegnati a lui (o in tutti, con il permesso «clienti»)
  for (const x of (m.LAVORI || []).slice(0, 500)) {
    if (!x || !x.missione) continue;
    const l = (d.LAVORI || []).find(y => y.id === x.id); if (!l || !(permDi(d, n).clienti || (me && l.pilota === me.id))) continue;
    const ms = pulisciMissione(x.missione); if (ms) { ms.da = n; l.missione = ms; }
  }
  // confini dei campi: i piloti con il permesso «agricoltura» li possono mettere (anche camminando il bordo)
  if (permDi(d, n).agri) for (const x of (m.CAMPI || []).slice(0, 500)) {
    if (!x || !Array.isArray(x.geo)) continue; const c = (d.CAMPI || []).find(y => y.id === x.id); if (!c) continue;
    const geo = x.geo.slice(0, 500).filter(p => Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1]) && Math.abs(+p[0]) <= 90 && Math.abs(+p[1]) <= 180).map(p => [+(+p[0]).toFixed(7), +(+p[1]).toFixed(7)]);
    if (geo.length >= 3 && JSON.stringify(geo) !== JSON.stringify(c.geo || [])) { c.geo = geo; c.ha = Math.max(0, Math.min(100000, +x.ha || 0)); c.confini = true; delete c.poly; }
  }
  // valutazioni del rischio: il pilota aggiunge o cambia solo le sue
  const rv = new Map((d.RISCHI || []).map(r => [r.id, r]));
  for (const r of (m.RISCHI || []).slice(0, 300)) {
    if (!r || typeof r !== "object" || !/^R[a-z0-9]{4,14}$/.test(String(r.id || ""))) continue;
    const o = rv.get(r.id); if (o && o.firma !== n) continue;
    const t = JSON.stringify(r); if (t.length > 30000) continue;
    const pulito = JSON.parse(t.replace(/[<>]/g, "")); pulito.firma = n;
    if (o) Object.assign(o, pulito); else { d.RISCHI = d.RISCHI || []; d.RISCHI.unshift(pulito); rv.set(r.id, pulito); }
  }
  return d;
}

// ---- dopo la conferma di un documento: lo si mette nella scheda giusta ----
function applicaDoc(d, doc) {
  const s = doc.dest || {}, c = doc.dati || {};
  if (s.k === "pilota") {
    const sp = (d.SCHEDEP = d.SCHEDEP || {})[s.id] = (d.SCHEDEP || {})[s.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
    if (["A1-A3", "A2", "STS-01"].includes(s.voce)) {
      sp.att[s.voce] = Object.assign(sp.att[s.voce] || {}, { num: esc(c.numero, 60) || (sp.att[s.voce] || {}).num || "", ril: DATA(c.rilascio) || (sp.att[s.voce] || {}).ril || "", scad: DATA(c.scadenza) || (sp.att[s.voce] || {}).scad || "", file: true, doc: doc.id });
      const p = (d.PILOTI || []).find(x => x.id === s.id); if (p) { p.att = p.att || []; if (!p.att.includes(s.voce)) p.att.push(s.voce); if (s.voce === "STS-01") p.sts = true; }
    }
    if (s.voce === "polizza") { const q = sp.polizza || {};
      sp.polizza = { comp: esc(c.compagnia, 80) || q.comp || "", num: esc(c.numero, 60) || q.num || "", mass: esc(c.massimale, 40) || q.mass || "", scad: DATA(c.scadenza) || q.scad || "", doc: doc.id }; }
    if (s.voce === "patentino") { (d.PATENTINO = d.PATENTINO || {})[s.id] = DATA(c.scadenza) ? "scade il " + c.scadenza : "presente"; }
  }
  if (s.k === "drone") {
    const sc = (d.SCHEDE || {})[s.id]; if (sc) { sc.doc = sc.doc || {}; if (["qr", "classe", "manuale", "fattura"].includes(s.voce)) sc.doc[s.voce] = true; sc.docIds = sc.docIds || {}; sc.docIds[s.voce] = doc.id; }
  }
  if (s.k === "operatore") {
    if (s.voce === "assicurazione") { d.ASSIC = Object.assign(d.ASSIC || {}, { scad: DATA(c.scadenza) || (d.ASSIC || {}).scad, ok: true, doc: doc.id }); }
    if (s.voce === "autorizzazione") { d.AUT_ENAC = Object.assign(d.AUT_ENAC || {}, { agricola: true, doc: doc.id }); if (d.DOMANDA) d.DOMANDA.stato = "approvata"; }
    if (s.voce === "dflight") { d.OP = Object.assign(d.OP || {}, { dfDoc: doc.id }); if (DATA(c.scadenza)) d.OP.dfAbb = c.scadenza; }
  }
  return d;
}

// ---- lettura del documento con Claude ----
async function leggiConClaude(env, b64, mime, d) {
  const piloti = (d.PILOTI || []).map(p => p.id + " = " + p.nome).join("; ");
  const droni = (d.DRONI || []).map(x => x.id + " = " + x.nome + " (matricola " + ((d.MATR || {})[x.nome] || "?") + ")").join("; ");
  const sistema = "Leggi un documento di un operatore di droni italiano (attestati di pilota ENAC, patentino fitosanitario, polizza assicurativa, autorizzazioni ENAC, registrazione D-Flight, fatture, manuali, foto del QR, ricevute di manutenzione). " +
    "Leggi TUTTO quello che c'è scritto, con tutti i valori, e catalogalo per categoria (per esempio Titolare, Documento, Validità, Copertura, Droni, Prodotto). " +
    "Le date sempre nel formato GG/MM/AAAA. Non inventare nulla: se un valore non c'è, non metterlo. " +
    "Piloti dell'operatore: " + (piloti || "nessuno") + ". Droni dell'operatore: " + (droni || "nessuno") + ". " +
    "Rispondi SOLO con un oggetto JSON, senza altro testo, con questa forma: " +
    '{"tipo":"nome del tipo di documento in italiano","categorie":{"Nome categoria":[["voce","valore"]]},' +
    '"dest":{"k":"pilota|drone|operatore|altro","id":numero o null,"voce":"A1-A3|A2|STS-01|patentino|polizza|qr|classe|manuale|fattura|manutenzione|assicurazione|autorizzazione|dflight|altro"},' +
    '"dati":{"numero":"","rilascio":"","scadenza":"","compagnia":"","massimale":""}}. ' +
    'Una polizza o quietanza RC intestata a una persona che è tra i piloti va a k=pilota, voce=polizza; una intestata alla ditta va a k=operatore, voce=assicurazione. ' +
    'Per le polizze la scadenza è la fine del periodo pagato (copertura valida fino al), non la data di emissione.';
  const blocco = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELLO, max_tokens: 4000, system: sistema, messages: [{ role: "user", content: [blocco, { type: "text", text: "Leggi questo documento." }] }] }) });
  if (!r.ok) throw new Error("Lettura non riuscita (" + r.status + ")");
  const j = await r.json(), txt = (j.content || []).map(c => c.text || "").join("");
  return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
}
// ---- lettura della schermata del riepilogo di un volo (app DJI) ----
async function leggiFotoVolo(env, b64s, mime, droni) {
  const sistema = "Ti arriva la schermata (o la foto) del riepilogo di UN volo da un'app DJI (DJI Fly, DJI Pilot 2, app Agras) o da un radiocomando DJI. " +
    "Leggi solo quello che c'è scritto, senza inventare. Converti le unità: piedi in metri, miglia in km, mph in km/h. " +
    "Droni dell'operatore: " + (droni || "nessuno") + ". Se il nome del drone nella foto corrisponde a uno di questi, mettilo in droneOperatore con il nome esatto della lista. " +
    "Rispondi SOLO con un oggetto JSON: {\"ok\":true|false,\"motivo\":\"se ok è false: cosa manca o perché non è un riepilogo di volo\"," +
    "\"data\":\"GG/MM/AAAA\",\"ora\":\"HH:MM (decollo)\",\"durataSec\":numero,\"distanzaKm\":numero,\"quotaMaxM\":numero,\"distMaxM\":numero," +
    "\"velMaxKmh\":numero,\"foto\":numero di foto,\"video\":numero di video,\"caricaIni\":% batteria al decollo,\"caricaFin\":% batteria all'atterraggio,\"droneFoto\":\"nome del drone come scritto\",\"droneOperatore\":\"nome dalla lista o vuoto\",\"luogo\":\"se scritto\"} " +
    "Metti null per i valori che non si leggono.";
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELLO, max_tokens: 1200, system: sistema, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: b64s } }, { type: "text", text: "Leggi il riepilogo di questo volo." }] }] }) });
  if (!r.ok) throw new Error("Lettura non riuscita (" + r.status + ")");
  const j = await r.json(), txt = (j.content || []).map(c => c.text || "").join("");
  return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
}
// ---- avvisi via email per le scadenze (Brevo, gratis fino a 300 mail al giorno) ----
const dtS = s => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ""); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null; };
function oggiRoma() { const p = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date()); const g = k => +(p.find(x => x.type === k) || {}).value; return { data: String(g("day")).padStart(2, "0") + "/" + String(g("month")).padStart(2, "0") + "/" + g("year"), ora: g("hour") % 24, t: Date.UTC(g("year"), g("month") - 1, g("day")) }; }
// le scadenze: [chiave, testo, dettaglio, data, id pilota o null]
function scadenze(d) {
  const L = [], piloti = d.PILOTI || [];
  for (const p of piloti) {
    for (const [k, a] of Object.entries(((d.SCHEDEP || {})[p.id] || {}).att || {})) if (a.scad) L.push(["att|" + p.id + "|" + k, "Attestato " + k + " di " + p.nome, "scade il " + a.scad + " · senza, " + p.nome.split(" ")[0] + " non può volare con i droni che lo richiedono", a.scad, p.id]);
    const pt = (d.PATENTINO || {})[p.id]; if (pt && dtS(pt)) L.push(["pat|" + p.id, "Patentino fitosanitario di " + p.nome, pt, (/(\d{2}\/\d{2}\/\d{4})/.exec(pt) || [])[1], p.id]);
  }
  for (const p of piloti) { const q = ((d.SCHEDEP || {})[p.id] || {}).polizza;
    if (q && dtS(q.scad)) L.push(["pol|" + p.id + "|" + q.scad, "Polizza RC personale di " + p.nome, "scade il " + q.scad + " · carica la quietanza nuova quando la rinnova", q.scad, p.id]); }
  if ((d.ASSIC || {}).scad) L.push(["assic", "Polizza RC aziendale", "scade il " + d.ASSIC.scad, d.ASSIC.scad, null]);
  if ((d.OP || {}).dfAbb) L.push(["dflight", "Abbonamento D-Flight", "scade il " + d.OP.dfAbb, d.OP.dfAbb, null]);
  for (const l of d.LAVORI || []) if (l.fatt && !l.pagato && dtS(l.scad)) L.push(["pag|" + l.id + "|" + l.scad, "Pagamento da incassare: " + l.cliente, "fattura n. " + l.fatt.n + " del " + l.fatt.data + " · " + l.titolo + " · scadenza " + l.scad, l.scad, null]);
  const Z = d.ZONEINFO; if (Z && dtS(Z.scade) && dtS(Z.scade) - oggiRoma().t <= 7 * 864e5) L.push(["zone|" + Z.data, "Zone di volo D-Flight da aggiornare", "caricate il " + Z.data + " · scarica il file nuovo da D-Flight e caricalo in Pannello Admin › Zone di volo", Z.scade, null]);
  return L;
}
// andamento delle celle delle batterie (stessa regola del programma)
function trendBatt(voli, bid) {
  const k = v => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(v.data || ""); return (m ? m[3] + m[2] + m[1] : "") + (v.ora || ""); };
  const V = (voli || []).filter(v => v.batt === bid && v.stato !== "attesa" && typeof v.dev === "number" && Array.isArray(v.celle) && v.celle.length).sort((a, b) => k(a) < k(b) ? -1 : 1).slice(-12);
  const n = V.length, serie = V.map(v => +v.dev || 0), r = { n, serie, voli: V };
  const cons = V.filter(v => (+v.min || 0) >= 3 && +v.cIni > +v.cFin).map(v => (v.cIni - v.cFin) / v.min);
  if (cons.length >= 4) { const h = Math.floor(cons.length / 2), m = a => a.reduce((s, x) => s + x, 0) / a.length; r.consPrima = Math.round(m(cons.slice(0, h)) * 10) / 10; r.consOra = Math.round(m(cons.slice(-h)) * 10) / 10; }
  r.tMax = Math.max(0, ...V.slice(-3).map(v => +v.tMax || 0));
  if (n < 3) { r.liv = ""; return r; }
  const mx = (n - 1) / 2, my = serie.reduce((s, x) => s + x, 0) / n; let a = 0, b = 0;
  serie.forEach((y, i) => { a += (i - mx) * (y - my); b += (i - mx) * (i - mx); });
  const slope = b ? a / b : 0, ult = serie[n - 1];
  r.slope = slope; r.ult = ult; r.primo = serie[0];
  if (ult >= 0.10) r.liv = "ko";
  else if (slope >= 0.003 && ult >= 0.04) { r.liv = "warn"; r.mancano = Math.max(1, Math.ceil((0.10 - ult) / slope)); }
  else r.liv = "ok";
  if (r.liv === "ok" && r.consOra && r.consPrima && r.consOra >= r.consPrima * 1.15) r.consumo = true;
  return r;
}
function battPeggio(d) {
  const L = [];
  for (const b of d.BATT || []) { const t = trendBatt(d.VOLI, b.id), dr = (d.DRONI || []).find(x => x.id === b.drone); if (t.liv !== "warn" && t.liv !== "ko") continue;
    const v = (x) => String(x.toFixed(2)).replace(".", ",");
    L.push(["batt|" + b.id + "|" + t.liv + "|" + v(t.ult), b.nome + (dr ? " (" + dr.nome + ")" : ""), t.liv === "ko" ? "differenza tra le celle " + v(t.ult) + " V: da controllare prima di usarla" : "celle in peggioramento: da " + v(t.primo) + " a " + v(t.ult) + " V in " + t.n + " voli, al limite tra circa " + t.mancano + " voli"]); }
  return L;
}
function calendarioIcs(d, chi) {
  const e = s => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, "\\n");
  const ymd = s => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ""); return m ? m[3] + m[2] + m[1] : null; };
  const dopo = y => { const t = new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)) + 864e5); return t.toISOString().slice(0, 10).replace(/-/g, ""); };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z", ev = [];
  const add = (uid, data, tit, luogo, desc) => { const y = ymd(data); if (!y) return;
    ev.push(["BEGIN:VEVENT", "UID:" + uid + "@quota120", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + y, "DTEND;VALUE=DATE:" + dopo(y), "SUMMARY:" + e(tit), luogo ? "LOCATION:" + e(luogo) : "", desc ? "DESCRIPTION:" + e(desc) : "", "TRANSP:TRANSPARENT", "END:VEVENT"].filter(Boolean).join("\r\n")); };
  const io = (d.PILOTI || []).find(p => p.nome === chi.n), tutti = chi.adm;
  for (const l of d.LAVORI || []) {
    if (!tutti && !(io && l.pilota === io.id)) continue;
    const p = (d.PILOTI || []).find(x => x.id === l.pilota), dr = (d.DRONI || []).find(x => x.id === l.drone);
    add("lav-" + l.id, l.data, (l.stato === "concluso" ? "✓ " : "") + l.cliente + " · " + (l.titolo || "lavoro"), l.luogo,
      [p && "Pilota: " + p.nome, dr && "Drone: " + dr.nome, l.codice && "Codice lavoro: " + l.codice, "Da Quota 120"].filter(Boolean).join("\n"));
  }
  for (const p of d.PILOTI || []) { if (!tutti && !(io && p.id === io.id)) continue;
    { const q = ((d.SCHEDEP || {})[p.id] || {}).polizza; if (q && q.scad) add("pol-" + p.id, q.scad, "Scade la polizza RC personale di " + p.nome, "", "Carica la quietanza nuova quando la rinnovi"); }
    for (const [k, a] of Object.entries(((d.SCHEDEP || {})[p.id] || {}).att || {})) if (a.scad) add("att-" + p.id + "-" + k, a.scad, "Scade l'attestato " + k + " di " + p.nome, "", "Senza, non può volare con i droni che lo richiedono"); }
  if (tutti) {
    if ((d.ASSIC || {}).scad) add("assic", d.ASSIC.scad, "Scade la polizza RC aziendale", "", "Senza assicurazione non si vola");
    if ((d.OP || {}).dfAbb) add("dflight", d.OP.dfAbb, "Scade l'abbonamento D-Flight", "", "");
    for (const l of d.LAVORI || []) if (l.fatt && !l.pagato && l.scad) add("pag-" + l.id, l.scad, "Pagamento da incassare: " + l.cliente, "", "Fattura n. " + ((l.fatt || {}).n || ""));
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Quota 120//IT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Quota 120", "X-WR-TIMEZONE:Europe/Rome", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"].concat(ev, ["END:VCALENDAR"]).join("\r\n");
}
function manutenzioni(d) { return (d.DRONI || []).map(x => [x, (d.SCHEDE || {})[x.id]]).filter(([x, s]) => s && s.man && s.man.liv !== "ok").map(([x, s]) => ["man|" + x.id + "|" + s.man.prox, "Manutenzione " + x.nome, s.man.prox + " · " + (s.man.mancano === "da fare subito" ? "da fare subito" : "mancano " + s.man.mancano + " di volo")]); }
function mailHtml(nomeOp, righe, perAdmin, url) {
  const col = g => g <= 7 ? "#AE2F28" : "#A5660A", et = g => g < 0 ? "scaduto" : g === 0 ? "oggi" : g === 1 ? "domani" : "tra " + g + " giorni";
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#0F1C26;font-size:15px;line-height:1.45">
    <div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
    Buongiorno, ecco cosa sta per scadere${nomeOp ? " per " + esc(nomeOp) : ""}:
    <table style="width:100%;border-collapse:collapse;margin-top:10px">${righe.map(r => `<tr><td style="padding:10px 10px 10px 0;border-top:1px solid #E3E8EB;vertical-align:top;width:96px"><span style="display:inline-block;background:${r.g == null ? "#A5660A" : col(r.g)};color:#fff;font-weight:bold;font-size:13px;padding:3px 8px;border-radius:5px;white-space:nowrap">${r.g == null ? "presto" : et(r.g)}</span></td><td style="padding:10px 0;border-top:1px solid #E3E8EB"><b>${esc(r.t)}</b><br><span style="color:#5E6D77;font-size:13.5px">${esc(r.s)}</span></td></tr>`).join("")}</table>
    <a href="${url}" style="display:inline-block;margin-top:16px;background:#1D5C7C;color:#fff;border-radius:8px;padding:12px 18px;font-weight:bold;text-decoration:none">Apri Quota 120</a>
    <p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Ricevi questa mail perché ${perAdmin ? "sei l'Admin" : "sei un pilota"}${nomeOp ? " di " + esc(nomeOp) : ""} su Quota 120.${perAdmin ? " Per cambiare cosa ricevi: Pannello Admin › Avvisi via email." : " Per non riceverle più, chiedi all'Admin."}</p></div>`;
}
async function mandaMail(env, a, oggetto, html, allegati, rispondi) {
  const RISP = rispondi || env.RISPOSTE;
  allegati = allegati || [];
  if (env.POSTA_FINTA === "1") { (globalThis.__POSTA = globalThis.__POSTA || []).push({ a, oggetto, html, allegati: allegati.map(x => x.nome + " (" + x.b64.length + ")") }); return; }   // solo per le prove in locale
  // Resend (se c'è la sua chiave) oppure Brevo
  if (env.RESEND_API_KEY && env.MITTENTE) {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ from: "Quota 120 <" + env.MITTENTE + ">", to: [a], subject: oggetto, html }, RISP ? { reply_to: RISP } : {}, allegati.length ? { attachments: allegati.map(x => ({ filename: x.nome, content: x.b64 })) } : {})) });
    if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("La posta non ha accettato la mail (" + r.status + ") " + t.slice(0, 160)); }
    return;
  }
  if (!env.BREVO_API_KEY || !env.MITTENTE) throw new Error("posta:" + [env.RESEND_API_KEY || env.BREVO_API_KEY ? "" : "manca la chiave della posta (RESEND_API_KEY)", env.MITTENTE ? "" : "manca il mittente (MITTENTE)", "il programma vede: " + (Object.keys(env).filter(k => /KEY|MITTENTE|RISPOSTE/.test(k)).join(", ") || "nessuna impostazione")].filter(Boolean).join(" · "));
  const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(Object.assign({ sender: { name: "Quota 120", email: env.MITTENTE }, to: [{ email: a }], subject: oggetto, htmlContent: html }, RISP ? { replyTo: { email: RISP } } : {}, allegati.length ? { attachment: allegati.map(x => ({ name: x.nome, content: x.b64 })) } : {})) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("La posta non ha accettato la mail (" + r.status + ") " + t.slice(0, 160)); }
}
const EMAIL = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
const b64 = buf => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

/* ---------- spazi degli operatori: ognuno il suo contenitore di dati ("op:<nome>"), più il registro delle iscrizioni ---------- */
const RISERVATI = new Set(["api", "interno", "prova", "privacy", "condizioni", "condividi", "leaflet", "lib", "dji", "index", "admin", "www", "app", "quota120", "registro", "iscriviti", "entra", "assistenza"]);
const SLUG_OK = s => /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s || "") && !RISERVATI.has(s);
const cod6 = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const GIORNI_ADMIN = 15;   // l'Admin entrato con l'email resta dentro; se non usa quel telefono per 15 giorni, rifà il codice
function codiceHtml(nome, nomeOp, codice, iscrizione) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0F1C26;font-size:15px;line-height:1.5">
    <div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
    ${nome ? "Ciao " + esc(nome) + "," : "Ciao,"} ecco il codice ${iscrizione ? "per confermare l'iscrizione" : "per entrare"}${nomeOp ? " nello spazio di <b>" + esc(nomeOp) + "</b>" : ""}:
    <div style="font-size:32px;font-weight:bold;letter-spacing:.25em;text-align:center;margin:18px 0;color:#0F1C26">${codice.slice(0, 3)} ${codice.slice(3)}</div>
    Vale 15 minuti. Se non sei stato tu, ignora questa email: senza il codice nessuno può entrare.
    <p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Quota 120 · gestionale per operatori di droni · versione di prova gratuita</p></div>`;
}
function nomeSpazio(nome) {
  let s = norm(nome).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  s = s.replace(/-(srl|srls|snc|sas|spa|s-r-l|s-n-c|s-a-s|s-p-a|ss|soc-coop|coop)$/g, "").slice(0, 30).replace(/-+$/g, "");
  return s.length >= 3 ? s : "operatore-" + rnd(2);
}

export class Stato extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url), st = this.ctx.storage, p = url.pathname;
    if (p.startsWith("/api/registro/")) return this.registro(request, url, p);
    if (p === "/interno/elenco") return J((await st.get("elenco")) || []);
    const OPN = request.headers.get("x-q120-op") || "";   // "" = versione di prova (dati di esempio)
    const creato = OPN ? await st.get("creato") : null;
    if (OPN && !creato && p !== "/interno/crea") return J({ errore: "operatore" }, 404);
    const BASEURL = url.origin + (OPN ? "/" + OPN : "");
    const disp = (await st.get("disp")) || {};
    const pin = (await st.get("pin")) || "1234";
    const now = Date.now();
    const blocchi = (await st.get("blocchi")) || {};          // id pilota -> true
    const aspetti = (await st.get("aspetti")) || {};          // nome -> A | B | C
    const nomeDisp = ua => { ua = String(ua || ""); const so = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Macintosh|Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
      const br = /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
      return [so, br].filter(Boolean).join(" · "); };
    const pub = () => Object.keys(disp).map(id => { const x = disp[id]; return { id, ruolo: x.ruolo, n: x.n, codice: x.codice, stato: x.stato, at: x.at, visto: x.visto, nuovo: !!x.nuovo, pid: x.pid, dev: x.dev || "" }; });
    const leggiMain = async () => { const row = await st.get("main"); return row ? { row, d: JSON.parse(row.json) } : null; };
    const scriviMain = async (d, ver) => { await st.put("main", { json: JSON.stringify(d), ver }); };
    const nuovoAdmin = async email => {
      const id = rnd(8), k = rnd(18);
      disp[id] = { k, ruolo: "adm", n: "Admin", pid: null, nuovo: false, codice: cod4(), stato: "ok", at: now, visto: now, app: true, via: "email", email, dev: nomeDisp(request.headers.get("user-agent")) };
      await st.put("disp", disp);
      return { id, k, n: "Admin", stato: "ok", codice: disp[id].codice, asp: aspetti.Admin || ASP_BASE };
    };
    // ---- porte interne: le usa solo il registro (dal mondo esterno /interno/ non arriva) ----
    if (p === "/interno/crea" && request.method === "POST") {
      if (!OPN) return J({ errore: "solo per gli spazi" }, 400);
      if (creato) return J({ errore: "esiste già" }, 409);
      const b = await request.json();
      await st.put("creato", { at: now, email: b.email });
      await st.put("pin", rnd(16));   // il codice di 4 cifre qui non si usa: l'Admin entra con l'email
      await scriviMain(b.data || {}, 1);
      return J(await nuovoAdmin(b.email));
    }
    if (p === "/interno/nuovoadmin" && request.method === "POST") {
      if (!creato) return J({ errore: "operatore" }, 404);
      const b = await request.json();
      return J(await nuovoAdmin(b.email));
    }

    // ---- entrata: Admin con codice, Pilota con nome e cognome + matricola ----
    if (p === "/api/disp/richiesta" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ruolo = b.ruolo === "adm" ? "adm" : "op";
      let n = "", pid = null, nuovo = false;
      if (ruolo === "adm") {
        if (creato) return J({ errore: "Qui l'Admin entra con la sua email" }, 403);
        const ip = request.headers.get("cf-connecting-ip") || "x", kk = "pinerr:" + ip, err = (await st.get(kk)) || { n: 0, t: now };
        if (now - err.t > 900000) { err.n = 0; err.t = now; }
        if (err.n >= 5) return J({ errore: "Troppi codici sbagliati: riprova tra 15 minuti" }, 429);
        if (String(b.pin || "") !== pin) { err.n++; await st.put(kk, err); return J({ errore: "Codice sbagliato" }, 403); }
        await st.delete(kk);
        if (!(await st.get("main"))) await scriviMain(b.data || {}, 1);
      } else {
        const m = await leggiMain();
        if (!m) return J({ errore: "L'Admin deve ancora preparare il programma: riprova più tardi" }, 409);
        const ip = request.headers.get("cf-connecting-ip") || "x", kk = "operr:" + ip, err = (await st.get(kk)) || { n: 0, t: now };
        if (now - err.t > 900000) { err.n = 0; err.t = now; }
        if (err.n >= 5) return J({ errore: "Troppi tentativi: riprova tra 15 minuti" }, 429);
        const nn = norm(b.n), mm = norm(b.matr);
        const pi = nn && mm ? (m.d.PILOTI || []).find(x => norm(x.nome) === nn && x.matr && norm(x.matr) === mm && !((m.d.PERM || {})[x.id] || {}).admin) : null;
        if (!pi) { err.n++; await st.put(kk, err); return J({ errore: "Nome o matricola non corretti" }, 403); }
        await st.delete(kk);
        if (blocchi[pi.id]) return J({ errore: "bloccato" }, 403);
        n = pi.nome; pid = pi.id;
        nuovo = Object.values(disp).some(x => x.ruolo === "op" && (x.pid === pid || x.n === n) && x.app);
      }
      const id = rnd(8), k = rnd(18);
      // le richieste rimaste in attesa dello stesso pilota si sostituiscono con la nuova
      if (ruolo === "op") for (const x of Object.values(disp)) if (x.ruolo === "op" && x.pid === pid && x.stato === "attesa") x.stato = "uscito";
      for (const [i, x] of Object.entries(disp)) if (["uscito", "rifiutato", "tolto"].includes(x.stato) && now - (x.visto || 0) > 30 * 86400000) delete disp[i];
      disp[id] = { k, ruolo, n: ruolo === "adm" ? "Admin" : n, pid, nuovo, codice: cod4(), stato: ruolo === "adm" ? "ok" : "attesa", at: now, visto: now, app: ruolo === "adm", dev: nomeDisp(request.headers.get("user-agent")) };
      await st.put("disp", disp);
      return J({ id, k, n: disp[id].n, stato: disp[id].stato, codice: disp[id].codice, asp: aspetti[disp[id].n] || ASP_BASE });
    }

    // ---- invio programmato degli avvisi: lo chiama solo il cron (non passa da /api) ----
    if (p === "/interno/avvisi") return J(await this.avvisi(false, url.origin));
    if (p === "/interno/posta" && this.env.POSTA_FINTA === "1") return J(globalThis.__POSTA || []);

    // ---- controllo pubblico: dice solo SE le impostazioni ci sono (mai i valori) ----
    if (p === "/api/salute") { const c = n => !!(this.env[n] && String(this.env[n]).trim()); const prova = {};
      if (url.searchParams.get("prova") === "1") {   // prova dal vivo che DJI e Claude accettino le chiavi (risponde solo sì/no e il messaggio d'errore)
        try { const r = await fetch(DJI_KEYCHAINS, { method: "POST", headers: { "content-type": "application/json", "api-key": url.searchParams.get("finta") ? "chiave-sbagliata" : (this.env.DJI_API_KEY || "") }, body: JSON.stringify({ version: +(url.searchParams.get("v") || 13), department: 3, keychainsArray: [] }) }); const j = await r.json().catch(() => ({})); prova.dji = { http: r.status, risultato: j.result || null }; } catch (e) { prova.dji = { errore: String(e.message || e).slice(0, 120) }; }
        try { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: MODELLO, max_tokens: 5, messages: [{ role: "user", content: "Rispondi solo: OK" }] }) }); const j = await r.json().catch(() => ({})); prova.claude = { http: r.status, risposta: j.content ? j.content.map(x => x.text).join("") : (j.error && j.error.message || "").slice(0, 160) }; } catch (e) { prova.claude = { errore: String(e.message || e).slice(0, 120) }; }
      }
      return J({ prova, versione: "c12", posta: c("RESEND_API_KEY") || c("BREVO_API_KEY"), RESEND_API_KEY: c("RESEND_API_KEY"), BREVO_API_KEY: c("BREVO_API_KEY"), MITTENTE: c("MITTENTE"), RISPOSTE: c("RISPOSTE"), ANTHROPIC_API_KEY: c("ANTHROPIC_API_KEY"), DJI_API_KEY: c("DJI_API_KEY") }); }

    // ---- invio automatico dei voli dal telefono del pilota (Comandi Rapidi su iPhone): basta il codice di invio, niente password ----
    // calendario a cui il telefono si iscrive (iPhone / Google): lavori e scadenze, solo quelli della persona
    if (p === "/api/cal.ics") {
      const tk = url.searchParams.get("t") || "", chi = tk.length >= 16 ? await st.get("cal:" + tk) : null;
      if (!chi) return new Response("calendario non valido", { status: 403 });
      const m = await leggiMain(); const d = m ? m.d : {};
      return new Response(calendarioIcs(d, chi), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=900", "content-disposition": "inline; filename=quota120.ics" } });
    }
    if (p === "/api/invio" && request.method === "POST") {
      const tk = url.searchParams.get("t") || "", chi = tk.length >= 16 ? await st.get("invio:" + tk) : null;
      if (!chi) return new Response("codice di invio non valido", { status: 403 });
      const nome = esc(decodeURIComponent(url.searchParams.get("nome") || request.headers.get("x-nome") || "volo.txt"), 120);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return new Response("file vuoto", { status: 400 });
      if (buf.byteLength > 30 * 1024 * 1024) return new Response("file troppo grande", { status: 413 });
      const u8 = new Uint8Array(buf.slice(0, 4));
      if (/\.(jpe?g|png|heic|mp4|mov)$/i.test(nome)) return new Response("ok (saltato)", { status: 200 });
      const k1 = "arrivo:" + chi.n + ":" + nome + ":" + buf.byteLength;
      const ult = { at: now, nuovi: 0 }, prima = (await st.get("invio:ultimo:" + chi.n)) || {};
      if (await st.get(k1)) { await st.put("invio:ultimo:" + chi.n, { at: now, nuovi: prima.at && now - prima.at < 600000 ? prima.nuovi || 0 : 0, via: chi.via || "iPhone" }); return new Response("ok (già arrivato)"); }
      const did = "d" + now.toString(36) + rnd(3), pezzi = Math.ceil(buf.byteLength / PEZZO);
      for (let i = 0; i < pezzi; i++) await st.put("doc:" + did + ":" + i, buf.slice(i * PEZZO, (i + 1) * PEZZO));
      await st.put("docinfo:" + did, { mime: "text/plain", pezzi, size: buf.byteLength, nome, da: chi.n, at: now, confermato: false });
      await st.put(k1, did);
      const L = (await st.get("arrivi")) || []; L.push({ id: did, nome, size: buf.byteLength, da: chi.n, at: now, via: "iPhone" }); await st.put("arrivi", L.slice(-300));
      await st.put("invio:ultimo:" + chi.n, { at: now, nuovi: (prima.at && now - prima.at < 600000 ? prima.nuovi || 0 : 0) + 1, via: "iPhone" });
      return new Response("ok");
    }

    // ---- da qui serve un dispositivo riconosciuto ----
    let id = url.searchParams.get("id") || "", k = url.searchParams.get("k") || "";
    const h = request.headers.get("x-disp") || ""; if (h.includes(":")) [id, k] = h.split(":");
    const me = disp[id];
    if (!me || me.k !== k) return J({ errore: "dispositivo" }, 401);
    if (me.via === "email" && now - (me.visto || 0) > GIORNI_ADMIN * 86400000) { delete disp[id]; await st.put("disp", disp); return J({ errore: "dispositivo", scaduto: true }, 401); }
    if (now - (me.visto || 0) > 60000 || !me.dev) { me.visto = now; if (!me.dev) me.dev = nomeDisp(request.headers.get("user-agent")); await st.put("disp", disp); }
    if (me.ruolo === "op" && me.pid == null) { const m0 = await leggiMain(), p0 = m0 && pilotaDi(m0.d, me.n); if (p0) { me.pid = p0.id; await st.put("disp", disp); } }
    if (me.ruolo === "op" && me.pid != null && blocchi[me.pid] && me.stato === "ok") { me.stato = "bloccato"; await st.put("disp", disp); }
    if (p === "/api/disp/stato") return J({ stato: me.stato, codice: me.codice, ruolo: me.ruolo, n: me.n, asp: aspetti[me.n] || ASP_BASE });
    // chi esce toglie il suo telefono dall'elenco (anche se era ancora in attesa)
    if (p === "/api/disp/esci" && request.method === "POST") { me.stato = "uscito"; await st.put("disp", disp); return J({ ok: true }); }
    if (me.stato !== "ok") return J({ errore: "non approvato", stato: me.stato }, 403);
    const adm = me.ruolo === "adm";

    // ---- aspetto della pagina iniziale: ognuno il suo, resta sulla persona ----
    if (p === "/api/aspetto" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (!ASPETTI.includes(b.a)) return J({ errore: "Aspetto non valido" }, 400);
      aspetti[me.n] = b.a; await st.put("aspetti", aspetti);
      return J({ ok: true, asp: b.a });
    }

    if (p === "/api/disp/azione" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin" }, 403);
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (b.op === "pin") { if (!/^\d{4}$/.test(b.pin || "")) return J({ errore: "Servono 4 cifre" }, 400); await st.put("pin", b.pin); return J({ ok: true }); }
      if (b.op === "togliVecchi") {   // telefoni e computer non usati da 30 giorni (non questo)
        const lim = Date.now() - 30 * 864e5; let n = 0;
        for (const [k2, x] of Object.entries(disp)) if (k2 !== id && x.stato === "ok" && (x.visto || x.at || 0) < lim) { x.stato = "tolto"; n++; }
        await st.put("disp", disp); return J({ ok: true, n, disp: pub(), blocchi });
      }
      if (b.op === "approvaTutti") {
        for (const x of Object.values(disp)) if (x.stato === "attesa") { x.stato = "ok"; x.app = true; }
        await st.put("disp", disp); return J({ ok: true, disp: pub(), blocchi });
      }
      // blocca: il pilota esce subito da tutti i suoi telefoni e non può chiederne altri; sblocca: al prossimo accesso chiede di nuovo l'approvazione
      if (b.op === "blocca" || b.op === "sblocca") {
        const pidB = +b.pid; if (!Number.isFinite(pidB)) return J({ errore: "Pilota non valido" }, 400);
        const mB = await leggiMain(), pB = mB && (mB.d.PILOTI || []).find(q => q.id === pidB), suo = x => x.ruolo === "op" && (x.pid === pidB || (pB && x.n === pB.nome));
        if (b.op === "blocca") { blocchi[pidB] = true; for (const x of Object.values(disp)) if (suo(x)) { if (x.stato === "ok") x.stato = "bloccato"; else if (x.stato === "attesa") x.stato = "rifiutato"; } }
        else { delete blocchi[pidB]; for (const x of Object.values(disp)) if (suo(x) && x.stato === "bloccato") x.stato = "tolto"; }
        await st.put("blocchi", blocchi); await st.put("disp", disp);
        return J({ ok: true, disp: pub(), blocchi });
      }
      const x = disp[b.id]; if (!x) return J({ errore: "Dispositivo non trovato" }, 404);
      if (b.id === id && b.op === "togli") return J({ errore: "Non puoi togliere te stesso" }, 400);
      x.stato = b.op === "approva" ? "ok" : b.op === "rifiuta" ? "rifiutato" : b.op === "togli" ? "tolto" : x.stato;
      if (b.op === "approva") x.app = true;
      await st.put("disp", disp);
      return J({ ok: true, disp: pub(), blocchi });
    }

    // ---- codice lavoro: il pilota lo scrive e riceve solo cliente, lavoro e luogo (niente importi) ----
    if (p === "/api/lavoro") {
      const c = norm(url.searchParams.get("c")).replace(/\s/g, ""), m = await leggiMain();
      const l = c && m && (m.d.LAVORI || []).find(x => norm(x.codice).replace(/\s/g, "") === c && x.stato !== "concluso");
      return J({ lavoro: l ? { id: l.id, codice: l.codice, cliente: l.cliente, titolo: l.titolo, luogo: l.luogo, data: l.data } : null });
    }
    if (p === "/api/avvisi/prova" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin" }, 403);
      try { return J(await this.avvisi(true, BASEURL)); } catch (e) { const m = String(e.message || e); return J({ errore: m.startsWith("posta") ? "posta" : m, dettaglio: m.startsWith("posta:") ? m.slice(6) : "" }, 502); }
    }
    if (p === "/api/volo/trk") {
      const vid = +url.searchParams.get("id"), m = await leggiMain(), v = m && (m.d.VOLI || []).find(x => x.id === vid);
      if (!v) return J({ errore: "Volo non trovato" }, 404);
      if (!adm && v.pilota !== me.n && !permDi(m.d, me.n).voliTutti) return J({ errore: "Non puoi vederlo" }, 403);
      return J({ trk: (await st.get("trk:" + vid)) || [] });
    }
    // ---- registri di volo DJI: la chiave resta qui, il telefono chiede solo le chiavi del suo file ----
    if (p === "/api/dji/keychains" && request.method === "POST") {
      if (!this.env.DJI_API_KEY) return J({ errore: "chiave_dji" }, 503);
      const txt = await request.text(); if (txt.length > 300000) return J({ errore: "Richiesta troppo grande" }, 413);
      try {
        const r = await fetch(DJI_KEYCHAINS, { method: "POST", headers: { "content-type": "application/json", "api-key": this.env.DJI_API_KEY }, body: txt });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.data) return J({ errore: "DJI non ha dato le chiavi" + (j.result && j.result.msg ? ": " + esc(j.result.msg, 200) : " (" + r.status + ")") }, 502);
        return J({ data: j.data });
      } catch (e) { return J({ errore: "DJI non risponde: riprova tra poco" }, 502); }
    }
    if (p === "/api/volo/leggifoto" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Foto non trovata" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non è tua" }, 403);
      if (!this.env.ANTHROPIC_API_KEY) return J({ errore: "chiave" }, 503);
      if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) return J({ errore: "Serve una foto JPEG o PNG" }, 415);
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(new Uint8Array(await st.get("doc:" + b.id + ":" + i)));
      const tutto = new Uint8Array(info.size); let o = 0; for (const x of parti) { tutto.set(x, o); o += x.length; }
      const m = await leggiMain(), droni = ((m && m.d.DRONI) || []).map(x => x.nome).join("; ");
      try { return J({ letto: await leggiFotoVolo(this.env, b64(tutto.buffer), info.mime, droni) }); }
      catch (e) { return J({ errore: String(e.message || e) }, 502); }
    }
    if (p === "/api/segnala" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (!SG_TIPI[b.tipo]) return J({ errore: "Scegli cosa è successo" }, 400);
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, dr = (d.DRONI || []).find(x => x.nome === b.drone);
      if (!dr) return J({ errore: "Scegli il drone" }, 400);
      const foto = [];
      for (const f of (Array.isArray(b.foto) ? b.foto : []).slice(0, 8)) { const info = await st.get("docinfo:" + f); if (info && (adm || info.da === me.n)) foto.push(esc(f, 40)); }
      const x = { id: now * 10 + Math.floor(Math.random() * 10), at: now, data: DATA(b.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(b.ora || "") ? b.ora : "", pilota: adm && b.pilota ? esc(b.pilota, 80) : me.n,
        drone: dr.nome, tipo: b.tipo, feriti: !!b.feriti, danni: !!b.danni, testo: esc(b.testo, 2000), luogo: esc(b.luogo, 160), foto, volo: esc(b.volo, 20), fermo: true, stato: "aperta", eccairs: "" };
      x.liv = livSegn(x);
      d.SEGN = d.SEGN || []; d.SEGN.unshift(x); d.SEGN = d.SEGN.slice(0, 500);
      await scriviMain(d, m.row.ver + 1);
      // mail subito all'Admin
      const A = (d.AVVISI || {}).adm || {};
      if (A.email && A.on !== false) {
        const txt = x.liv === "grave" ? "Incidente grave: avvisare subito ANSV e segnalare a ENAC su ECCAIRS 2 entro 72 ore." : x.liv === "enac" ? "Da segnalare a ENAC su ECCAIRS 2 entro 72 ore." : "Segnalazione facoltativa a ENAC, consigliata se riguarda la sicurezza.";
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#0F1C26;font-size:15px;line-height:1.45"><div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
          <div style="background:${x.liv === "grave" ? "#AE2F28" : "#A5660A"};color:#fff;border-radius:8px;padding:10px 14px;font-weight:bold">${esc(txt)}</div>
          <p><b>${esc(SG_TIPI[x.tipo])}</b> · ${esc(x.drone)}<br>${esc(x.pilota)} · ${x.data} ${x.ora}${x.luogo ? " · " + esc(x.luogo) : ""}<br>Feriti: ${x.feriti ? "sì" : "no"} · Danni: ${x.danni ? "sì" : "no"}</p><p>${esc(x.testo)}</p>
          <p>Il drone resta fermo finché non lo sblocchi in Pannello Admin › Segnalazioni.</p><a href="${(await st.get("origine")) || BASEURL}" style="display:inline-block;background:#1D5C7C;color:#fff;border-radius:8px;padding:12px 18px;font-weight:bold;text-decoration:none">Apri Quota 120</a></div>`;
        try { await mandaMail(this.env, A.email.trim(), (x.liv === "grave" ? "URGENTE · " : "") + "Segnalazione: " + SG_TIPI[x.tipo] + " · " + x.drone, html); } catch (e) {}
      }
      return J({ ok: true, segn: x, ver: m.row.ver + 1 });
    }
    // codice di invio personale (per il comando rapido) e voli arrivati dal telefono
    if (p === "/api/cal/codice") {
      let tk = await st.get("cal:di:" + me.n);
      if (!tk || url.searchParams.get("nuovo") === "1") { if (tk) await st.delete("cal:" + tk); tk = crypto.randomUUID().replace(/-/g, ""); await st.put("cal:" + tk, { n: me.n, adm: !!adm }); await st.put("cal:di:" + me.n, tk); }
      return J({ codice: tk });
    }
    if (p === "/api/invio/codice") {
      let tk = await st.get("invio:di:" + me.n);
      if (!tk || url.searchParams.get("nuovo") === "1") { if (tk) await st.delete("invio:" + tk); tk = crypto.randomUUID().replace(/-/g, ""); await st.put("invio:" + tk, { n: me.n }); await st.put("invio:di:" + me.n, tk); }
      return J({ codice: tk, ultimo: (await st.get("invio:ultimo:" + me.n)) || null });
    }
    if (p === "/api/arrivi" && request.method === "GET") {
      const L = (await st.get("arrivi")) || [];
      return J({ arrivi: L.filter(x => adm || x.da === me.n) });
    }
    if (p === "/api/arrivi" && request.method === "POST") {   // file arrivati da Android (Condividi › Quota 120) o dal telefono
      const nome = esc(decodeURIComponent(request.headers.get("x-nome") || "volo.txt"), 120), buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 30 * 1024 * 1024) return J({ errore: "File non valido" }, 400);
      const k1 = "arrivo:" + me.n + ":" + nome + ":" + buf.byteLength;
      if (await st.get(k1)) return J({ ok: true, gia: true });
      const did = "d" + now.toString(36) + rnd(3), pezzi = Math.ceil(buf.byteLength / PEZZO);
      for (let i = 0; i < pezzi; i++) await st.put("doc:" + did + ":" + i, buf.slice(i * PEZZO, (i + 1) * PEZZO));
      await st.put("docinfo:" + did, { mime: "text/plain", pezzi, size: buf.byteLength, nome, da: me.n, at: now, confermato: false });
      await st.put(k1, did);
      const L = (await st.get("arrivi")) || []; L.push({ id: did, nome, size: buf.byteLength, da: me.n, at: now, via: esc(request.headers.get("x-via") || "Android", 20) }); await st.put("arrivi", L.slice(-300));
      return J({ ok: true, id: did });
    }
    // lettura automatica: chi apre Quota 120 «prende» i voli arrivati (uno alla volta, nessun doppione tra due telefoni aperti insieme)
    if (p === "/api/arrivi/prendi" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ids = new Set(Array.isArray(b.ids) ? b.ids.slice(0, 20) : []), L = (await st.get("arrivi")) || [], presi = [];
      for (const x of L) if (ids.has(x.id) && (adm || x.da === me.n) && !x.sist && !(x.presa && now - x.presa < 600000)) { x.presa = now; x.chi = me.n; presi.push(x.id); }
      await st.put("arrivi", L);
      return J({ presi });
    }
    if (p === "/api/arrivi/sistemare" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const L = (await st.get("arrivi")) || [], x = L.find(y => y.id === b.id && (adm || y.da === me.n));
      if (x) { x.sist = esc(b.motivo || "da controllare", 200); x.presa = 0; if (b.info && typeof b.info === "object") x.info = { data: esc(b.info.data, 10), ora: esc(b.info.ora, 5), drone: esc(b.info.drone, 80) }; await st.put("arrivi", L); }
      return J({ ok: true });
    }
    if (p === "/api/arrivi/libera" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ids = new Set(Array.isArray(b.ids) ? b.ids : []), L = (await st.get("arrivi")) || [];
      for (const x of L) if (ids.has(x.id) && (adm || x.da === me.n)) x.presa = 0;
      await st.put("arrivi", L); return J({ ok: true });
    }
    if (p === "/api/arrivi/letti" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ids = new Set(Array.isArray(b.ids) ? b.ids : []), L = (await st.get("arrivi")) || [];
      await st.put("arrivi", L.filter(x => !(ids.has(x.id) && (adm || x.da === me.n))));
      return J({ ok: true });
    }
    if (p === "/api/zone/carica" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin può caricare le zone" }, 403);
      const txt = await request.text(); if (txt.length > 40e6) return J({ errore: "File troppo grande" }, 413);
      let b; try { b = JSON.parse(txt); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const Z = Array.isArray(b.zone) ? b.zone : []; if (!Z.length) return J({ errore: "Nel file non ho trovato zone" }, 400);
      const tutto = JSON.stringify(Z), PEZ = 1500000, n = Math.ceil(tutto.length / PEZ), vecchi = +(await st.get("zone:n")) || 0;
      for (let i = 0; i < n; i++) await st.put("zone:" + i, tutto.slice(i * PEZ, (i + 1) * PEZ));
      for (let i = n; i < vecchi; i++) await st.delete("zone:" + i);
      await st.put("zone:n", n); this.ZC = Z;
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const scade = new Date(Date.now() + 28 * 864e5), ds = String(scade.getUTCDate()).padStart(2, "0") + "/" + String(scade.getUTCMonth() + 1).padStart(2, "0") + "/" + scade.getUTCFullYear();
      m.d.ZONEINFO = { data: oggiRoma().data, n: Z.length, file: esc(b.file, 120), scade: ds };
      await scriviMain(m.d, m.row.ver + 1);
      return J({ ok: true, info: m.d.ZONEINFO, ver: m.row.ver + 1 });
    }
    if (p === "/api/zone/area") {   // le zone intorno a un punto (circa 50 km), da tenere sul telefono per lavorare senza rete
      const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon");
      if (!isFinite(lat) || !isFinite(lon)) return J({ errore: "Posizione non valida" }, 400);
      if (!this.ZC) { const n = +(await st.get("zone:n")) || 0; if (!n) return J({ zone: [] }); let t = ""; for (let i = 0; i < n; i++) t += (await st.get("zone:" + i)) || ""; try { this.ZC = JSON.parse(t); } catch (e) { return J({ zone: [] }); } }
      const dl = 0.45, dn = dl / Math.cos(lat * Math.PI / 180);
      return J({ zone: this.ZC.filter(z => { const b = z.b; return !b || !(b[2] < lat - dl || b[0] > lat + dl || b[3] < lon - dn || b[1] > lon + dn); }).slice(0, 4000) });
    }
    if (p === "/api/zone") {
      const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon");
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return J({ errore: "Posizione non valida" }, 400);
      if (!this.ZC) { const n = +(await st.get("zone:n")) || 0; if (!n) return J({ nessuna: true }); let t = ""; for (let i = 0; i < n; i++) t += (await st.get("zone:" + i)) || ""; try { this.ZC = JSON.parse(t); } catch (e) { return J({ nessuna: true }); } }
      return J(controllaZone(this.ZC, lat, lon));
    }
    if (p === "/api/volo/elimina" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin può eliminare un volo" }, 403);
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, v = (d.VOLI || []).find(x => x.id === +b.id);
      if (!v) return J({ errore: "Volo non trovato" }, 404);
      togliVolo(d, v); d.VOLI.splice(d.VOLI.indexOf(v), 1); await st.delete("trk:" + v.id);
      await scriviMain(d, m.row.ver + 1);
      return J({ ok: true, ver: m.row.ver + 1 });
    }
    if (p === "/api/volo/importa" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, v0 = b.volo || {};
      const pilota = adm ? String(v0.pilota || "") : me.n;
      if (!(d.PILOTI || []).some(x => x.nome === pilota)) return J({ errore: "Scegli il pilota" }, 400);
      if (!(d.DRONI || []).some(x => x.nome === v0.drone)) return J({ errore: "Scegli il drone" }, 400);
      const L = pulisciLetto(Object.assign({}, v0, { letto: true }));
      if (L.batt && !(d.BATT || []).some(x => x.id === L.batt)) L.batt = "";
      if (v0.codLav && !v0.cliente) { const lw = (d.LAVORI || []).find(x => norm(x.codice).replace(/\s/g, "") === norm(v0.codLav).replace(/\s/g, "")); if (lw) { v0.cliente = lw.cliente + ": " + String(lw.titolo || "").toLowerCase(); if (!v0.luogo) v0.luogo = lw.luogo; } }
      if (L.daFoto) L.logKey = "foto|" + esc(v0.drone, 80) + "|" + (DATA(v0.data) || "") + "|" + esc(v0.ora, 5);
      if (L.logKey && (d.VOLI || []).some(x => x.logKey === L.logKey)) return J({ errore: "doppio" }, 409);
      // la stessa foto (o un'altra foto dello stesso volo) caricata due volte: non si conta due volte
      if (L.daFoto && (d.VOLI || []).some(x => x.daFoto && x.pilota === pilota && x.drone === v0.drone && x.data === (DATA(v0.data) || oggi()) && x.ora === v0.ora)) return J({ errore: "doppio" }, 409);
      if (b.docLog) { const info = await st.get("docinfo:" + b.docLog); if (!info || (!adm && info.da !== me.n)) b.docLog = ""; }
      const v = Object.assign({ id: Date.now() * 10 + Math.floor(Math.random() * 10), data: DATA(v0.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(v0.ora || "") ? v0.ora : "00:00",
        drone: v0.drone, pilota, luogo: esc(v0.luogo, 120), min: NUM(v0.min, 0, 600), stato: "completo", ctrl: !!v0.ctrl, ctrlOra: esc(v0.ctrlOra, 5),
        cliente: esc(v0.cliente, 200), codLav: esc(v0.codLav, 20), note: esc(v0.note, 2000), importato: true, amano: false, cat: esc(v0.cat, 60), inc: "Nessuno",
        docLog: esc(b.docLog, 40), logNome: esc(v0.logNome, 120) }, L);
      // il percorso GPS sta a parte (pesa troppo per stare nei dati di tutti)
      const trk = v.trk; delete v.trk; v.haTrk = trk.length > 1;
      d.VOLI = d.VOLI || [];
      // se c'è il volo aperto dal controllo prima del volo (stesso pilota, drone e giorno), il registro lo completa
      const minuti = h => { const t = /^(\d{2}):(\d{2})$/.exec(h || ""); return t ? +t[1] * 60 + +t[2] : -999; };
      let att = d.VOLI.find(x => x.stato === "attesa" && !x.letto && x.pilota === v.pilota && x.drone === v.drone && x.data === v.data);
      // il file DJI di un volo già caricato con la foto: lo completa, senza contare due volte ore e cicli
      const daFoto = !v.daFoto && d.VOLI.find(x => x.daFoto && x.pilota === v.pilota && x.drone === v.drone && x.data === v.data && Math.abs(minuti(x.ora) - minuti(v.ora)) <= 15);
      if (daFoto) att = daFoto;
      if (att) {
        Object.assign(v, { id: att.id, ctrl: att.ctrl, ctrlOra: att.ctrlOra, cliente: v.cliente || att.cliente || "", codLav: att.codLav || "", meteo: att.meteo || "", zona: att.zona || "", ck: att.ck || "",
          luogo: v.luogo || att.luogo, note: [att.note, v.note].filter(Boolean).join(" · "), cat: att.cat || v.cat });
        if (daFoto) Object.assign(v, { cliente: att.cliente || v.cliente, luogo: att.luogo || v.luogo, batt: att.batt || v.batt, fotoDoc: att.docLog || "" });
        d.VOLI[d.VOLI.indexOf(att)] = v;
      } else d.VOLI.unshift(v);
      if (v.haTrk) await st.put("trk:" + v.id, trk);
      if (!daFoto) applicaVolo(d, v);
      v.contato = true;
      await scriviMain(d, m.row.ver + 1);
      return J({ ok: true, id: v.id, ver: m.row.ver + 1 });
    }

    // ---- dati ----
    if (p === "/api/stato") {
      const m = await leggiMain();
      if (!m) return J({ vuoto: true });
      const { row } = m, io = { r: me.ruolo, n: me.n, id, asp: aspetti[me.n] || ASP_BASE, email: me.via === "email" ? me.email : "" }, extra = adm ? { disp: pub(), blocchi, pinIniziale: !!OPN && !(await st.get("pin")) } : {};
      if (request.method === "GET") {
        if (adm && !/localhost|127\.0\.0\.1/.test(url.origin) && (await st.get("origine")) !== BASEURL) await st.put("origine", BASEURL);
        // l'Admin guarda il programma come lo vede un pilota (solo lettura)
        const come = adm && url.searchParams.get("come");
        if (come) { const pc = pilotaDi(m.d, come); if (!pc) return J({ errore: "Pilota non trovato" }, 404);
          return J({ ver: row.ver, data: vista(m.d, pc.nome), io: { r: "op", n: pc.nome, id, asp: aspetti[pc.nome] || ASP_BASE, come: true } }); }
        if (+url.searchParams.get("since") === row.ver && !url.searchParams.get("all")) return J(Object.assign({ same: true, ver: row.ver }, extra));
        return J(Object.assign({ ver: row.ver, data: adm ? m.d : vista(m.d, me.n), io }, extra));
      }
      if (request.method === "PUT") {
        const txt = await request.text();
        if (txt.length > 1800000) return J({ errore: "Troppi dati" }, 413);
        let b; try { b = JSON.parse(txt); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
        // l'Admin riscrive tutto, quindi deve avere l'ultima versione; il pilota manda solo le sue cose (unisci), anche se ha lavorato senza rete
        if (b.ver !== row.ver && adm) return J({ ver: row.ver, data: m.d }, 409);
        const nd = adm ? Object.assign({}, b.data || {}, { DOCS: m.d.DOCS || [], ZONEINFO: m.d.ZONEINFO || null }) : unisci(m.d, b.data || {}, me.n);
        await scriviMain(nd, row.ver + 1);
        return J({ ver: row.ver + 1, salto: b.ver !== row.ver });
      }
    }

    // ---- documenti ----
    if (p === "/api/doc" && request.method === "POST") {
      const mime = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!TIPI_FILE[mime]) return J({ errore: "Si possono caricare PDF, foto o il file del registro di volo" }, 415);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return J({ errore: "File vuoto" }, 400);
      if (buf.byteLength > MAXDOC) return J({ errore: "Il file supera i 10 MB" }, 413);
      const did = "d" + now.toString(36) + rnd(3), pezzi = Math.ceil(buf.byteLength / PEZZO);
      for (let i = 0; i < pezzi; i++) await st.put("doc:" + did + ":" + i, buf.slice(i * PEZZO, (i + 1) * PEZZO));
      const nome = esc(decodeURIComponent(request.headers.get("x-nome") || "documento"), 120);
      await st.put("docinfo:" + did, { mime, pezzi, size: buf.byteLength, nome, da: me.n, at: now, confermato: false });
      return J({ id: did, nome, size: buf.byteLength });
    }
    // manda un documento (es. la valutazione del rischio in PDF) per email, con l'allegato; la risposta arriva all'operatore
    if (p === "/api/doc/invia" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.d); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non puoi mandarlo" }, 403);
      const a = String(b.a || "").trim(); if (!EMAIL(a)) return J({ errore: "Indirizzo email non valido" }, 400);
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(await st.get("doc:" + b.d + ":" + i));
      const buf = await new Blob(parti).arrayBuffer(), m = await leggiMain(), op = m ? String((m.d.OP || {}).nome || "").replace(/ \(dati di esempio\)/, "") : "";
      const testo = esc(String(b.testo || "").slice(0, 2000), 2000).replace(/\n/g, "<br>");
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#0F1C26;font-size:15px;line-height:1.5">${testo}<p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Inviato da ${esc(op || "l'operatore", 120)} con Quota 120. In allegato: ${esc(info.nome, 120)}.</p></div>`;
      try { await mandaMail(this.env, a, esc(String(b.oggetto || info.nome), 160), html, [{ nome: info.nome, b64: b64(buf) }], m && EMAIL((m.d.OP || {}).email) ? m.d.OP.email : null); }
      catch (e) { return J({ errore: String(e.message || e).replace(/^posta:/, "La posta non è pronta: ").slice(0, 300) }, 502); }
      return J({ ok: true });
    }
    if (p === "/api/doc/leggi" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non è tuo" }, 403);
      if (!this.env.ANTHROPIC_API_KEY) return J({ errore: "chiave" }, 503);
      if (info.mime === "image/heic") return J({ errore: "heic" }, 415);
      if (info.mime === "text/plain") return J({ errore: "Il registro di volo non si legge come documento" }, 415);
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(new Uint8Array(await st.get("doc:" + b.id + ":" + i)));
      const tutto = new Uint8Array(info.size); let o = 0; for (const x of parti) { tutto.set(x, o); o += x.length; }
      const m = await leggiMain();
      try { const letto = await leggiConClaude(this.env, b64(tutto.buffer), info.mime, m ? m.d : {}); return J({ letto }); }
      catch (e) { return J({ errore: String(e.message || e) }, 502); }
    }
    if (p === "/api/doc/conferma" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non è tuo" }, 403);
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, dest = b.dest || {};
      const k2 = ["pilota", "drone", "operatore", "altro"].includes(dest.k) ? dest.k : "altro";
      if (!adm) { const mio = pilotaDi(d, me.n); if (!(k2 === "pilota" && mio && +dest.id === mio.id)) return J({ errore: "Puoi caricare solo i tuoi documenti" }, 403); }
      const cat = {}; for (const [c, arr] of Object.entries(b.categorie || {}).slice(0, 20)) cat[esc(c, 60)] = (arr || []).slice(0, 40).map(r => [esc(r[0], 80), esc(r[1], 300)]);
      const dati = { numero: esc((b.dati || {}).numero, 60), rilascio: DATA((b.dati || {}).rilascio), scadenza: DATA((b.dati || {}).scadenza) };
      const doc = { id: b.id, nome: info.nome, mime: info.mime, tipo: esc(b.tipo, 120) || "Documento", dest: { k: k2, id: dest.id == null ? null : +dest.id, voce: esc(dest.voce, 30) },
        dati, categorie: cat, data: oggi(), da: me.n };
      d.DOCS = (d.DOCS || []).filter(x => x.id !== b.id); d.DOCS.unshift(doc);
      applicaDoc(d, doc);
      info.confermato = true; await st.put("docinfo:" + b.id, info);
      await scriviMain(d, m.row.ver + 1);
      return J({ ok: true, ver: m.row.ver + 1 });
    }
    if (p === "/api/doc/file") {
      const did = url.searchParams.get("d") || "", info = await st.get("docinfo:" + did);
      if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!adm) { const m = await leggiMain(), doc = m && (m.d.DOCS || []).find(x => x.id === did); const suoVolo = m && (m.d.VOLI || []).some(v => v.docLog === did && (v.pilota === me.n || permDi(m.d, me.n).voliTutti));
        if (!(info.da === me.n || suoVolo || (doc && docVisibile(m.d, doc, me.n)))) return J({ errore: "Non puoi vederlo" }, 403); }
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(await st.get("doc:" + did + ":" + i));
      return new Response(new Blob(parti, { type: info.mime }), { headers: { "content-type": info.mime, "cache-control": "private, no-store",
        "content-disposition": "inline; filename=\"" + info.nome.replace(/[^\w.\- ]/g, "_") + "\"" } });
    }
    return J({ errore: "Non trovato" }, 404);
  }
}

Stato.prototype.avvisi = async function (prova, origine) {
  const st = this.ctx.storage, row = await st.get("main"); if (!row) return { ok: false, motivo: "nessun dato" };
  const d = JSON.parse(row.json), A = d.AVVISI || {}, oggi = oggiRoma();
  if (!prova) {
    if ((+A.ora || 7) !== oggi.ora) return { ok: true, saltato: "non è l'ora" };
    if ((await st.get("avvisi:giorno")) === oggi.data) return { ok: true, saltato: "già fatto oggi" };
    await st.put("avvisi:giorno", oggi.data);
  }
  const soglie = (Array.isArray(A.giorni) && A.giorni.length ? A.giorni : [60, 30, 7, 0]).map(Number).sort((a, b) => b - a);
  const inviati = (await st.get("avvisi:inviati")) || {}, nuovi = [];
  // una scadenza si manda quando passa una soglia (e una volta sola per soglia)
  const righe = [];
  for (const [k, t, s, data, pid] of scadenze(d)) {
    const ts = dtS(data); if (ts == null) continue;
    const g = Math.round((ts - oggi.t) / 86400000), dentro = soglie.filter(x => x >= g), sg = dentro.length ? Math.min(...dentro) : null;
    if (sg == null && g >= 0) continue;
    const chiave = k + "|" + data + "|" + (g < 0 ? "scaduto" : sg);
    if (!prova && inviati[chiave]) continue;
    if (prova && g > soglie[0]) continue;
    righe.push({ t, s, g, pid }); if (!prova) nuovi.push(chiave);
  }
  for (const [k, t, s] of battPeggio(d)) { if (!prova && inviati[k]) continue; righe.push({ t, s, g: null, pid: null }); if (!prova) nuovi.push(k); }
  for (const [k, t, s] of manutenzioni(d)) { if (!prova && inviati[k]) continue; righe.push({ t, s, g: null, pid: null }); if (!prova) nuovi.push(k); }
  righe.sort((a, b) => (a.g == null ? 999 : a.g) - (b.g == null ? 999 : b.g));
  const nomeOp = String((d.OP || {}).nome || "").replace(/ \(dati di esempio\)/, ""), url = (await st.get("origine")) || origine || "", esiti = [];
  const adm = A.adm || {};
  if (prova && !EMAIL(adm.email)) throw new Error("Scrivi prima la tua email e salva");
  if (adm.on !== false && EMAIL(adm.email) && (righe.length || prova)) {
    const ogg = prova ? "Prova degli avvisi di Quota 120" : pl0(righe.length, "scadenza in arrivo", "scadenze in arrivo") + (nomeOp ? " · " + nomeOp : "");
    await mandaMail(this.env, adm.email.trim(), ogg, righe.length ? mailHtml(nomeOp, righe, true, url) : mailHtml(nomeOp, [{ t: "Nessuna scadenza in arrivo", s: "Gli avvisi funzionano: quando qualcosa starà per scadere riceverai una mail come questa.", g: null }], true, url));
    esiti.push(adm.email.trim());
  }
  if (!prova) for (const p of d.PILOTI || []) {
    const c = (A.piloti || {})[p.id] || {}, pe = ((d.SCHEDEP || {})[p.id] || {}).email || "", em = EMAIL(c.email) ? c.email : pe, on = c.on !== undefined ? !!c.on : !!pe;
    if (!on || !EMAIL(em)) continue;
    const mie = righe.filter(r => r.pid === p.id); if (!mie.length) continue;
    await mandaMail(this.env, em.trim(), pl0(mie.length, "tua scadenza in arrivo", "tue scadenze in arrivo"), mailHtml(nomeOp, mie, false, url)); esiti.push(em.trim());
  }
  if (nuovi.length) { for (const k of nuovi) inviati[k] = oggi.data; await st.put("avvisi:inviati", inviati); }
  return { ok: true, mandate: esiti, righe: righe.length };
};
const pl0 = (n, s, p) => n + " " + (n === 1 ? s : p);

/* ---------- registro delle iscrizioni (un solo contenitore, "registro") ----------
   op:<spazio> → operatore · em:<email> → i suoi spazi · att:<email> → codice in attesa · elenco → tutti gli spazi */
Stato.prototype.registro = async function (request, url, p) {
  const st = this.ctx.storage, now = Date.now(), env = this.env, POST = request.method === "POST";
  const ip = request.headers.get("cf-connecting-ip") || "x";
  const corpo = async () => { try { return await request.json(); } catch (e) { return {}; } };
  const troppi = async (k, max, ms) => { const r = (await st.get(k)) || { n: 0, t: now }; if (now - r.t > ms) { r.n = 0; r.t = now; } r.n++; await st.put(k, r); return r.n > max; };
  const mail = b => String(b.email || "").trim().toLowerCase();
  const spazio = op => env.STATO.get(env.STATO.idFromName("op:" + op));
  const manda = async (email, dati) => {
    const prima = await st.get("att:" + email);
    if (prima && now - prima.inviato < 60000) return J({ errore: "Ti ho appena mandato un codice: aspetta un minuto prima di chiederne un altro" }, 429);
    if (await troppi("lim:mail:" + email, 8, 86400000)) return J({ errore: "Troppi codici chiesti oggi per questa email: riprova domani" }, 429);
    const codice = cod6();
    await st.put("att:" + email, Object.assign({ codice, scad: now + 15 * 60000, tent: 0, inviato: now }, dati));
    const op = dati.op ? (await st.get("op:" + dati.op)) || {} : {};
    try { await mandaMail(env, email, "Il tuo codice per Quota 120: " + codice, codiceHtml(dati.nome || op.adm || "", dati.nomeOp || op.nome || "", codice, dati.tipo === "iscrizione")); }
    catch (e) { await st.delete("att:" + email); return J({ errore: "Non sono riuscito a mandare l'email: riprova tra poco" }, 502); }
    return J({ ok: true });
  };

  // il nome dell'operatore, per la pagina di entrata del pilota
  if (p === "/api/registro/info") {
    const op = String(url.searchParams.get("op") || "").toLowerCase(), x = SLUG_OK(op) ? await st.get("op:" + op) : null;
    return x ? J({ nome: x.nome }) : J({ errore: "non trovato" }, 404);
  }
  // iscrizione: dati dell'operatore, poi il codice via email
  if (p === "/api/registro/iscrivi" && POST) {
    if (await troppi("lim:isc:" + ip, 6, 86400000)) return J({ errore: "Troppe iscrizioni da questa rete oggi: riprova domani" }, 429);
    const b = await corpo(), email = mail(b);
    const nomeOp = esc(String(b.op || "").replace(/\s+/g, " ").trim(), 80), nome = esc(String(b.nome || "").replace(/\s+/g, " ").trim(), 80), df = esc(String(b.df || "").trim(), 40);
    if (nomeOp.length < 2) return J({ errore: "Scrivi il nome dell'operatore." }, 400);
    if (nome.length < 3) return J({ errore: "Scrivi il tuo nome e cognome." }, 400);
    if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
    if (!b.ok) return J({ errore: "Per continuare spunta l'accettazione delle condizioni d'uso e della privacy." }, 400);
    if (((await st.get("em:" + email)) || []).length) return J({ errore: "Con questa email c'è già uno spazio: torna indietro e tocca Admin per entrare." }, 409);
    return manda(email, { tipo: "iscrizione", nomeOp, nome, df });
  }
  // entrata dell'Admin: il codice arriva all'email dello spazio
  if (p === "/api/registro/codice" && POST) {
    if (await troppi("lim:cod:" + ip, 30, 3600000)) return J({ errore: "Troppe richieste: riprova tra un'ora" }, 429);
    const b = await corpo(), email = mail(b);
    if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
    const ops = (await st.get("em:" + email)) || [];
    if (!ops.length) return J({ errore: "Questa email non risulta iscritta a Quota 120. Controlla di averla scritta giusta." }, 404);
    const op = ops.includes(b.op) ? b.op : ops[0];
    return manda(email, { tipo: "accesso", op });
  }
  // il codice giusto: crea lo spazio (iscrizione) o fa entrare l'Admin da questo telefono
  if (p === "/api/registro/verifica" && POST) {
    const b = await corpo(), email = mail(b), c = String(b.codice || "").replace(/\D/g, "");
    const a = await st.get("att:" + email);
    if (!a || now > a.scad) return J({ errore: "Il codice è scaduto o non è stato chiesto: chiedine uno nuovo." }, 410);
    if (a.tent >= 5) return J({ errore: "Troppi tentativi sbagliati: chiedi un codice nuovo." }, 429);
    if (c !== a.codice) { a.tent++; await st.put("att:" + email, a); return J({ errore: "Codice sbagliato: controlla l'ultima email arrivata." }, 403); }
    await st.delete("att:" + email);
    if (a.tipo === "iscrizione") {
      if (((await st.get("em:" + email)) || []).length) return J({ errore: "Con questa email c'è già uno spazio: tocca Admin per entrare." }, 409);
      let base = nomeSpazio(a.nomeOp), op = base, n = 1;
      while (RISERVATI.has(op) || !SLUG_OK(op) || (await st.get("op:" + op))) op = base.slice(0, 34) + "-" + (++n);
      const data = { OP: { nome: a.nomeOp, codice: a.df, resp: a.nome, dfReg: "", dfAbb: "", email, tel: "" } };
      const r = await spazio(op).fetch("https://q/interno/crea", { method: "POST", headers: { "x-q120-op": op, "content-type": "application/json" }, body: JSON.stringify({ email, data }) });
      if (!r.ok) return J({ errore: "Non sono riuscito a creare lo spazio: riprova." }, 500);
      const dev = await r.json();
      await st.put("op:" + op, { nome: a.nomeOp, email, adm: a.nome, df: a.df, at: now });
      await st.put("em:" + email, [op]);
      const L = (await st.get("elenco")) || []; L.push(op); await st.put("elenco", L);
      return J(Object.assign({ op, nuovo: true }, dev));
    }
    const r = await spazio(a.op).fetch("https://q/interno/nuovoadmin", { method: "POST", headers: { "x-q120-op": a.op, "content-type": "application/json" }, body: JSON.stringify({ email }) });
    if (!r.ok) return J({ errore: "Lo spazio non risponde: riprova." }, 500);
    return J(Object.assign({ op: a.op }, await r.json()));
  }
  return J({ errore: "Richiesta sconosciuta" }, 404);
};

export default {
  async scheduled(evento, env, ctx) {
    const main = env.STATO.get(env.STATO.idFromName("main"));
    ctx.waitUntil(main.fetch("https://quota120.interno/interno/avvisi").catch(() => {}));
    // gli avvisi di ogni spazio
    ctx.waitUntil((async () => {
      const L = await env.STATO.get(env.STATO.idFromName("registro")).fetch("https://quota120.interno/interno/elenco").then(r => r.json()).catch(() => []);
      for (const op of L) await env.STATO.get(env.STATO.idFromName("op:" + op)).fetch("https://quota120.interno/interno/avvisi", { headers: { "x-q120-op": op } }).catch(() => {});
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    const main = () => env.STATO.get(env.STATO.idFromName("main"));
    // nessuno da fuori può dire di essere uno spazio: l'intestazione la mette solo questo smistatore
    const pulita = (op) => { const r = new Request(request); r.headers.delete("x-q120-op"); if (op) r.headers.set("x-q120-op", op); return r; };
    if (p === "/api/salute") { const c = n => !!(env[n] && String(env[n]).trim()); const r = await main().fetch(pulita()).then(x => x.json()).catch(() => ({})); return Response.json({ ...r, worker: { RESEND_API_KEY: c("RESEND_API_KEY"), ANTHROPIC_API_KEY: c("ANTHROPIC_API_KEY"), DJI_API_KEY: c("DJI_API_KEY"), nomi: Object.keys(env).filter(k => /KEY/.test(k)) } }); }
    if (p.startsWith("/api/registro/")) return env.STATO.get(env.STATO.idFromName("registro")).fetch(pulita());
    if (p.startsWith("/api/")) {
      const op = String(request.headers.get("x-op") || url.searchParams.get("op") || "").toLowerCase();
      if (!op || op === "prova") return main().fetch(pulita());
      if (!SLUG_OK(op)) return J({ errore: "operatore" }, 404);
      return env.STATO.get(env.STATO.idFromName("op:" + op)).fetch(pulita(op));
    }
    if (p.startsWith("/interno/") && env.POSTA_FINTA === "1") {   // solo per le prove in locale
      const q = url.searchParams.get("do") || "", stub = q === "registro" ? env.STATO.get(env.STATO.idFromName("registro")) : SLUG_OK(q) ? env.STATO.get(env.STATO.idFromName("op:" + q)) : main();
      return stub.fetch(pulita(SLUG_OK(q) ? q : ""));
    }
    // /prova e /<spazio> aprono il programma; / è l'ingresso
    const seg = p.replace(/^\/+|\/+$/g, "");
    if (seg && !seg.includes("/") && !seg.includes(".") && (seg === "prova" || SLUG_OK(seg.toLowerCase()))) return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return env.ASSETS.fetch(request);
  }
};
