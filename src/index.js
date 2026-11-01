import CORSI_SEME from "./corso_seed.json";
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

// impronta delle scene di una lezione: il nome del video cambia quando cambiano le scene
// video dei corsi delle aziende: si aprono solo con la firma che dà il programma a chi è dentro (vale 1-2 giorni)
let CHIAVE_V = null;
async function chiaveVideo(env) { if (!CHIAVE_V) { const k = await env.STATO.get(env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/chiave-video")).then(r => r.text()); CHIAVE_V = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); } return CHIAVE_V; }
async function firmaV(env, nome, exp) { const s = await crypto.subtle.sign("HMAC", await chiaveVideo(env), new TextEncoder().encode(nome + "|" + exp)); return [...new Uint8Array(s)].slice(0, 16).map(x => x.toString(16).padStart(2, "0")).join(""); }
async function vh(scene) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(scene || []))); return [...new Uint8Array(b)].slice(0, 5).map(x => x.toString(16).padStart(2, "0")).join(""); }
async function corsiConVideo(env, url, corsi, adm) {
  const out = [];
  for (const c of corsi) { const cc = Object.assign({}, c, { lezioni: [] });
    for (const l of c.lezioni || []) { const h = await vh(l.scene), f = (c.tok ? "az-" + c.tok + "-" : "") + l.id + "-" + h;
      const pronto = (l.scene || []).length ? await env.ASSETS.fetch(new Request(url.origin + "/corso/video/" + f + ".mp4", { method: "HEAD" })).then(r => r.ok).catch(() => false) : false;
      const audio = pronto ? await env.ASSETS.fetch(new Request(url.origin + "/corso/video/" + f + ".m4a", { method: "HEAD" })).then(r => r.ok).catch(() => false) : false;
      const x = Object.assign({}, l, { video: pronto ? f : "", pronto, audio }); if (c.tok && pronto) { const e = (Math.floor(Date.now() / 86400000) + 2) * 86400; x.fv = "?s=" + e + "." + await firmaV(env, f, e); } if (!adm) { x.testo = (l.scene || []).map(s => s.v).filter(Boolean); delete x.scene; } cc.lezioni.push(x); }
    out.push(cc); }
  return out;
}
// controllo anti-robot di Cloudflare (Turnstile): attivo solo quando c'è la chiave segreta TURNSTILE_SECRET
async function antiRobot(env, corpo, request) {
  if (!env.TURNSTILE_SECRET) return true;
  let ts = ""; try { ts = String(JSON.parse(corpo).ts || ""); } catch (e) {}
  if (!ts) return false;
  const f = new FormData(); f.append("secret", env.TURNSTILE_SECRET); f.append("response", ts);
  const ip = request.headers.get("cf-connecting-ip"); if (ip) f.append("remoteip", ip);
  const j = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f }).then(r => r.json()).catch(() => ({}));
  return !!j.success;
}
// gettone OIDC di GitHub Actions: firmato da GitHub, valido solo per il repository zonerosse/quota120
async function gettoneGithub(auth) {
  try {
    const t = auth.replace(/^Bearer\s+/i, ""), [h64, p64, s64] = t.split("."); if (!s64) return false;
    const dec = x => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((x.length + 3) % 4)), c => c.charCodeAt(0));
    const H = JSON.parse(new TextDecoder().decode(dec(h64))), P = JSON.parse(new TextDecoder().decode(dec(p64)));
    if (P.iss !== "https://token.actions.githubusercontent.com" || P.aud !== "quota120" || P.repository !== "zonerosse/quota120" || !(P.exp * 1000 > Date.now())) return false;
    const jwks = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks").then(r => r.json());
    const k = (jwks.keys || []).find(x => x.kid === H.kid); if (!k) return false;
    const key = await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, dec(s64), new TextEncoder().encode(h64 + "." + p64));
  } catch (e) { return false; }
}
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const cod4 = () => String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
const esc = (v, max = 500) => String(v == null ? "" : v).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c])).slice(0, max);
// testo «crudo» da salvare: senza caratteri di controllo e tagliato (righe = tiene gli a capo); l'HTML si fa solo nelle email, con esc
const TX = (v, max = 500, righe = false) => String(v == null ? "" : v).replace(righe ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, " ").slice(0, max);
// nomi di file arrivati codificati: se la codifica è sbagliata si tiene com'è (niente errore)
const dec = s => { try { return decodeURIComponent(s); } catch (e) { return String(s); } };
const SPENTA_PROVA = () => J({ errore: "Nella versione di prova questa funzione è spenta" }, 403);
const MAX_MAIN = 1900000;                    // byte massimi dei dati di uno spazio (il limite di Cloudflare è circa 2 MB)
const giornoUTC = () => new Date().toISOString().slice(0, 10);
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
  if (!v.contato) return d;
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
    dev: NUM(v.dev, 0, 5), celle: Array.isArray(v.celle) ? v.celle.slice(0, 14).map(x => NUM(x, 0, 10)) : [], batt: TX(v.batt, 40), bsn: TX(v.bsn, 60),
    sn: TX(v.sn, 60), logKey: TX(v.logKey, 120), fine: TX(v.fine, 5), sec: NUM(v.sec, 0, 86400),
    prof: Array.isArray(v.prof) ? v.prof.slice(0, 160).map(x => Math.round(NUM(x, -999, 9999))) : [],
    trk: Array.isArray(v.trk) ? v.trk.slice(0, 420).filter(p => Array.isArray(p) && p.length >= 2).map(p => [NUM(p[0], -90, 90), NUM(p[1], -180, 180), Math.round(NUM(p[2], -999, 9999))]) : [],
    distMax: NUM(v.distMax, 0, 999999), haTrk: !!v.haTrk, daFoto: !!v.daFoto, fotoDoc: TX(v.fotoDoc, 40) };
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
  // la firma dell'operatore mai; il documento D-Flight (dell'azienda) solo con il permesso «enac», come in docVisibile
  v.OP = Object.assign({}, d.OP, { firma: undefined }, P.enac ? {} : { dfDoc: undefined }); v.MATR = d.MATR;
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
  if (!P.clienti && me) v.LAVORI = (d.LAVORI || []).filter(l => l.pilota === me.id).map(l => ({ id: l.id, codice: l.codice, cliente: l.cliente, titolo: l.titolo, tipo: l.tipo, luogo: l.luogo, data: l.data, drone: l.drone, pilota: l.pilota, stato: l.stato, missione: l.missione, dove: l.dove, perche: l.perche, importo: null }));
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
// docOk: i documenti caricati da questo pilota (li controlla il server prima): solo questi può allegare a un volo
const LISTA = a => Array.isArray(a) ? a : [];
function unisci(full, m, n, docOk) {
  const d = JSON.parse(JSON.stringify(full));
  if (!m || typeof m !== "object" || Array.isArray(m)) m = {};
  const vecchi = new Map((d.VOLI || []).map(v => [String(v.id), v]));
  let nuoviVoli = 0;
  for (const v of LISTA(m.VOLI).slice(0, 2000)) {
    if (!v || v.pilota !== n) continue;
    const id = String(v.id || ""); if (!/^\d{1,16}$/.test(id)) continue;
    const o = vecchi.get(id);
    if (o && o.pilota !== n) continue;                       // non può toccare i voli degli altri
    if (!o && ++nuoviVoli > 200) continue;                   // al massimo 200 voli nuovi per salvataggio
    // il registro allegato: resta quello salvato; uno nuovo solo se il file l'ha caricato lui
    const dl = TX(v.docLog, 40), docLog = (o && o.docLog) || (dl && docOk && docOk.has(dl) ? dl : "");
    const pulito = { id: +id, data: DATA(v.data) || oggi(), ora: TX(v.ora, 5), drone: TX(v.drone, 80), pilota: n, luogo: TX(v.luogo, 120),
      min: Math.max(0, Math.min(600, +v.min || 0)), stato: ["completo", "dacompl", "attesa"].includes(v.stato) ? v.stato : "dacompl",
      ctrl: !!v.ctrl, ctrlOra: TX(v.ctrlOra, 5), cliente: TX(v.cliente, 200), note: TX(v.note, 2000, true), importato: !!v.importato, amano: !!v.amano,
      cat: TX(v.cat, 60), inc: TX(v.inc, 60), codLav: TX(v.codLav, 20), meteo: TX(v.meteo, 160), zona: TX(v.zona, 200), notam: TX(v.notam, 300), ck: TX(v.ck, 400), dopo: v.dopo && typeof v.dopo === "object" ? { drone: !!v.dopo.drone, batt: !!v.dopo.batt, succ: !!v.dopo.succ } : undefined, docLog, logNome: TX(v.logNome, 120) };
    // i dati letti dal registro li scrive solo il server (/api/volo/importa): il telefono non li può cambiare
    if (o && o.letto) Object.assign(pulito, pulisciLetto(o), { drone: o.drone, data: o.data, ora: o.ora, min: o.min, pilota: o.pilota });
    if (o) Object.assign(o, pulito); else { d.VOLI = d.VOLI || []; d.VOLI.unshift(pulito); }
  }
  const zk = z => z.data + "|" + z.ora + "|" + z.drone + "|" + z.pilota, zs = new Set((d.ZONE || []).map(zk));
  for (const z of LISTA(m.ZONE).slice(0, 50)) {
    if (!z || z.pilota !== n) continue;
    const pz = { data: DATA(z.data) || oggi(), ora: TX(z.ora, 5), drone: TX(z.drone, 80), pilota: n, esito: TX(z.esito, 200) };
    if (!zs.has(zk(pz))) { d.ZONE = d.ZONE || []; d.ZONE.unshift(pz); zs.add(zk(pz)); }
  }
  d.ZONE = (d.ZONE || []).slice(0, 2000);
  // polizza RC personale: il pilota cambia solo la sua; la verifica e il documento li tiene il server
  if (m.SCHEDEP && typeof m.SCHEDEP !== "object") m.SCHEDEP = null;
  const me = pilotaDi(d, n), mp = me && ((m.SCHEDEP || {})[me.id] || {}).polizza;
  if (me && m.SCHEDEP && (m.SCHEDEP[me.id] || m.SCHEDEP[String(me.id)])) {
    const sp = (d.SCHEDEP = d.SCHEDEP || {})[me.id] = d.SCHEDEP[me.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} }, o = sp.polizza;
    if (mp && typeof mp === "object") {
      const q = { comp: TX(mp.comp, 80), num: TX(mp.num, 60), mass: TX(mp.mass, 40), scad: DATA(mp.scad) || "" };
      if (o && o.doc) q.doc = o.doc;
      if (o && o.ver && o.scad === q.scad && o.num === q.num) q.ver = o.ver;
      sp.polizza = q;
    } else if (o) delete sp.polizza;
  }
  // telefono ed email del pilota: li scrive lui nel suo Account
  if (me && m.SCHEDEP) {
    const x = m.SCHEDEP[me.id] || m.SCHEDEP[String(me.id)];
    if (x && typeof x === "object") { const sp = (d.SCHEDEP = d.SCHEDEP || {})[me.id] = d.SCHEDEP[me.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
      if (typeof x.tel === "string") sp.tel = TX(x.tel, 30); if (typeof x.email === "string") sp.email = EMAIL(x.email) ? x.email.trim().slice(0, 120) : "";       if (x.dfOk && typeof x.dfOk === "object") sp.dfOk = { il: DATA(x.dfOk.il) || oggi() }; else if ("dfOk" in sp) delete sp.dfOk; }
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
      for (const r of x.storia.slice(0, 10)) { if (!Array.isArray(r) || ha.has(JSON.stringify(r))) continue; const p = [DATA(r[0]) || oggi(), TX(r[1], 300)]; if (!/registrato da /.test(p[1])) p[1] += " · registrato da " + n; nuovi.push(p); }
      if (!nuovi.length) continue;
      sc.storia = nuovi.concat(sc.storia || []).slice(0, 200);
      if (x.man && typeof x.man === "object") sc.man = Object.assign(sc.man || {}, { perc: Math.max(0, Math.min(100, +x.man.perc || 0)), liv: ["ok", "warn", "ko"].includes(x.man.liv) ? x.man.liv : (sc.man || {}).liv, mancano: TX(x.man.mancano, 40), prox: TX(x.man.prox, 120) });
      const md = LISTA(m.DRONI).find(y => y && y.id === dr.id); if (md && ["ok", "warn", "ko"].includes(md.manut)) dr.manut = md.manut;
    }
  }
  // missione pianificata: il pilota la salva nei lavori assegnati a lui (o in tutti, con il permesso «clienti»)
  for (const x of LISTA(m.LAVORI).slice(0, 500)) {
    if (!x || !x.missione) continue;
    const l = (d.LAVORI || []).find(y => y.id === x.id); if (!l || !(permDi(d, n).clienti || (me && l.pilota === me.id))) continue;
    const ms = pulisciMissione(x.missione); if (ms) { ms.da = n; l.missione = ms; }
  }
  // confini dei campi: i piloti con il permesso «agricoltura» li possono mettere (anche camminando il bordo)
  if (permDi(d, n).agri) for (const x of LISTA(m.CAMPI).slice(0, 500)) {
    if (!x || !Array.isArray(x.geo)) continue; const c = (d.CAMPI || []).find(y => y.id === x.id); if (!c) continue;
    const geo = x.geo.slice(0, 500).filter(p => Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1]) && Math.abs(+p[0]) <= 90 && Math.abs(+p[1]) <= 180).map(p => [+(+p[0]).toFixed(7), +(+p[1]).toFixed(7)]);
    if (geo.length >= 3 && JSON.stringify(geo) !== JSON.stringify(c.geo || [])) { c.geo = geo; c.ha = Math.max(0, Math.min(100000, +x.ha || 0)); c.confini = true; delete c.poly; }
  }
  // valutazioni del rischio: il pilota aggiunge o cambia solo le sue
  const rv = new Map((d.RISCHI || []).map(r => [r.id, r]));
  let nuoviR = 0;
  for (const r of LISTA(m.RISCHI).slice(0, 300)) {
    if (!r || typeof r !== "object" || !/^R[a-z0-9]{4,14}$/.test(String(r.id || ""))) continue;
    const o = rv.get(r.id); if (o && o.firma !== n) continue;
    if (!o && (++nuoviR > 20 || (d.RISCHI || []).length >= 1000)) continue;   // al massimo 20 nuove per salvataggio, 1000 in tutto
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
      sp.att = sp.att || {};
      sp.att[s.voce] = Object.assign(sp.att[s.voce] || {}, { num: TX(c.numero, 60) || (sp.att[s.voce] || {}).num || "", ril: DATA(c.rilascio) || (sp.att[s.voce] || {}).ril || "", scad: DATA(c.scadenza) || (sp.att[s.voce] || {}).scad || "", file: true, doc: doc.id });
      const p = (d.PILOTI || []).find(x => x.id === s.id); if (p) { p.att = p.att || []; if (!p.att.includes(s.voce)) p.att.push(s.voce); if (s.voce === "STS-01") p.sts = true; }
    }
    if (s.voce === "polizza") { const q = sp.polizza || {};
      sp.polizza = { comp: TX(c.compagnia, 80) || q.comp || "", num: TX(c.numero, 60) || q.num || "", mass: TX(c.massimale, 40) || q.mass || "", scad: DATA(c.scadenza) || q.scad || "", doc: doc.id }; }
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
const RISERVATI = new Set(["api", "corso", "interno", "prova", "privacy", "condizioni", "condividi", "leaflet", "lib", "dji", "index", "admin", "www", "app", "quota120", "registro", "iscriviti", "entra", "assistenza"]);
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
  // ogni errore imprevisto torna come JSON (mai la pagina d'errore di Cloudflare)
  async fetch(request) {
    try { return await this.gestisci(request); }
    catch (e) {
      if (e && e.pieno) return J({ errore: "Spazio pieno: i dati di questo spazio hanno raggiunto il limite. Elimina voli o documenti vecchi, oppure scrivi all'assistenza." }, 413);
      console.error("Stato:", e && e.stack || e); return J({ errore: "Errore interno" }, 500);
    }
  }
  async gestisci(request) {
    const url = new URL(request.url), st = this.ctx.storage, p = url.pathname;
    if (p.startsWith("/api/registro/")) return this.registro(request, url, p);
    if (p === "/interno/elenco") return J((await st.get("elenco")) || []);
    // registro dei problemi dell'app (errori e messaggi «Qualcosa non funziona?»): lo legge l'Admin del sito nel Pannello
    if (p === "/interno/log" && request.method === "POST") {
      const { b, op, ip, ua } = await request.json().catch(() => ({}));
      if (!b || typeof b !== "object") return J({ ok: false });
      const ora = Date.now(), s = (x, m) => String(x == null ? "" : x).slice(0, m), ch = "logn:" + s(ip, 60) + ":" + Math.floor(ora / 36e5);
      const n = ((await st.get(ch)) || 0) + 1; await st.put(ch, n); if (n > 40) return J({ ok: false, troppi: true });
      if (b.tipo === "mess" && n > 6) return J({ ok: false, troppi: true });
      const tipo = b.tipo === "mess" ? "mess" : "err", fp = tipo === "err" ? "logfp:" + s(op, 40) + ":" + s(b.msg, 160) + "|" + s(b.vista, 40) : "";
      if (fp) { const f = await st.get(fp); const e = f && await st.get(f.id);
        if (e && ora - e.ult < 864e5) { e.n = (e.n || 1) + 1; e.ult = ora; e.risolto = false; e.passi = (Array.isArray(b.passi) ? b.passi : []).slice(-30).map(x => s(x, 160)); await st.put(f.id, e); await st.put(fp, { id: f.id, at: ora }); return J({ ok: true }); } }
      const id = "log:" + String(ora).padStart(14, "0") + ":" + Math.random().toString(36).slice(2, 7);
      const e = { id, tipo, op: s(op, 40), opn: s(b.opn, 80), chi: s(b.chi, 80), ruolo: s(b.ruolo, 40), testo: s(b.testo, 2000), msg: s(b.msg, 600), stack: s(b.stack, 1500), vista: s(b.vista, 60),
        rete: s(b.rete, 30), schermo: s(b.schermo, 20), ua: s(ua, 220), email: s(b.email, 120), passi: (Array.isArray(b.passi) ? b.passi : []).slice(-30).map(x => s(x, 160)), at: ora, ult: ora, n: 1 };
      await st.put(id, e); if (fp) await st.put(fp, { id, at: ora });
      return J({ ok: true, id });
    }
    if (p === "/interno/log") return J([...(await st.list({ prefix: "log:", reverse: true, limit: 300 })).values()]);
    if (p === "/interno/log/risolto" && request.method === "POST") { const b = await request.json().catch(() => ({})); const e = b.id && String(b.id).startsWith("log:") && await st.get(b.id); if (e) { e.risolto = !!b.on; await st.put(b.id, e); } return J({ ok: !!e }); }
    if (p === "/interno/log/pulizia") { const ora = Date.now(), via = [];
      for (const [k, v] of await st.list({ prefix: "log:", limit: 1000 })) { if (ora - (v.ult || v.at) > 30 * 864e5) via.push(k); }
      for (const [k] of await st.list({ prefix: "logn:", limit: 1000 })) { if (+k.split(":").pop() < Math.floor(ora / 36e5) - 2) via.push(k); }
      for (const [k, v] of await st.list({ prefix: "logfp:", limit: 1000 })) { if (ora - (v.at || 0) > 2 * 864e5) via.push(k); }
      for (let i = 0; i < via.length; i += 128) await st.delete(via.slice(i, i + 128));
      return J({ ok: true, tolti: via.length }); }
    if (p === "/interno/chiave-video") { let k = await st.get("chiave-video"); if (!k) { k = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join(""); await st.put("chiave-video", k); } return new Response(k); }
    if (p === "/interno/operatori") { const L = (await st.get("elenco")) || [], out = []; for (const op of L) out.push(Object.assign({ op }, (await st.get("op:" + op)) || {})); return J(out); }
    if (p === "/interno/corsi") {
      // i corsi stanno qui; quelli del seme (nel codice) entrano da soli se mancano, o se il seme ha una revisione più nuova
      const unisci = (salvati, tolti) => { const out = salvati.slice();
        for (const c of CORSI_SEME) { const i = out.findIndex(x => x.id === c.id);
          if (i < 0) { if (!tolti.includes(c.id)) out.push(c); } else if ((c.rev || "") > (out[i].rev || "")) out[i] = c; }
        return out; };
      if (request.method === "POST") {
        const b = await request.json().catch(() => null); if (!Array.isArray(b)) return J({ errore: "dati" }, 400);
        const prima = ((await st.get("corsi")) || CORSI_SEME).map(c => c.id), ora = b.map(c => c.id);
        let tolti = ((await st.get("corsi-tolti")) || []).filter(id => !ora.includes(id));
        for (const id of prima) if (!ora.includes(id) && !tolti.includes(id)) tolti.push(id);
        await st.put("corsi", b); await st.put("corsi-tolti", tolti); return J({ ok: true });
      }
      const salvati = await st.get("corsi");
      return J(salvati ? unisci(salvati, (await st.get("corsi-tolti")) || []) : CORSI_SEME);
    }
    if (p === "/interno/iscritti-n") { let n = 0, n30 = 0, nn = 0; for (const [, v] of await st.list({ prefix: "ce:" })) { n++; if (Date.now() - v.dal < 30 * 864e5) n30++; if (v.novita) nn++; } return J({ n, n30, nn }); }
    const OPN = request.headers.get("x-q120-op") || "";   // "" = versione di prova (dati di esempio)
    const creato = OPN ? await st.get("creato") : null;
    if (OPN && !creato && p !== "/interno/crea") return J({ errore: "operatore" }, 404);
    // pannello del titolare: quanto è usato lo spazio, e sospensione
    if (p === "/interno/riepilogo") {
      const m = await st.get("main"); let dd = {}; try { dd = m ? JSON.parse(m.json) : {}; } catch (e) {}
      const dsp = (await st.get("disp")) || {}, vis = Object.values(dsp).map(x => x.visto || x.at || 0);
      return J({ piloti: (dd.PILOTI || []).length, droni: (dd.DRONI || []).length, voli: (dd.VOLI || []).length, telefoni: Object.keys(dsp).length, ultimo: vis.length ? Math.max(...vis) : 0, sospeso: !!(await st.get("sospeso")) });
    }
    if (p === "/interno/corsi-az") return J((await st.get("corsi-az")) || []);
    if (p === "/interno/sospendi") { const b = await request.json().catch(() => ({})); if (b.on) await st.put("sospeso", true); else await st.delete("sospeso"); return J({ ok: true }); }
    if (OPN && p.startsWith("/api/") && await st.get("sospeso")) return J({ errore: "Questo spazio è sospeso: scrivi all'assistenza di Quota 120." }, 423);
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
    // prima di scrivere si misura: oltre il limite si ferma con «Spazio pieno» (lo trasforma in risposta fetch, qui sopra)
    const scriviMain = async (d, ver) => { const json = JSON.stringify(d);
      if (new TextEncoder().encode(json).length > MAX_MAIN) throw Object.assign(new Error("spazio pieno"), { pieno: true });
      await st.put("main", { json, ver }); };
    const PROVA = !OPN;                                       // versione di prova: chiunque può essere Admin (codice 1234)
    // Claude nella prova: al massimo 40 letture al giorno (UTC) per tutta la prova
    const limiteClaude = async () => { if (!PROVA) return null;
      const g = giornoUTC(), c = (await st.get("claude:giorno")) || {}; const n = c.g === g ? c.n || 0 : 0;
      if (n >= 40) return J({ errore: "Nella versione di prova le letture con l'intelligenza artificiale di oggi sono finite: riprova domani, oppure iscriviti per avere il tuo spazio." }, 429);
      await st.put("claude:giorno", { g, n: n + 1 }); return null; };
    // file: si cancellano i pezzi e le informazioni
    const togliFile = async did => { if (!/^d[a-z0-9]+$/.test(did || "")) return; const info = await st.get("docinfo:" + did); if (!info) return;
      for (let i = 0; i < (+info.pezzi || 0); i++) await st.delete("doc:" + did + ":" + i); await st.delete("docinfo:" + did); };
    // ... ma solo se non li usa più niente (dati dello spazio o voli arrivati)
    const togliSeLiberi = async (ids, d) => { ids = [...new Set(ids.filter(Boolean))]; if (!ids.length) return;
      const tutto = JSON.stringify(d || ((await leggiMain()) || {}).d || {}) + JSON.stringify((await st.get("arrivi")) || []);
      for (const x of ids) if (!tutto.includes('"' + x + '"')) await togliFile(x); };
    // codici personali del calendario e dell'invio dei voli: si tolgono quando la persona è bloccata o tolta
    // un codice del calendario o dell'invio vale solo se la persona c'è ancora e non è bloccata (l'Admin: se ha ancora un telefono approvato)
    const codiceValido = async (chi, d) => {
      if (!d) { const m = await leggiMain(); d = m ? m.d : {}; }
      const pc = !chi.adm && pilotaDi(d, chi.n);
      if (pc) return !blocchi[pc.id];
      return (!!chi.adm || chi.n === "Admin") && Object.values(disp).some(x => x.ruolo === "adm" && x.stato === "ok" && x.n === chi.n);
    };
    const togliCodici = async n => { for (const t of ["cal", "invio"]) { const tk = await st.get(t + ":di:" + n); if (tk) await st.delete(t + ":" + tk); await st.delete(t + ":di:" + n); } };
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
        const pi = nn && mm && nn !== "admin" ? (m.d.PILOTI || []).find(x => norm(x.nome) === nn && x.matr && norm(x.matr) === mm && !((m.d.PERM || {})[x.id] || {}).admin) : null;
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
    if (p === "/interno/avvisi") return J(PROVA ? { ok: true, saltato: "versione di prova" } : await this.avvisi(false, url.origin));
    // pulizia (una volta al giorno, dal cron): i file caricati e mai usati da più di 14 giorni
    if (p === "/interno/pulizia") {
      const g = giornoUTC(); if ((await st.get("pulizia:giorno")) === g) return J({ ok: true, saltato: "già fatto oggi" });
      await st.put("pulizia:giorno", g);
      const lim = now - 14 * 864e5, vecchi = [];
      for (const [kk, info] of await st.list({ prefix: "docinfo:" })) if (info && !info.confermato && (+info.at || 0) < lim) vecchi.push(kk.slice(8));
      await togliSeLiberi(vecchi);
      return J({ ok: true, guardati: vecchi.length });
    }
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
      if (!(await codiceValido(chi, d))) return new Response("calendario non valido", { status: 403 });
      return new Response(calendarioIcs(d, chi), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=900", "content-disposition": "inline; filename=quota120.ics" } });
    }
    if (p === "/api/invio" && request.method === "POST") {
      const tk = url.searchParams.get("t") || "", chi = tk.length >= 16 ? await st.get("invio:" + tk) : null;
      if (!chi || !(await codiceValido(chi))) return new Response("codice di invio non valido", { status: 403 });
      // il nome nell'indirizzo è già decodificato; quello nell'intestazione no
      const nome = TX(url.searchParams.get("nome") || dec(request.headers.get("x-nome") || "") || "volo.txt", 120);
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
      if (L.length > 300) await togliSeLiberi(L.slice(0, L.length - 300).map(x => x.id));   // quelli usciti dall'elenco: via i file non usati
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

    // ---- corsi dell'azienda: li prepara l'Admin, li vedono i suoi piloti ----
    if (p === "/api/corsi" && request.method === "GET") {
      const F = (await st.get("corsi-fatti")) || {};
      return J({ az: (await st.get("corsi-az")) || [], fatti: adm ? F : { [me.n]: F[me.n] || {} }, io: me.n, adm });
    }
    if (p === "/api/corsi" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin prepara i corsi" }, 403);
      const tx = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, max);
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (!Array.isArray(b) || b.length > 30) return J({ errore: "Dati non validi" }, 400);
      const pulito = b.map(c => ({ id: String(c.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "c" + now.toString(36), tok: /^[a-f0-9]{12}$/.test(c.tok || "") ? c.tok : rnd(6),
        t: tx(String(c.t || "Corso"), 120), s: tx(String(c.s || ""), 300), vis: "azienda", rev: String(c.rev || ""),
        // id in minuscolo: il nome del video (az-...) deve passare dal controllo del percorso dei video, che è in minuscolo
        lezioni: (c.lezioni || []).slice(0, 40).map(l => ({ id: String(l.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60) || "l" + now.toString(36) + rnd(2), t: tx(String(l.t || "Lezione"), 120), s: tx(String(l.s || ""), 200),
          leg: (l.leg || []).slice(0, 20).map(r => [tx(String(r[0] || ""), 80), tx(String(r[1] || ""), 300)]), h: "",
          q: (l.q || []).slice(0, 40).map(q => [tx(String(q[0] || ""), 300), (q[1] || []).slice(0, 6).map(o => tx(String(o || ""), 200)), Math.max(0, +q[2] || 0), tx(String(q[3] || ""), 400)]),
          scene: (l.scene || []).slice(0, 40).map(x => { const y = {}; for (const k of ["k", "t", "n", "v"]) if (x[k]) y[k] = tx(String(x[k]), k === "v" ? 1500 : 120); if (Array.isArray(x.p) && x.p.length) y.p = x.p.slice(0, 8).map(z => tx(String(z), 160)); if (Array.isArray(x.l) && x.l.length) y.l = x.l.slice(0, 8).map(r => [tx(String(r[0] || ""), 60), tx(String(r[1] || ""), 160)]); return y; }) })) }));
      await st.put("corsi-az", pulito); return J({ ok: true });
    }
    if (p === "/api/corsi/fatta" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const c = String(b.c || "").slice(0, 40), i = Math.floor(+b.i); if (!c || !(i >= 0 && i < 60)) return J({ errore: "Dati non validi" }, 400);
      const F = (await st.get("corsi-fatti")) || {}, M = F[me.n] = F[me.n] || {}, A = M[c] = M[c] || [];
      if (!A.includes(i)) { A.push(i); await st.put("corsi-fatti", F); }
      return J({ ok: true });
    }

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
      if (b.op === "pin") { if (PROVA) return SPENTA_PROVA(); if (!/^\d{4}$/.test(b.pin || "")) return J({ errore: "Servono 4 cifre" }, 400); await st.put("pin", b.pin); return J({ ok: true }); }
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
        if (b.op === "blocca") { blocchi[pidB] = true; for (const x of Object.values(disp)) if (suo(x)) { if (x.stato === "ok") x.stato = "bloccato"; else if (x.stato === "attesa") x.stato = "rifiutato"; }
          if (pB) await togliCodici(pB.nome); }
        else { delete blocchi[pidB]; for (const x of Object.values(disp)) if (suo(x) && x.stato === "bloccato") x.stato = "tolto"; }
        await st.put("blocchi", blocchi); await st.put("disp", disp);
        return J({ ok: true, disp: pub(), blocchi });
      }
      const x = disp[b.id]; if (!x) return J({ errore: "Dispositivo non trovato" }, 404);
      if (b.id === id && b.op === "togli") return J({ errore: "Non puoi togliere te stesso" }, 400);
      x.stato = b.op === "approva" ? "ok" : b.op === "rifiuta" ? "rifiutato" : b.op === "togli" ? "tolto" : x.stato;
      if (b.op === "approva") x.app = true;
      if (b.op === "togli" && x.n) await togliCodici(x.n);   // via anche il calendario e l'invio dei voli di quella persona
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
      if (PROVA) return SPENTA_PROVA();
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
      if (PROVA) return SPENTA_PROVA();
      if (!this.env.DJI_API_KEY) return J({ errore: "chiave_dji" }, 503);
      const txt = await request.text(); if (txt.length > 300000) return J({ errore: "Richiesta troppo grande" }, 413);
      try {
        const r = await fetch(DJI_KEYCHAINS, { method: "POST", headers: { "content-type": "application/json", "api-key": this.env.DJI_API_KEY }, body: txt });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.data) return J({ errore: "DJI non ha dato le chiavi" + (j.result && j.result.msg ? ": " + TX(j.result.msg, 200) : " (" + r.status + ")") }, 502);
        return J({ data: j.data });
      } catch (e) { return J({ errore: "DJI non risponde: riprova tra poco" }, 502); }
    }
    if (p === "/api/volo/leggifoto" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Foto non trovata" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non è tua" }, 403);
      if (!this.env.ANTHROPIC_API_KEY) return J({ errore: "chiave" }, 503);
      if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) return J({ errore: "Serve una foto JPEG o PNG" }, 415);
      { const no = await limiteClaude(); if (no) return no; }
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
      for (const f of (Array.isArray(b.foto) ? b.foto : []).slice(0, 8)) { if (typeof f !== "string") continue; const info = await st.get("docinfo:" + f); if (info && (adm || info.da === me.n)) foto.push(TX(f, 40)); }
      const x = { id: now * 10 + Math.floor(Math.random() * 10), at: now, data: DATA(b.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(b.ora || "") ? b.ora : "", pilota: adm && b.pilota ? TX(b.pilota, 80) : me.n,
        drone: dr.nome, tipo: b.tipo, feriti: !!b.feriti, danni: !!b.danni, testo: TX(b.testo, 2000, true), luogo: TX(b.luogo, 160), foto, volo: TX(b.volo, 20), fermo: true, stato: "aperta", eccairs: "" };
      // guasto trovato a terra nella check list prima del volo (il drone non ha volato): non è un evento da segnalare a ENAC
      if (b.prima === true && b.tipo === "guasto") x.prima = true;
      x.liv = x.prima ? "facolt" : livSegn(x);
      d.SEGN = d.SEGN || []; d.SEGN.unshift(x); d.SEGN = d.SEGN.slice(0, 500);
      await scriviMain(d, m.row.ver + 1);
      // mail subito all'Admin (non nella versione di prova: lì le email sono spente)
      const A = (d.AVVISI || {}).adm || {};
      if (!PROVA && EMAIL(A.email) && A.on !== false) {
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
      // il calendario «di tutti» (adm) solo a un telefono dell'Admin: un codice salvato con un altro ruolo non si riusa
      if (tk) { const r0 = await st.get("cal:" + tk); if (!r0 || !!r0.adm !== !!adm) tk = null; }
      if (!tk || url.searchParams.get("nuovo") === "1") { if (tk) await st.delete("cal:" + tk); tk = crypto.randomUUID().replace(/-/g, ""); await st.put("cal:" + tk, { n: me.n, adm: !!adm }); await st.put("cal:di:" + me.n, tk); }
      return J({ codice: tk });
    }
    if (p === "/api/invio/codice") {
      let tk = await st.get("invio:di:" + me.n);
      if (!tk || url.searchParams.get("nuovo") === "1") { if (tk) await st.delete("invio:" + tk); tk = crypto.randomUUID().replace(/-/g, ""); await st.put("invio:" + tk, { n: me.n, adm: !!adm }); await st.put("invio:di:" + me.n, tk); }
      return J({ codice: tk, ultimo: (await st.get("invio:ultimo:" + me.n)) || null });
    }
    if (p === "/api/arrivi" && request.method === "GET") {
      const L = (await st.get("arrivi")) || [];
      return J({ arrivi: L.filter(x => adm || x.da === me.n) });
    }
    if (p === "/api/arrivi" && request.method === "POST") {   // file arrivati da Android (Condividi › Quota 120) o dal telefono
      const nome = TX(dec(request.headers.get("x-nome") || "") || "volo.txt", 120), buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 30 * 1024 * 1024) return J({ errore: "File non valido" }, 400);
      const k1 = "arrivo:" + me.n + ":" + nome + ":" + buf.byteLength;
      if (await st.get(k1)) return J({ ok: true, gia: true });
      const did = "d" + now.toString(36) + rnd(3), pezzi = Math.ceil(buf.byteLength / PEZZO);
      for (let i = 0; i < pezzi; i++) await st.put("doc:" + did + ":" + i, buf.slice(i * PEZZO, (i + 1) * PEZZO));
      await st.put("docinfo:" + did, { mime: "text/plain", pezzi, size: buf.byteLength, nome, da: me.n, at: now, confermato: false });
      await st.put(k1, did);
      const L = (await st.get("arrivi")) || []; L.push({ id: did, nome, size: buf.byteLength, da: me.n, at: now, via: TX(request.headers.get("x-via") || "Android", 20) }); await st.put("arrivi", L.slice(-300));
      if (L.length > 300) await togliSeLiberi(L.slice(0, L.length - 300).map(x => x.id));   // quelli usciti dall'elenco: via i file non usati
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
      if (x) { x.sist = TX(b.motivo || "da controllare", 200); x.presa = 0; if (b.info && typeof b.info === "object") x.info = { data: TX(b.info.data, 10), ora: TX(b.info.ora, 5), drone: TX(b.info.drone, 80) }; await st.put("arrivi", L); }
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
      const via = L.filter(x => ids.has(x.id) && (adm || x.da === me.n));
      await st.put("arrivi", L.filter(x => !via.includes(x)));
      await togliSeLiberi(via.map(x => x.id));   // il file resta solo se un volo lo usa (registro allegato)
      return J({ ok: true });
    }
    // zone salvate: null = non caricate, false = file rovinato, altrimenti l'elenco (tenuto anche in this.ZC)
    const leggiZone = async () => {
      if (this.ZC) return this.ZC;
      const gen = await st.get("zone:gen"), n = gen ? gen.n : +(await st.get("zone:n")) || 0; if (!n) return null;
      let t = ""; for (let i = 0; i < n; i++) t += (await st.get(gen ? "zone:" + gen.g + ":" + i : "zone:" + i)) || "";
      try { this.ZC = JSON.parse(t); return this.ZC; } catch (e) { console.error("zone rovinate:", e); return false; }
    };
    const ZONE_ROTTE = () => J({ errore: "Le zone di volo salvate non si leggono: l'Admin le deve caricare di nuovo (Pannello Admin › Zone di volo)." }, 500);
    if (p === "/api/zone/carica" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin può caricare le zone" }, 403);
      const txt = await request.text(); if (txt.length > 40e6) return J({ errore: "File troppo grande" }, 413);
      let b; try { b = JSON.parse(txt); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const Z = Array.isArray(b.zone) ? b.zone : []; if (!Z.length) return J({ errore: "Nel file non ho trovato zone" }, 400);
      // i pezzi nuovi vanno sotto una «generazione» nuova; il puntatore zone:gen cambia per ultimo, poi si tolgono i vecchi
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const tutto = JSON.stringify(Z), PEZ = 500000, n = Math.ceil(tutto.length / PEZ), prima = await st.get("zone:gen"), g = rnd(4);
      for (let i = 0; i < n; i++) await st.put("zone:" + g + ":" + i, tutto.slice(i * PEZ, (i + 1) * PEZ));
      await st.put("zone:gen", { g, n }); this.ZC = Z;
      if (prima && prima.g) for (let i = 0; i < prima.n; i++) await st.delete("zone:" + prima.g + ":" + i);
      const vecchi = +(await st.get("zone:n")) || 0; for (let i = 0; i < vecchi; i++) await st.delete("zone:" + i); if (vecchi) await st.delete("zone:n");
      const scade = new Date(Date.now() + 28 * 864e5), ds = String(scade.getUTCDate()).padStart(2, "0") + "/" + String(scade.getUTCMonth() + 1).padStart(2, "0") + "/" + scade.getUTCFullYear();
      m.d.ZONEINFO = { data: oggiRoma().data, n: Z.length, file: TX(b.file, 120), scade: ds };
      await scriviMain(m.d, m.row.ver + 1);
      return J({ ok: true, info: m.d.ZONEINFO, ver: m.row.ver + 1 });
    }
    if (p === "/api/zone/area") {   // le zone intorno a un punto (circa 50 km), da tenere sul telefono per lavorare senza rete
      const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon");
      if (!isFinite(lat) || !isFinite(lon)) return J({ errore: "Posizione non valida" }, 400);
      const zc = await leggiZone(); if (zc === null) return J({ zone: [] }); if (zc === false) return ZONE_ROTTE();
      const dl = 0.45, dn = dl / Math.cos(lat * Math.PI / 180);
      return J({ zone: this.ZC.filter(z => { const b = z.b; return !b || !(b[2] < lat - dl || b[0] > lat + dl || b[3] < lon - dn || b[1] > lon + dn); }).slice(0, 4000) });
    }
    if (p === "/api/zone") {
      const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon");
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return J({ errore: "Posizione non valida" }, 400);
      const zc = await leggiZone(); if (zc === null) return J({ nessuna: true }); if (zc === false) return ZONE_ROTTE();
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
      await togliSeLiberi([v.docLog, v.fotoDoc], d);   // i file del volo, se non li usa nient'altro
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
      L.fotoDoc = "";   // la foto allegata la mette solo il server (qui sotto, quando completa un volo caricato con la foto)
      if (L.batt && !(d.BATT || []).some(x => x.id === L.batt)) L.batt = "";
      if (v0.codLav && !v0.cliente) { const lw = (d.LAVORI || []).find(x => norm(x.codice).replace(/\s/g, "") === norm(v0.codLav).replace(/\s/g, "")); if (lw) { v0.cliente = lw.cliente + ": " + String(lw.titolo || "").toLowerCase(); if (!v0.luogo) v0.luogo = lw.luogo; } }
      if (L.daFoto) L.logKey = "foto|" + TX(v0.drone, 80) + "|" + (DATA(v0.data) || "") + "|" + TX(v0.ora, 5);
      if (L.logKey && (d.VOLI || []).some(x => x.logKey === L.logKey)) return J({ errore: "doppio" }, 409);
      // la stessa foto (o un'altra foto dello stesso volo) caricata due volte: non si conta due volte
      if (L.daFoto && (d.VOLI || []).some(x => x.daFoto && x.pilota === pilota && x.drone === v0.drone && x.data === (DATA(v0.data) || oggi()) && x.ora === v0.ora)) return J({ errore: "doppio" }, 409);
      if (typeof b.docLog !== "string") b.docLog = "";
      if (b.docLog) { const info = await st.get("docinfo:" + b.docLog); if (!info || (!adm && info.da !== me.n)) b.docLog = ""; }
      const v = Object.assign({ id: Date.now() * 10 + Math.floor(Math.random() * 10), data: DATA(v0.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(v0.ora || "") ? v0.ora : "00:00",
        drone: v0.drone, pilota, luogo: TX(v0.luogo, 120), min: NUM(v0.min, 0, 600), stato: "completo", ctrl: !!v0.ctrl, ctrlOra: TX(v0.ctrlOra, 5),
        cliente: TX(v0.cliente, 200), codLav: TX(v0.codLav, 20), note: TX(v0.note, 2000, true), importato: true, amano: false, cat: TX(v0.cat, 60), inc: "Nessuno",
        docLog: TX(b.docLog, 40), logNome: TX(v0.logNome, 120) }, L);
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
        if (!b || typeof b !== "object" || (b.data != null && (typeof b.data !== "object" || Array.isArray(b.data)))) return J({ errore: "Dati non validi" }, 400);
        // l'Admin riscrive tutto, quindi deve avere l'ultima versione; il pilota manda solo le sue cose (unisci), anche se ha lavorato senza rete
        if (b.ver !== row.ver && adm) return J({ ver: row.ver, data: m.d }, 409);
        let nd, avviso = "", salto = b.ver !== row.ver;
        if (adm) {
          nd = Object.assign({}, b.data || {}, { DOCS: m.d.DOCS || [], ZONEINFO: m.d.ZONEINFO || null });
          // i piloti si riconoscono dal nome: niente «Admin» e niente nomi doppi (quelli già salvati prima restano, per non bloccare i salvataggi)
          const sbagliati = L => { const visti = new Set(), out = new Set(); for (const q of LISTA(L)) { const k = norm(q && q.nome); if (!k) continue; if (k === "admin" || visti.has(k)) out.add(k); visti.add(k); } return out; };
          const primaS = sbagliati(m.d.PILOTI), oraS = [...sbagliati(nd.PILOTI)].filter(k => !primaS.has(k));
          if (oraS.length) return J({ errore: oraS[0] === "admin" ? "Un pilota non si può chiamare «Admin»: scrivi il suo nome e cognome." : "Ci sono due piloti con lo stesso nome: aggiungi qualcosa per distinguerli (per esempio il secondo nome)." }, 400);
          // piloti tolti o rinominati: via i loro codici del calendario e dell'invio dei voli
          const nuovi = new Set(LISTA(nd.PILOTI).map(q => q && q.nome));
          for (const q of LISTA(m.d.PILOTI)) if (q && q.nome && !nuovi.has(q.nome)) await togliCodici(q.nome);
          // versione di prova: niente email per gli avvisi (chiunque è Admin, non deve poter mandare mail a chi vuole)
          if (PROVA && nd.AVVISI && typeof nd.AVVISI === "object") {
            const A = nd.AVVISI, ha = (A.adm && A.adm.email) || Object.values(A.piloti || {}).some(x => x && x.email);
            if (ha) { nd.AVVISI = Object.assign({}, A, { adm: Object.assign({}, A.adm, { email: "" }), piloti: Object.fromEntries(Object.entries(A.piloti || {}).map(([k3, x]) => [k3, Object.assign({}, x, { email: "" })])) });
              avviso = "Nella versione di prova gli avvisi via email sono spenti: l'email non è stata salvata."; salto = true; }
          }
        } else {
          if (b.data && b.data.VOLI != null && !Array.isArray(b.data.VOLI)) return J({ errore: "Dati non validi" }, 400);
          // i registri che il pilota allega a un volo: solo file caricati da lui
          const docOk = new Set(), conDoc = new Set((m.d.VOLI || []).filter(v => v.docLog).map(v => String(v.id)));
          for (const v of LISTA((b.data || {}).VOLI).slice(0, 2000)) { const x = v && typeof v.docLog === "string" && !conDoc.has(String(v.id)) ? v.docLog.slice(0, 40) : "";
            if (x && !docOk.has(x) && docOk.size < 50) { const info = await st.get("docinfo:" + x); if (info && info.da === me.n) docOk.add(x); } }
          nd = unisci(m.d, b.data || {}, me.n, docOk);
        }
        await scriviMain(nd, row.ver + 1);
        return J(Object.assign({ ver: row.ver + 1, salto }, avviso ? { avviso } : {}));
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
      const nome = TX(dec(request.headers.get("x-nome") || "") || "documento", 120);
      await st.put("docinfo:" + did, { mime, pezzi, size: buf.byteLength, nome, da: me.n, at: now, confermato: false });
      return J({ id: did, nome, size: buf.byteLength });
    }
    // manda un documento (es. la valutazione del rischio in PDF) per email, con l'allegato; la risposta arriva all'operatore
    if (p === "/api/doc/invia" && request.method === "POST") {
      if (PROVA) return SPENTA_PROVA();
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.d); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non puoi mandarlo" }, 403);
      const a = String(b.a || "").trim(); if (!EMAIL(a)) return J({ errore: "Indirizzo email non valido" }, 400);
      // al massimo 30 invii al giorno per spazio e 10 per telefono (giorno UTC)
      const g = giornoUTC(), cnt0 = (await st.get("invia:giorno")) || {}, cnt = cnt0.g === g ? cnt0 : { g, n: 0, disp: {} };
      if (cnt.n >= 30) return J({ errore: "Oggi sono già stati mandati 30 documenti per email da questo spazio: riprova domani." }, 429);
      if ((cnt.disp[id] || 0) >= 10) return J({ errore: "Oggi hai già mandato 10 documenti per email da questo telefono: riprova domani." }, 429);
      cnt.n++; cnt.disp[id] = (cnt.disp[id] || 0) + 1; await st.put("invia:giorno", cnt);
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(await st.get("doc:" + b.d + ":" + i));
      const buf = await new Blob(parti).arrayBuffer(), m = await leggiMain(), op = m ? String((m.d.OP || {}).nome || "").replace(/ \(dati di esempio\)/, "") : "";
      const testo = esc(String(b.testo || "").slice(0, 2000), 2000).replace(/\n/g, "<br>");
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#0F1C26;font-size:15px;line-height:1.5">${testo}<p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Inviato da ${esc(op || "l'operatore", 120)} con Quota 120. In allegato: ${esc(info.nome, 120)}.</p></div>`;
      try { await mandaMail(this.env, a, TX(b.oggetto || info.nome, 160), html, [{ nome: info.nome, b64: b64(buf) }], m && EMAIL((m.d.OP || {}).email) ? m.d.OP.email : null); }
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
      { const no = await limiteClaude(); if (no) return no; }
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(new Uint8Array(await st.get("doc:" + b.id + ":" + i)));
      const tutto = new Uint8Array(info.size); let o = 0; for (const x of parti) { tutto.set(x, o); o += x.length; }
      const m = await leggiMain();
      let letto; try { letto = await leggiConClaude(this.env, b64(tutto.buffer), info.mime, m ? m.d : {}); }
      catch (e) { return J({ errore: String(e.message || e) }, 502); }
      // quello che ha letto Claude resta col file: alla conferma si confronta con quello che manda il telefono
      const ld = (letto && letto.dest) || {}, lx = (letto && letto.dati) || {};
      info.claude = { tipo: TX(letto && letto.tipo, 120), dest: { k: TX(ld.k, 20), id: ld.id == null ? null : +ld.id, voce: TX(ld.voce, 30) },
        dati: { numero: TX(lx.numero, 60), rilascio: DATA(lx.rilascio), scadenza: DATA(lx.scadenza) }, il: now };
      await st.put("docinfo:" + b.id, info);
      return J({ letto });
    }
    if (p === "/api/doc/conferma" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!adm && info.da !== me.n) return J({ errore: "Non è tuo" }, 403);
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, dest = b.dest || {};
      const k2 = ["pilota", "drone", "operatore", "altro"].includes(dest.k) ? dest.k : "altro";
      if (!adm) { const mio = pilotaDi(d, me.n); if (!(k2 === "pilota" && mio && +dest.id === mio.id)) return J({ errore: "Puoi caricare solo i tuoi documenti" }, 403); }
      const cat = {}; for (const [c, arr] of Object.entries(b.categorie || {}).slice(0, 20)) cat[TX(c, 60)] = LISTA(arr).slice(0, 40).map(r => Array.isArray(r) ? [TX(r[0], 80), TX(r[1], 300)] : ["", TX(r, 300)]);
      const dati = { numero: TX((b.dati || {}).numero, 60), rilascio: DATA((b.dati || {}).rilascio), scadenza: DATA((b.dati || {}).scadenza) };
      const doc = { id: b.id, nome: info.nome, mime: info.mime, tipo: TX(b.tipo, 120) || "Documento", dest: { k: k2, id: dest.id == null ? null : +dest.id, voce: TX(dest.voce, 30) },
        dati, categorie: cat, data: oggi(), da: me.n };
      // attestati e patentino caricati dal pilota: restano «da approvare» finché l'Admin non li conferma (/api/doc/approva)
      const daApprovare = !adm && k2 === "pilota" && ["A1-A3", "A2", "STS-01", "patentino"].includes(doc.dest.voce);
      if (daApprovare) {
        const c = info.claude || null;
        doc.daApprovare = true;
        // cosa aveva letto Claude, e se il pilota ha cambiato voce, numero o date (l'Admin lo vede prima di approvare)
        doc.claude = c ? { voce: c.dest.voce, numero: c.dati.numero, rilascio: c.dati.rilascio, scadenza: c.dati.scadenza } : null;
        doc.diverso = !c || c.dest.voce !== doc.dest.voce || c.dati.numero !== dati.numero || c.dati.rilascio !== dati.rilascio || c.dati.scadenza !== dati.scadenza;
      }
      d.DOCS = (d.DOCS || []).filter(x => x.id !== b.id); d.DOCS.unshift(doc);
      if (!daApprovare) applicaDoc(d, doc);
      info.confermato = true; await st.put("docinfo:" + b.id, info);
      await scriviMain(d, m.row.ver + 1);
      return J(Object.assign({ ok: true, ver: m.row.ver + 1 }, daApprovare ? { daApprovare: true } : {}));
    }
    // l'Admin approva (ok: true) o rifiuta (ok: false) un attestato caricato da un pilota
    if (p === "/api/doc/approva" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin" }, 403);
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, doc = (d.DOCS || []).find(x => x.id === b.id && x.daApprovare);
      if (!doc) return J({ errore: "Documento non trovato o già sistemato" }, 404);
      delete doc.daApprovare;
      if (b.ok) {
        // l'Admin può correggere i dati prima di approvare
        if (b.dati && typeof b.dati === "object") doc.dati = { numero: TX(b.dati.numero, 60) || doc.dati.numero, rilascio: DATA(b.dati.rilascio) || doc.dati.rilascio, scadenza: DATA(b.dati.scadenza) || doc.dati.scadenza };
        doc.approvato = oggi(); applicaDoc(d, doc);
      } else doc.rifiutato = oggi();
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
    const ora = A.ora == null || A.ora === "" || !Number.isFinite(+A.ora) ? 7 : +A.ora;   // anche mezzanotte (0) è un'ora valida
    if (ora !== oggi.ora) return { ok: true, saltato: "non è l'ora" };
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
  // nell'invio programmato una mail che non parte non ferma le altre (e le scadenze restano segnate come mandate); nella prova l'errore torna all'Admin
  const manda = async (a, ogg, html) => { if (prova) { await mandaMail(this.env, a, ogg, html); esiti.push(a); return; }
    try { await mandaMail(this.env, a, ogg, html); esiti.push(a); } catch (e) { console.error("avviso non mandato a " + a + ":", e && e.message || e); errori.push(a); } };
  const errori = [];
  if (adm.on !== false && EMAIL(adm.email) && (righe.length || prova)) {
    const ogg = prova ? "Prova degli avvisi di Quota 120" : pl0(righe.length, "scadenza in arrivo", "scadenze in arrivo") + (nomeOp ? " · " + nomeOp : "");
    await manda(adm.email.trim(), ogg, righe.length ? mailHtml(nomeOp, righe, true, url) : mailHtml(nomeOp, [{ t: "Nessuna scadenza in arrivo", s: "Gli avvisi funzionano: quando qualcosa starà per scadere riceverai una mail come questa.", g: null }], true, url));
  }
  if (!prova) for (const p of d.PILOTI || []) {
    const c = (A.piloti || {})[p.id] || {}, pe = ((d.SCHEDEP || {})[p.id] || {}).email || "", em = EMAIL(c.email) ? c.email : pe, on = c.on !== undefined ? !!c.on : !!pe;
    if (!on || !EMAIL(em)) continue;
    const mie = righe.filter(r => r.pid === p.id); if (!mie.length) continue;
    await manda(em.trim(), pl0(mie.length, "tua scadenza in arrivo", "tue scadenze in arrivo"), mailHtml(nomeOp, mie, false, url));
  }
  if (nuovi.length) { for (const k of nuovi) inviati[k] = oggi.data; await st.put("avvisi:inviati", inviati); }
  return Object.assign({ ok: true, mandate: esiti, righe: righe.length }, errori.length ? { nonMandate: errori } : {});
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
  // corso A1-A3: registrazione con email e codice (cc:<email> in attesa · ce:<email> iscritto · ct:<chiave> → email)
  // Admin del sito (quota120.com/admin): solo l'email in SITO_ADMIN · ac:<email> codice in attesa · at:<chiave> → entrato
  const tok = () => [...crypto.getRandomValues(new Uint8Array(20))].map(x => x.toString(16).padStart(2, "0")).join("");
  const admOk = async t => /^[a-f0-9]{40}$/.test(t || "") && !!(await st.get("at:" + t));
  if (p === "/api/registro/adm-codice" && POST) {
    const b = await corpo(), email = mail(b), ammesso = String(env.SITO_ADMIN || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
    if (await troppi("lim:ac:" + ip, 10, 3600000)) return J({ errore: "Troppe richieste: riprova più tardi." }, 429);
    if (!ammesso.includes(email)) return J({ errore: "Questa sezione è riservata al titolare del sito." }, 403);
    const codice = cod6(); await st.put("ac:" + email, { codice, scad: now + 15 * 60000, tent: 0 });
    try { await mandaMail(env, email, "Codice Admin del sito Quota 120: " + codice, codiceHtml("", "", codice, false)); }
    catch (e) { await st.delete("ac:" + email); return J({ errore: "Non sono riuscito a mandare l'email: riprova tra poco." }, 502); }
    return J({ ok: true });
  }
  if (p === "/api/registro/adm-verifica" && POST) {
    const b = await corpo(), email = mail(b), c = String(b.codice || "").replace(/\D/g, ""), a = await st.get("ac:" + email);
    if (!a || now > a.scad) return J({ errore: "Il codice è scaduto: chiedine un altro." }, 400);
    if (a.codice !== c) { a.tent++; if (a.tent >= 5) await st.delete("ac:" + email); else await st.put("ac:" + email, a); return J({ errore: "Il codice non è giusto: controllalo nella mail." }, 400); }
    await st.delete("ac:" + email); const t = tok(); await st.put("at:" + t, { email, dal: now });
    return J({ ok: true, t });
  }
  if (p === "/api/registro/adm-ok") return J({ ok: await admOk(url.searchParams.get("t")) });
  if (p === "/api/registro/adm-esci" && POST) { const t = url.searchParams.get("t"); if (await admOk(t)) await st.delete("at:" + t); return J({ ok: true }); }
  if (p === "/api/registro/adm-iscritti") {
    if (!(await admOk(url.searchParams.get("t")))) return J({ errore: "Entra di nuovo" }, 401);
    const L = []; for (const [k, v] of await st.list({ prefix: "ce:" })) L.push({ email: k.slice(3), dal: v.dal, ultimo: v.ultimo, novita: !!v.novita });
    return J({ iscritti: L });
  }
  if (p === "/api/registro/corso-ok") { const t = String(url.searchParams.get("t") || ""); return J({ ok: /^[a-f0-9]{40}$/.test(t) && !!(await st.get("ct:" + t)) }); }
  if (p === "/api/registro/corso-codice" && POST) {
    const b = await corpo(), email = mail(b);
    if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
    if (!b.ok) return J({ errore: "Per continuare spunta che hai letto le avvertenze e la privacy." }, 400);
    if (await troppi("lim:cc:" + ip, 10, 3600000) || await troppi("lim:cce:" + email, 6, 86400000)) return J({ errore: "Troppi codici chiesti: riprova più tardi." }, 429);
    const prima = await st.get("cc:" + email);
    if (prima && now - prima.inviato < 60000) return J({ errore: "Ti ho appena mandato un codice: aspetta un minuto prima di chiederne un altro." }, 429);
    const codice = cod6();
    await st.put("cc:" + email, { codice, scad: now + 15 * 60000, tent: 0, inviato: now, novita: !!b.novita });
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0F1C26;font-size:15px;line-height:1.5"><div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120 · Corso A1-A3</div>Ciao, ecco il codice per entrare nel corso per il patentino drone:<div style="font-size:32px;font-weight:bold;letter-spacing:.25em;text-align:center;margin:18px 0">${codice.slice(0, 3)} ${codice.slice(3)}</div>Vale 15 minuti. Se non sei stato tu, ignora questa email.<p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Il corso non è il corso ufficiale ENAC e non lo sostituisce. Quota 120 non è collegato a ENAC, D-Flight o EASA.</p></div>`;
    try { await mandaMail(env, email, "Il tuo codice per il corso A1-A3: " + codice, html); }
    catch (e) { await st.delete("cc:" + email); return J({ errore: "Non sono riuscito a mandare l'email: riprova tra poco." }, 502); }
    return J({ ok: true });
  }
  if (p === "/api/registro/corso-verifica" && POST) {
    const b = await corpo(), email = mail(b), c = String(b.codice || "").replace(/\D/g, ""), a = await st.get("cc:" + email);
    if (!a || now > a.scad) return J({ errore: "Il codice è scaduto: chiedine un altro." }, 400);
    if (a.codice !== c) { a.tent++; if (a.tent >= 5) await st.delete("cc:" + email); else await st.put("cc:" + email, a); return J({ errore: "Il codice non è giusto: controllalo nella mail." }, 400); }
    await st.delete("cc:" + email);
    const t = [...crypto.getRandomValues(new Uint8Array(20))].map(x => x.toString(16).padStart(2, "0")).join("");
    const prec = (await st.get("ce:" + email)) || { dal: now };
    await st.put("ce:" + email, Object.assign(prec, { ultimo: now, novita: a.novita || !!prec.novita }));
    await st.put("ct:" + t, { email, dal: now });
    return J({ ok: true, t });
  }
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
    const nomeOp = TX(String(b.op || "").replace(/\s+/g, " ").trim(), 80), nome = TX(String(b.nome || "").replace(/\s+/g, " ").trim(), 80), df = TX(String(b.df || "").trim(), 40);
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
    // versione di prova: niente avvisi via email (li salta anche lo spazio), solo la pulizia dei file
    const main = env.STATO.get(env.STATO.idFromName("main"));
    ctx.waitUntil(main.fetch("https://quota120.interno/interno/pulizia").catch(() => {}));
    // gli avvisi di ogni spazio, e la pulizia dei file mai usati (una volta al giorno)
    ctx.waitUntil((async () => {
      await env.STATO.get(env.STATO.idFromName("registro")).fetch("https://quota120.interno/interno/log/pulizia").catch(() => {});
      const L = await env.STATO.get(env.STATO.idFromName("registro")).fetch("https://quota120.interno/interno/elenco").then(r => r.json()).catch(() => []);
      for (const op of L) { const s = env.STATO.get(env.STATO.idFromName("op:" + op));
        await s.fetch("https://quota120.interno/interno/avvisi", { headers: { "x-q120-op": op } }).catch(() => {});
        await s.fetch("https://quota120.interno/interno/pulizia", { headers: { "x-q120-op": op } }).catch(() => {}); }
    })());
  },
  async fetch(request, env) {
    let r;
    try { r = await this.smista(request, env); }
    catch (e) { console.error("smista:", e && e.stack || e); return J({ errore: "Errore interno" }, 500); }
    // quota120.com: intestazioni di sicurezza su tutte le risposte del sito
    const h = (env.POSTA_FINTA === "1" && request.headers.get("x-prova-host")) || new URL(request.url).hostname;
    if (h !== "quota120.com" || r.status === 101) return r;
    const x = new Response(r.body, r);
    x.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    x.headers.set("X-Content-Type-Options", "nosniff");
    x.headers.set("X-Frame-Options", "DENY");
    x.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    x.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    return x;
  },
  async smista(request, env) {
    const url = new URL(request.url), p = url.pathname;
    // quota120.com è il sito; il programma sta su app.quota120.com (e su quota120.staffordshire.workers.dev)
    const host = (env.POSTA_FINTA === "1" && request.headers.get("x-prova-host")) || url.hostname;   // l'intestazione vale solo nelle prove in locale
    if (host === "www.quota120.com") return Response.redirect("https://quota120.com" + p + url.search, 301);
    const reg = () => env.STATO.get(env.STATO.idFromName("registro"));
    // video dei corsi: niente percorsi codificati (%) o con barre doppie, che potrebbero aggirare il controllo della firma qui sotto
    if (/^\/corso\/+video\//i.test(p) && (p.includes("%") || !p.startsWith("/corso/video/"))) return new Response("Indirizzo non valido", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (p.startsWith("/corso/video/az-")) {
      const m = p.match(/^\/corso\/video\/(az-[a-z0-9-]+)\.(mp4|jpg|vtt|m4a)$/), [e, g] = (url.searchParams.get("s") || "").split(".");
      if (!m || !(+e > Date.now() / 1000) || !g || g !== await firmaV(env, m[1], e)) return new Response("Video non disponibile: apri il corso dal programma.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      const r = await env.ASSETS.fetch(new Request(url.origin + p, { headers: request.headers, method: request.method }));
      let x = new Response(r.body, r); const rg = (request.headers.get("range") || "").match(/^bytes=(\d*)-(\d*)$/);
      if (rg && r.status === 200 && request.method === "GET") {   // iPhone vuole i pezzi (206) per far partire i video
        const buf = await r.arrayBuffer(), n = buf.byteLength; let a = rg[1] === "" ? Math.max(0, n - +rg[2]) : +rg[1], b = rg[1] !== "" && rg[2] !== "" ? Math.min(+rg[2], n - 1) : n - 1;
        if (a >= n || a > b) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + n } });
        x = new Response(buf.slice(a, b + 1), { status: 206, headers: r.headers }); x.headers.set("content-range", "bytes " + a + "-" + b + "/" + n); x.headers.set("content-length", String(b - a + 1));
      }
      x.headers.set("accept-ranges", "bytes"); x.headers.set("cache-control", "private, max-age=86400"); x.headers.set("x-robots-tag", "noindex"); return x;
    }
    const biscotto = n => ((request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + n + "=([a-f0-9]{40})")) || [])[1];
    // controllo delle impostazioni: pubblico (solo sì/no); la prova dal vivo di DJI e Claude (?prova=1) solo per l'Admin del sito (cookie q120a)
    if (p === "/api/salute") {
      const c = n => !!(env[n] && String(env[n]).trim()), u = new URL(request.url);
      if (u.searchParams.get("prova") === "1") {
        const ta = biscotto("q120a"), ok = ta && await reg().fetch(new Request("https://quota120.interno/api/registro/adm-ok?t=" + ta)).then(x => x.json()).then(j => j.ok).catch(() => false);
        if (!ok) return J({ errore: "Solo per l'Admin del sito: entra da quota120.com/admin" }, 401);
      } else { u.searchParams.delete("prova"); u.searchParams.delete("finta"); }
      const r = await env.STATO.get(env.STATO.idFromName("main")).fetch(new Request(u.toString())).then(x => x.json()).catch(() => ({}));
      return Response.json({ ...r, worker: { RESEND_API_KEY: c("RESEND_API_KEY"), ANTHROPIC_API_KEY: c("ANTHROPIC_API_KEY"), DJI_API_KEY: c("DJI_API_KEY"), nomi: Object.keys(env).filter(k => /KEY/.test(k)) } });
    }
    // Admin del sito: codice via email, poi la chiave nel cookie q120a
    if (host === "quota120.com" && p.startsWith("/api/admin/")) {
      const az = p.slice(11), ta = biscotto("q120a"), I = "https://quota120.interno/api/registro/adm-";
      if ((az === "codice" || az === "verifica") && request.method === "POST") {
        const corpo = await request.text();
        if (az === "codice" && !(await antiRobot(env, corpo, request))) return J({ errore: "Controllo anti-robot non superato: ricarica la pagina e riprova." }, 403);
        const r = await reg().fetch(new Request(I + az, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": request.headers.get("cf-connecting-ip") || "" }, body: corpo }));
        const j = await r.json().catch(() => ({}));
        if (!j.t) return J(j, r.status);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": "q120a=" + j.t + "; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax" } });
      }
      if (az === "iscritti") return reg().fetch(new Request(I + "iscritti?t=" + (ta || "")));
      if (!(ta && await reg().fetch(new Request(I + "ok?t=" + ta)).then(r => r.json()).then(j => j.ok).catch(() => false))) return J({ errore: "Entra di nuovo" }, 401);
      const N = "https://quota120.interno";
      if (az === "corsi" && request.method === "GET") return J(await corsiConVideo(env, url, await reg().fetch(new Request(N + "/interno/corsi")).then(r => r.json()), true));
      if (az === "corsi" && request.method === "POST") {
        const b = await request.json().catch(() => null); if (!Array.isArray(b)) return J({ errore: "dati" }, 400);
        for (const c of b) { c.id = String(c.id || "c" + Date.now()).replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "c" + Date.now(); for (const l of c.lezioni || []) { l.id = String(l.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 60) || ("l" + Date.now() + Math.floor(Math.random() * 1000)); l.scene = (l.scene || []).slice(0, 40); l.q = (l.q || []).slice(0, 40); } }
        return reg().fetch(new Request(N + "/interno/corsi", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
      }
      if (az === "panoramica") {
        const ops = await reg().fetch(new Request(N + "/interno/operatori")).then(r => r.json()).catch(() => []);
        for (const o of ops) Object.assign(o, await env.STATO.get(env.STATO.idFromName("op:" + o.op)).fetch(new Request(N + "/interno/riepilogo", { headers: { "x-q120-op": o.op } })).then(r => r.json()).catch(() => ({})));
        const isc = await reg().fetch(new Request(N + "/interno/iscritti-n")).then(r => r.json()).catch(() => ({}));
        const corsi = await corsiConVideo(env, url, await reg().fetch(new Request(N + "/interno/corsi")).then(r => r.json()), true);
        const lez = corsi.flatMap(c => c.lezioni || []), c = n => !!(env[n] && String(env[n]).trim());
        const prob = await reg().fetch(new Request(N + "/interno/log")).then(r => r.json()).catch(() => []);
        return J({ operatori: ops.map(o => ({ op: o.op, nome: o.nome, email: o.email, adm: o.adm, at: o.at, piloti: o.piloti || 0, droni: o.droni || 0, voli: o.voli || 0, telefoni: o.telefoni || 0, ultimo: o.ultimo || 0, sospeso: !!o.sospeso })),
          problemi: prob.filter(x => !x.risolto).length, iscritti: isc, stato: { posta: c("RESEND_API_KEY") || c("BREVO_API_KEY"), mittente: env.MITTENTE || "", dji: c("DJI_API_KEY"), claude: c("ANTHROPIC_API_KEY"), robot: c("TURNSTILE_SECRET"), video: lez.filter(l => l.pronto).length, lezioni: lez.length }, corsi: corsi.map(x => ({ id: x.id, t: x.t, n: (x.lezioni || []).length })) });
      }
      if (az === "log" && request.method === "GET") return reg().fetch(new Request(N + "/interno/log"));
      if (az === "log-risolto" && request.method === "POST") return reg().fetch(new Request(N + "/interno/log/risolto", { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() }));
      if (az === "sospendi" && request.method === "POST") { const b = await request.json().catch(() => ({})); if (!SLUG_OK(b.op)) return J({ errore: "operatore" }, 400);
        return env.STATO.get(env.STATO.idFromName("op:" + b.op)).fetch(new Request(N + "/interno/sospendi", { method: "POST", headers: { "x-q120-op": b.op }, body: JSON.stringify({ on: !!b.on }) })); }
      if (az === "esci" && request.method === "POST") { if (ta) await reg().fetch(new Request(I + "esci?t=" + ta, { method: "POST" })); return new Response('{"ok":true}', { headers: { "content-type": "application/json", "set-cookie": "q120a=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax" } }); }
      return J({ errore: "non trovato" }, 404);
    }
    // corso A1-A3: si apre solo con la registrazione (cookie q120c), solo su quota120.com
    if (p === "/corso" || p.startsWith("/corso/")) {
      if (host !== "quota120.com") return Response.redirect("https://quota120.com" + p, 302);
      const t = biscotto("q120c"), ta = biscotto("q120a");
      const ok = (t && await reg().fetch(new Request("https://quota120.interno/api/registro/corso-ok?t=" + t)).then(r => r.json()).then(j => j.ok).catch(() => false))
        || (ta && await reg().fetch(new Request("https://quota120.interno/api/registro/adm-ok?t=" + ta)).then(r => r.json()).then(j => j.ok).catch(() => false));
      if (!ok) return Response.redirect("https://quota120.com/corso-patentino-drone/", 302);
      return env.ASSETS.fetch(request);
    }
    // il corso legge i suoi contenuti (solo registrati o Admin)
    if (p === "/api/corso/contenuti") {
      const t = biscotto("q120c"), ta = biscotto("q120a");
      const adm = !!(ta && await reg().fetch(new Request("https://quota120.interno/api/registro/adm-ok?t=" + ta)).then(r => r.json()).then(j => j.ok).catch(() => false));
      const ok = adm || !!(t && await reg().fetch(new Request("https://quota120.interno/api/registro/corso-ok?t=" + t)).then(r => r.json()).then(j => j.ok).catch(() => false));
      if (!ok) return J({ errore: "Registrati per vedere il corso" }, 401);
      const tutti = await reg().fetch(new Request("https://quota120.interno/interno/corsi")).then(r => r.json());
      return J(await corsiConVideo(env, url, tutti.filter(c => adm || c.vis !== "piloti"), false));
    }
    // GitHub Actions chiede quali video fare (con il suo gettone OIDC, niente chiavi da conservare)
    if (p === "/api/corso/da-fare") {
      if (!(await gettoneGithub(request.headers.get("authorization") || ""))) return J({ errore: "non autorizzato" }, 401);
      const tutti = await reg().fetch(new Request("https://quota120.interno/interno/corsi")).then(r => r.json());
      const ops = await reg().fetch(new Request("https://quota120.interno/interno/elenco")).then(r => r.json()).catch(() => []);
      for (const op of ops) { const az = await env.STATO.get(env.STATO.idFromName("op:" + op)).fetch(new Request("https://quota120.interno/interno/corsi-az", { headers: { "x-q120-op": op } })).then(r => r.json()).catch(() => []); if (Array.isArray(az)) tutti.push(...az); }
      const out = []; for (const c of tutti) for (const l of c.lezioni || []) if ((l.scene || []).length) out.push({ file: (c.tok ? "az-" + c.tok + "-" : "") + l.id + "-" + await vh(l.scene), titolo: l.t, scene: l.scene });
      return J(out);
    }
    if (host === "quota120.com" && (p === "/api/corso/codice" || p === "/api/corso/verifica") && request.method === "POST") {
      const corpo = await request.text();
      if (p.endsWith("/codice") && !(await antiRobot(env, corpo, request))) return J({ errore: "Controllo anti-robot non superato: ricarica la pagina e riprova." }, 403);
      const r = await reg().fetch(new Request("https://quota120.interno/api/registro/corso-" + p.split("/").pop(), { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": request.headers.get("cf-connecting-ip") || "" }, body: corpo }));
      const j = await r.json().catch(() => ({}));
      if (!j.t) return J(j, r.status);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": "q120c=" + j.t + "; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax" } });
    }
    if (host === "quota120.com" || url.searchParams.get("sito") === "1" && env.POSTA_FINTA === "1") {
      if (p === "/robots.txt") return new Response("# quota120.com: aperto a motori di ricerca e assistenti IA; fuori solo le aree riservate\nUser-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /corso/\nDisallow: /api/\n\nSitemap: https://quota120.com/sitemap.xml\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (p.startsWith("/api/")) return new Response("Non trovato", { status: 404 });
      // /sito resta un dettaglio interno: se gli asset rimandano (es. /admin → /admin/), l'indirizzo torna senza /sito
      if (p.startsWith("/fonts/") || /^\/icon(-\d+\.png|\.svg)$/.test(p)) return env.ASSETS.fetch(request);   // caratteri e icone sono gli stessi del programma
      // informativa e condizioni: le stesse pagine del programma, anche sul sito
      const LEG = { "/privacy/": "/privacy", "/condizioni/": "/condizioni" };
      if (p === "/privacy" || p === "/privacy.html" || p === "/condizioni" || p === "/condizioni.html") return Response.redirect("https://quota120.com/" + p.replace(/^\/|\.html$/g, "") + "/" + url.search, 301);
      if (LEG[p]) {
        const ra = await env.ASSETS.fetch(new Request(new URL(LEG[p], url), request));
        const priv = p === "/privacy/", u = "https://quota120.com" + p;
        const tit = priv ? "Informativa sulla privacy e cookie · Quota 120" : "Condizioni d'uso · Quota 120";
        const des = priv ? "Quali dati raccolgono Quota 120 e il sito quota120.com, perché, dove finiscono, quali cookie tecnici usano e quali diritti hai secondo il GDPR."
          : "Le condizioni d'uso di Quota 120, il gestionale per operatori di droni: cosa offre la prova gratuita, responsabilità e regole del servizio.";
        const ld = { "@context": "https://schema.org", "@graph": [
          { "@type": "WebPage", "@id": u + "#page", url: u, name: tit, description: des, inLanguage: "it-IT", isPartOf: { "@id": "https://quota120.com/#web" }, publisher: { "@id": "https://quota120.com/#org" }, dateModified: "2026-11-01" },
          { "@type": "Organization", "@id": "https://quota120.com/#org", name: "Quota 120", url: "https://quota120.com/", logo: "https://quota120.com/img/logo-512.png", email: "assistenza@quota120.com", areaServed: "IT",
            address: { "@type": "PostalAddress", addressLocality: "Ostellato", addressRegion: "FE", postalCode: "44020", addressCountry: "IT" }, sameAs: ["https://puntowebferrara.com/", "https://app.quota120.com/"],
            contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: "assistenza@quota120.com", availableLanguage: "it" } },
          { "@type": "WebSite", "@id": "https://quota120.com/#web", url: "https://quota120.com/", name: "Quota 120", inLanguage: "it-IT", publisher: { "@id": "https://quota120.com/#org" } },
          { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Quota 120", item: "https://quota120.com/" }, { "@type": "ListItem", position: 2, name: priv ? "Privacy" : "Condizioni d'uso", item: u }] }] };
        const testa = '<link rel="canonical" href="' + u + '"><meta name="description" content="' + des + '"><meta property="og:type" content="website"><meta property="og:site_name" content="Quota 120"><meta property="og:locale" content="it_IT"><meta property="og:url" content="' + u + '"><meta property="og:title" content="' + tit.replace(/"/g, "&quot;") + '"><meta property="og:description" content="' + des + '"><meta property="og:image" content="https://quota120.com/img/og-home.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">' + JSON.stringify(ld) + '</script>';
        const piede = '<p style="text-align:center;margin:24px 0;font-size:15px"><a href="/">Quota 120</a> · <a href="/corso-patentino-drone/">Corso patentino drone A1-A3</a> · <a href="/contatti/">Contatti</a> · <a href="' + (priv ? "/condizioni/" : "/privacy/") + '">' + (priv ? "Condizioni d'uso" : "Privacy") + '</a></p>';
        const t = (await ra.text()).replace('<meta name="robots" content="noindex">', testa).replace("location.href='/?resta'", "location.href='/'").replace("</main>", piede + "</main>");
        return new Response(t, { status: ra.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      }   // i caratteri sono gli stessi del programma
      if (p === "/sito" || p.startsWith("/sito/")) return Response.redirect("https://quota120.com" + (p.slice(5) || "/") + url.search, 301);
      const ra = await env.ASSETS.fetch(new Request(new URL("/sito" + (p === "/" ? "/" : p), url), request));
      const loc = ra.headers.get("location");
      if (ra.status >= 300 && ra.status < 400 && loc) { const u = new URL(loc, url); if (u.pathname.startsWith("/sito/")) return new Response(null, { status: ra.status, headers: { location: u.pathname.slice(5) + u.search } }); }
      // le pagine pubbliche del sito vanno su Google; Admin e corso interno restano fuori (noindex)
      if (!p.startsWith("/admin") && ra.headers.get("x-robots-tag")) { const r2 = new Response(ra.body, ra); r2.headers.delete("x-robots-tag"); return r2; }
      return ra;
    }
    const main = () => env.STATO.get(env.STATO.idFromName("main"));
    // nessuno da fuori può dire di essere uno spazio: l'intestazione la mette solo questo smistatore
    const pulita = (op) => { const r = new Request(request); r.headers.delete("x-q120-op"); if (op) r.headers.set("x-q120-op", op); return r; };
    // registro: da fuori solo quello che chiamano le pagine dell'app (iscrizione e entrata dell'Admin dello spazio);
    // codici del corso e dell'Admin del sito passano solo da /api/corso/* e /api/admin/* (con il controllo anti-robot)
    if (p.startsWith("/api/registro/")) {
      if (!["/api/registro/info", "/api/registro/iscrivi", "/api/registro/codice", "/api/registro/verifica"].includes(p)) return J({ errore: "Non trovato" }, 404);
      return reg().fetch(pulita());
    }
    if (p === "/api/corsi" && request.method === "GET") {
      const op = String(request.headers.get("x-op") || url.searchParams.get("op") || "").toLowerCase();
      const stub = !op || op === "prova" ? main() : SLUG_OK(op) ? env.STATO.get(env.STATO.idFromName("op:" + op)) : null;
      if (!stub) return J({ errore: "operatore" }, 404);
      const r = await stub.fetch(pulita(SLUG_OK(op) ? op : "")); if (!r.ok) return r;
      const j = await r.json();
      const tutti = await reg().fetch(new Request("https://quota120.interno/interno/corsi")).then(x => x.json()).catch(() => []);
      j.az = await corsiConVideo(env, url, j.az || [], !!j.adm);
      j.q120 = await corsiConVideo(env, url, tutti, false);
      return J(j);
    }
    if (p === "/api/log" && request.method === "POST") {
      const t = await request.text(); if (t.length > 16000) return J({ errore: "Troppo lungo" }, 413);
      let b; try { b = JSON.parse(t); } catch (e) { return J({ errore: "dati" }, 400); }
      const op = String(request.headers.get("x-op") || "").toLowerCase(), opOk = SLUG_OK(op) ? op : "prova";
      const j = await reg().fetch(new Request("https://quota120.interno/interno/log", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ b, op: opOk, ip: request.headers.get("cf-connecting-ip") || "", ua: request.headers.get("user-agent") || "" }) })).then(r => r.json()).catch(() => ({}));
      if (j.ok && b.tipo === "mess" && j.id) {
        const E = x => String(x == null ? "" : x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
        const html = "<p><b>" + E(b.chi || "Qualcuno") + "</b> (" + E(b.ruolo) + ", " + E(b.opn || opOk) + ") ha scritto:</p><blockquote>" + E(b.testo).replace(/\n/g, "<br>") + "</blockquote>"
          + "<p>Pagina: " + E(b.vista) + " · rete: " + E(b.rete) + (b.email ? " · email: " + E(b.email) : "") + "</p><p>Le ultime cose fatte:</p><pre>" + E((b.passi || []).join("\n")) + "</pre><p>Lo trovi anche nel Pannello › Problemi dell'app.</p>";
        await mandaMail(env, "assistenza@quota120.com", "Quota 120 · problema segnalato da " + String(b.chi || opOk).slice(0, 60), html, null, b.email || undefined).catch(e => console.error("mail problema:", e && e.message || e));
      }
      return J({ ok: !!j.ok });
    }
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
    if (seg && seg !== "corso" && !seg.includes("/") && !seg.includes(".") && (seg === "prova" || SLUG_OK(seg.toLowerCase()))) return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return env.ASSETS.fetch(request);
  }
};
