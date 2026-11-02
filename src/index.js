import CORSI_SEME from "./corso_seed.json";
import { leggi as posLeggi, parola as posParola } from "./pos-comune.js";
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
      const x = Object.assign({}, l, { video: pronto ? f : "", pronto, audio }); if (pronto) {   // firma per tutti i video: così si aprono anche dal programma (app.quota120.com), sottotitoli compresi
        const e = (Math.floor(Date.now() / 86400000) + 2) * 86400; x.fv = "?s=" + e + "." + await firmaV(env, f, e); } if (!adm) { x.testo = (l.scene || []).map(s => s.v).filter(Boolean); delete x.scene; } cc.lezioni.push(x); }
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
// la «rete» di chi chiama, per i limiti: IPv4 intero; IPv6 solo i primi 64 bit (una casa o un telefono hanno tutto un /64)
function reteDi(ip) {
  ip = String(ip || "").trim().toLowerCase().replace(/%.*$/, ""); if (!ip) return "";
  if (ip.endsWith("/64")) return ip.slice(0, 60);                       // già ridotto
  if (!ip.includes(":")) return ip.slice(0, 45);
  const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); if (m4) return m4[1];
  const [a, b] = ip.split("::"), A = a ? a.split(":") : [], Bp = b == null ? null : (b ? b.split(":") : []);
  const parti = Bp == null ? A : A.concat(Array(Math.max(0, 8 - A.length - Bp.length)).fill("0"), Bp);
  return parti.slice(0, 4).map(x => (x || "0").replace(/^0+(?=.)/, "")).join(":").slice(0, 40) + "::/64";
}
// prove in locale: le scorciatoie (x-prova-host, x-prova-ip, /interno/ da fuori, posta finta) valgono solo con POSTA_FINTA=1 E indirizzo localhost
const LOCALE = (env, request) => env.POSTA_FINTA === "1" && /^(localhost|127\.0\.0\.1)$/.test(new URL(request.url).hostname);
// la rete del visitatore: la mette lo smistatore nell'intestazione interna x-q120-ip (da fuori non passa)
const ipCliente = (request, env) => reteDi((LOCALE(env, request) && request.headers.get("x-prova-ip")) || request.headers.get("cf-connecting-ip") || "");
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
// numero intero (o null se manca): per gli id e i valori che finiscono nelle pagine
const INTN = (v, min, max) => { if (v == null || v === "") return null; const n = Math.round(+v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null; };
const PAROLA = (v, max = 24) => /^[a-zA-Z0-9_-]+$/.test(String(v || "")) ? String(v).slice(0, max) : "";

// ---- limiti di sicurezza (uso dell'intelligenza artificiale, email, spazio per i file) ----
const LIM = {
  claudeSpazio: 60, claudeDisp: 20, claudeProva: 40, claudeProvaDisp: 8, claudeTutti: 1500,   // letture al giorno
  provaAvvisi: 3, provaAvvisiGiorno: 10,                     // «Manda una prova» degli avvisi: all'ora e al giorno
  inviaSpazio: 30, inviaDisp: 10, inviaDest: 3,              // documenti mandati per email al giorno (spazio, telefono, stesso indirizzo)
  segnMail: 10,                                              // email all'Admin per le segnalazioni, all'ora
  byteSpazio: 500 * 1024 * 1024, byteProva: 20 * 1024 * 1024, // spazio per i file caricati (ogni prova personale: 20 MB)
  caricaOra: 300, byteOra: 300 * 1024 * 1024,                // caricamenti all'ora per telefono (il comando rapido la prima volta manda tutta la cartella DJI)
  rischioByte: 8000, rischiPilota: 150,                      // valutazione del rischio scritta da un pilota: grandezza massima e quante in tutto
  voliGiornoPilota: 100, rischiGiornoPilota: 30,             // record nuovi al giorno per pilota (dal salvataggio del telefono)
  riservaAdmin: 1600000,                                     // oltre questa grandezza dei dati i piloti non aggiungono più niente: il resto resta all'Admin
  dispSpazio: 300, dispProva: 2000,                          // telefoni ricordati
  djiDisp: 40, djiSpazio: 300,                               // richieste di chiavi DJI al giorno
  lavoroOra: 30,                                             // ricerche di un codice lavoro all'ora per telefono
  corsi: 5, lezioni: 15, scene: 25,                          // corsi dell'azienda
  provaNuoveIp: 20, provaNuoveTutti: 3000,                   // prove personali nuove al giorno: per rete e per tutti
  claudeProvaTutti: 200,                                     // letture con l'intelligenza artificiale al giorno di tutte le prove insieme
  djiTutti: 3000,                                            // richieste di chiavi DJI al giorno di tutti gli spazi insieme
  mailSpazio: 30, mailTutti: 250,                            // email automatiche (avvisi, prove, segnalazioni, conferme) al giorno: per spazio e per tutti
  confermeSalva: 5,                                          // email di conferma degli indirizzi per ogni salvataggio
  iscrizioniTutti: 200,                                      // codici di iscrizione al giorno, per tutti
  zonePilota: 150, segnPilota: 20,                           // verifiche delle zone e segnalazioni nuove al giorno per pilota
  zoneMax: 2000, segnMax: 500,                               // quante ne tiene lo spazio: oltre, le nuove dei piloti non entrano (niente cancellazioni)
  provaByteTutti: 2 * 1024 * 1024 * 1024,                    // byte caricati al giorno da tutte le prove insieme
  vocePerLezione: 6000, vocePerSpazio: 60000,                // caratteri della voce dei video: per lezione e per tutti i corsi di un'azienda
  logRete: 20, logMessRete: 6, logAnonimi: 500, logDisp: 60, logMessDisp: 10   // registro dei problemi: per rete all'ora, anonimi al giorno, per telefono al giorno
};
const GIORNI_AVVISO = [60, 30, 15, 7, 1, 0];                 // quando si può avvisare prima di una scadenza
const giorniAvviso = g => { const L = [...new Set(LISTA(g).map(Number).filter(x => GIORNI_AVVISO.includes(x)))].slice(0, 6); return L.length ? L : [60, 30, 7, 0]; };
// ---- versione di prova: ogni visitatore ha la sua, su un indirizzo separato dall'app vera ----
// la prova sta su prova.quota120.com (mai su app.quota120.com, dove ci sono le chiavi dei telefoni degli spazi veri);
// ogni visitatore ha il suo contenitore ("demo:<id>", id nel cookie q120p) che si cancella da solo
// dopo 6 ore senza usarlo o 24 ore dalla nascita (allarme del contenitore)
const HOST_PROVA = "prova.quota120.com";
const PROVA_FERMA = 6 * 36e5, PROVA_MAX = 24 * 36e5;
const PROVA_ALTROVE = "La versione di prova ora è su prova.quota120.com";
const ID_PROVA = s => /^[a-f0-9]{32}$/.test(s || "");
const PROVA_SCADUTA = () => new Response(JSON.stringify({ errore: "dispositivo", provaScaduta: true }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store", "x-q120-prova-scaduta": "1" } });
// valutazione del rischio: solo i campi che usa il programma, con tipi e lunghezze controllati
function pulisciRischio(r) {
  if (!r || typeof r !== "object") return null;
  const id = String(r.id || ""); if (!/^R[a-z0-9]{4,14}$/.test(id)) return null;
  const B = v => !!v, O = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const a = O(r.auto), pos = O(a.pos), met = O(a.meteo), zo = O(a.zona), so = O(r.sora);
  const auto = {};
  if (a.pos) auto.pos = { lat: NUM(pos.lat, -90, 90), lon: NUM(pos.lon, -180, 180), nome: TX(pos.nome, 120) };
  if (a.meteo) auto.meteo = { v: NUM(met.v, 0, 999), g: NUM(met.g, 0, 999), p: NUM(met.p, 0, 9999), data: DATA(met.data) };
  if (a.zona) auto.zona = { liv: ["ok", "warn", "ko", ""].includes(zo.liv) ? zo.liv : "", max: NUM(zo.max, 0, 999), n: LISTA(zo.n).slice(0, 3).map(x => TX(x, 80)), nessuna: B(zo.nessuna) };
  if (a.quando) auto.quando = DATA(a.quando);
  return { id, lav: INTN(r.lav, 0, 1e16), cod: TX(r.cod, 20), luogo: TX(r.luogo, 160), data: DATA(r.data) || TX(r.data, 10), drone: INTN(r.drone, 0, 1e16), pilota: TX(r.pilota, 80),
    zona: PAROLA(r.zona), pers: PAROLA(r.pers), vic: LISTA(r.vic).slice(0, 15).map(x => PAROLA(x)).filter(Boolean),
    per: LISTA(r.per).slice(0, 30).filter(h => h && typeof h === "object").map(h => ({ k: PAROLA(h.k, 30), t: TX(h.t, 200), p: INTN(h.p, 1, 5) || 1, g: INTN(h.g, 1, 5) || 1, fisso: B(h.fisso), mio: B(h.mio),
      mis: LISTA(h.mis).slice(0, 8).filter(m => m && typeof m === "object").map(m => ({ t: TX(m.t, 200), dp: INTN(m.dp, 0, 5) || 0, on: B(m.on) })) })),
    auto, esito: ["ok", "warn", "ko"].includes(r.esito) ? r.esito : "warn", firma: TX(r.firma, 80), il: DATA(r.il) || "",
    sora: { grc: INTN(so.grc, 0, 10) || 0, arc: /^ARC-[a-d]$/.test(so.arc || "") ? so.arc : "" },
    invii: LISTA(r.invii).slice(0, 20).filter(x => x && typeof x === "object").map(x => ({ a: EMAIL(x.a) ? String(x.a).trim().slice(0, 120) : "", chi: PAROLA(x.chi, 20), il: DATA(x.il) })),
    pdf: /^d[a-z0-9]{4,40}$/.test(r.pdf || "") ? r.pdf : undefined, pdfNome: r.pdf ? TX(r.pdfNome, 160) : undefined, pdfResp: r.pdf ? B(r.pdfResp) : undefined };
}
// testo da mettere in una email: niente indirizzi web (http://, www., nomi di dominio), lunghezza limitata
// dati salvati dall'Admin: le date restano date, le ore restano ore e i valori «a scelta» (livelli, stati) restano parole semplici.
// Quello che non va diventa vuoto; tutto il resto non si tocca (i testi li protegge la pagina quando li mostra)
const CH_DATA = new Set(["scad", "ril", "data", "acq", "dfAbb", "dfReg", "inviata", "il", "approvato", "rifiutato", "ultimo"]);
const CH_ORA = new Set(["ora", "ctrlOra"]), CH_SCELTA = new Set(["stato", "manut", "esito", "regime"]);
function pulisciAdmin(o, k) {
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) o[i] = pulisciAdmin(o[i]); return o; }
  if (o && typeof o === "object") { for (const kk of Object.keys(o)) o[kk] = pulisciAdmin(o[kk], kk); return o; }
  if (typeof o !== "string" || !k) return o;
  if (CH_DATA.has(k)) return DATA(o) || /^[\d\/\-. :—]*$/.test(o) ? o : "";   // anche «—» (nessuna data)
  if (CH_ORA.has(k)) return /^[\d:. ]*$/.test(o) ? o : "";
  if (k === "liv") return ["ok", "warn", "ko"].includes(o) ? o : "";
  if (CH_SCELTA.has(k)) return /^[A-Za-z0-9 _-]{0,40}$/.test(o) ? o : "";
  return o;
}
// impostazioni degli avvisi: ora, soglie ammesse e indirizzi (solo email vere)
function pulisciAvvisi(A) {
  A = A && typeof A === "object" && !Array.isArray(A) ? A : {};
  const em = v => EMAIL(v) ? String(v).trim().slice(0, 120) : "", P = A.piloti && typeof A.piloti === "object" ? A.piloti : {}, adm = A.adm && typeof A.adm === "object" ? A.adm : {};
  const ora = Number.isFinite(+A.ora) && A.ora !== "" && A.ora != null ? Math.max(0, Math.min(23, Math.round(+A.ora))) : 7;
  return { ora, giorni: giorniAvviso(A.giorni), adm: { email: em(adm.email), on: adm.on !== false },
    piloti: Object.fromEntries(Object.entries(P).slice(0, 500).filter(([k2, x]) => /^\d{1,16}$/.test(k2) && x && typeof x === "object").map(([k2, x]) => [k2, Object.assign({ email: em(x.email) }, x.on !== undefined ? { on: !!x.on } : {})])) };
}
const SENZA_LINK = (v, max = 60) => TX(v, Math.max(200, max)).replace(/https?:\/\/\S*/gi, "").replace(/\bwww\.\S*/gi, "").replace(/\b[a-z0-9-]{2,}(\.[a-z0-9-]{2,})+\b/gi, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

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
// un lavoro lo vede l'Admin, chi ha il permesso «clienti», il pilota a cui è assegnato; quelli senza pilota li può usare chiunque (con il codice)
const lavoroVisibile = (d, l, adm, n) => { if (adm || permDi(d, n).clienti || l.pilota == null || l.pilota === "") return true; const me = pilotaDi(d, n); return !!me && l.pilota === me.id; };
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
  // degli altri piloti niente firma, telefono ed email (restano solo i suoi)
  v.SCHEDEP = {}; for (const p of v.PILOTI) if ((d.SCHEDEP || {})[p.id]) v.SCHEDEP[p.id] = p === me ? d.SCHEDEP[p.id] : Object.assign({}, d.SCHEDEP[p.id], { firma: undefined, tel: undefined, email: undefined });
  v.PATENTINO = {}; for (const p of v.PILOTI) if ((d.PATENTINO || {})[p.id]) v.PATENTINO[p.id] = d.PATENTINO[p.id];
  v.VOLI = P.voliTutti ? d.VOLI : (d.VOLI || []).filter(x => x.pilota === n);
  v.ZONE = P.enac ? d.ZONE : (d.ZONE || []).filter(x => x.pilota === n);
  v.PERM = me ? { [me.id]: (d.PERM || {})[me.id] || {} } : {};
  // a scelta dell'Admin
  if (P.flotta) { v.SCHEDE = d.SCHEDE; v.BATT = d.BATT; v.INV = d.INV; }
  // etichetta QR di una batteria: chi non ha il permesso «flotta» vede solo nome, cicli e celle
  else v.BATTQ = (d.BATT || []).map(b => ({ id: b.id, drone: b.drone, nome: b.nome, cicli: b.cicli, max: b.max, celle: b.celle, stato: b.stato }));
  if (P.clienti && P.prezzi) v.CLIDATI = d.CLIDATI;
  if (P.clienti) { v.CLIENTI = d.CLIENTI; v.LAVORI = (d.LAVORI || []).map(l => P.prezzi ? l : Object.assign({}, l, { importo: null })); }
  // i lavori assegnati a lui li vede sempre (senza prezzi né fatture), anche senza il permesso «clienti»
  if (!P.clienti && me) v.LAVORI = (d.LAVORI || []).filter(l => l.pilota === me.id).map(l => ({ id: l.id, codice: l.codice, cliente: l.cliente, titolo: l.titolo, tipo: l.tipo, luogo: l.luogo, data: l.data, drone: l.drone, pilota: l.pilota, stato: l.stato, missione: l.missione, dove: l.dove, perche: l.perche, istr: l.istr, importo: null }));
  if (P.prezzi) v.PREV = d.PREV;
  if (P.enac) { v.AUT_ENAC = d.AUT_ENAC; v.DOMANDA = d.DOMANDA; v.ASSIC = d.ASSIC; }
  if (P.agri) { v.CAMPI = d.CAMPI; v.TRATT = d.TRATT; if (!v.CLIENTI) v.CLIENTI = d.CLIENTI; }
  v.DOCS = (d.DOCS || []).filter(x => docVisibile(d, x, n));
  v.ZONEINFO = d.ZONEINFO || null;
  if (d.CHECK) v.CHECK = d.CHECK;
  // valutazioni del rischio: le sue e quelle dei lavori assegnati a lui (tutte con il permesso «clienti»); gli indirizzi a cui sono state mandate no
  const suoiLav = new Set((d.LAVORI || []).filter(l => me && l.pilota === me.id).map(l => l.id));
  v.RISCHI = (d.RISCHI || []).filter(r => P.clienti || r.firma === n || (r.lav != null && suoiLav.has(r.lav)))
    .map(r => Object.assign({}, r, { invii: LISTA(r.invii).map(x => ({ chi: x.chi, il: x.il })) }));
  // segnalazioni: le sue per intero; degli altri solo i droni fermi
  v.SEGN = (d.SEGN || []).map(x => x.pilota === n ? x : (x.fermo ? { id: x.id, drone: x.drone, data: x.data, tipo: x.tipo, fermo: true } : null)).filter(Boolean);
  return v;
}
function docVisibile(d, doc, n) {
  const P = permDi(d, n), me = pilotaDi(d, n);
  if (doc.dapid != null ? !!me && me.id === doc.dapid : doc.da === n) return true;   // chi l'ha caricato (con l'id del pilota, se c'è)
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
// lim: quanti record nuovi può ancora aggiungere oggi questo pilota ({ v: voli, r: valutazioni del rischio }), lo scala unisci
function unisci(full, m, n, docOk, lim) {
  const d = JSON.parse(JSON.stringify(full));
  if (!m || typeof m !== "object" || Array.isArray(m)) m = {};
  const vecchi = new Map((d.VOLI || []).map(v => [String(v.id), v]));
  let nuoviVoli = 0;
  for (const v of LISTA(m.VOLI).slice(0, 2000)) {
    if (!v || v.pilota !== n) continue;
    const id = String(v.id || ""); if (!/^\d{1,16}$/.test(id)) continue;
    const o = vecchi.get(id);
    if (o && o.pilota !== n) continue;                       // non può toccare i voli degli altri
    if (!o && (++nuoviVoli > 200 || (lim && lim.v <= 0))) continue;   // al massimo 200 voli nuovi per salvataggio (e un tetto al giorno)
    // il registro allegato: resta quello salvato; uno nuovo solo se il file l'ha caricato lui
    const dl = TX(v.docLog, 40), docLog = (o && o.docLog) || (dl && docOk && docOk.has(dl) ? dl : "");
    const pulito = { id: +id, data: DATA(v.data) || oggi(), ora: TX(v.ora, 5), drone: TX(v.drone, 80), pilota: n, luogo: TX(v.luogo, 120),
      min: Math.max(0, Math.min(600, +v.min || 0)), stato: ["completo", "dacompl", "attesa"].includes(v.stato) ? v.stato : "dacompl",
      ctrl: !!v.ctrl, ctrlOra: TX(v.ctrlOra, 5), cliente: TX(v.cliente, 200), note: TX(v.note, 1000, true), importato: !!v.importato, amano: !!v.amano,
      cat: TX(v.cat, 60), inc: TX(v.inc, 60), codLav: TX(v.codLav, 20), meteo: TX(v.meteo, 160), zona: TX(v.zona, 200), notam: TX(v.notam, 300), ck: TX(v.ck, 400), dopo: v.dopo && typeof v.dopo === "object" ? { drone: !!v.dopo.drone, batt: !!v.dopo.batt, succ: !!v.dopo.succ } : undefined, docLog, logNome: TX(v.logNome, 120),
      istrOk: Array.isArray(v.istrOk) ? v.istrOk.slice(0, 30).map(x => TX(x, 200)) : undefined };
    // i dati letti dal registro li scrive solo il server (/api/volo/importa): il telefono non li può cambiare
    if (o && o.letto) Object.assign(pulito, pulisciLetto(o), { drone: o.drone, data: o.data, ora: o.ora, min: o.min, pilota: o.pilota });
    if (o) Object.assign(o, pulito); else { d.VOLI = d.VOLI || []; d.VOLI.unshift(pulito); if (lim) lim.v--; }
  }
  const zk = z => z.data + "|" + z.ora + "|" + z.drone + "|" + z.pilota, zs = new Set((d.ZONE || []).map(zk));
  // verifiche delle zone: le nuove entrano solo se c'è posto (le vecchie, anche degli altri, non si cancellano mai) e fino al tetto del giorno
  for (const z of LISTA(m.ZONE).slice(0, 50)) {
    if (!z || z.pilota !== n) continue;
    const pz = { data: DATA(z.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(z.ora || "") ? z.ora : "", drone: TX(z.drone, 80), pilota: n, esito: TX(z.esito, 200) };
    if (zs.has(zk(pz))) continue;
    if ((d.ZONE || []).length >= LIM.zoneMax) { if (lim) lim.pieno = "zone"; continue; }
    if (lim && lim.z <= 0) { lim.troppe = "zone"; continue; }
    d.ZONE = d.ZONE || []; d.ZONE.unshift(pz); zs.add(zk(pz)); if (lim) lim.z--;
  }
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
      const x = m.SCHEDE[dr.id] || m.SCHEDE[String(dr.id)], sc = (d.SCHEDE || {})[dr.id]; if (!x || !sc) continue;
      // il QR di D-Flight letto con «Leggi il QR» nell'app: si segna, non si toglie
      if (!sc.qrLetto && DATA(x.qrLetto)) { sc.qrLetto = DATA(x.qrLetto); dr.qr = true; }
      if (!Array.isArray(x.storia)) continue;
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
  // valutazioni del rischio: il pilota aggiunge o cambia solo le sue (campi controllati, grandezza limitata; gli invii li scrive solo l'Admin)
  const rv = new Map((d.RISCHI || []).map(r => [r.id, r]));
  let nuoviR = 0, mieR = (d.RISCHI || []).filter(r => r.firma === n).length;
  for (const r of LISTA(m.RISCHI).slice(0, 300)) {
    const pulito = pulisciRischio(r); if (!pulito) continue;
    const o = rv.get(pulito.id); if (o && o.firma !== n) continue;
    if (!o && (++nuoviR > 20 || (d.RISCHI || []).length >= 1000 || mieR >= LIM.rischiPilota || (lim && lim.r <= 0))) continue;   // al massimo 20 nuove per salvataggio, 1000 in tutto
    pulito.firma = n; pulito.invii = o ? LISTA(o.invii) : [];
    if (JSON.stringify(pulito).length > LIM.rischioByte) continue;
    if (o) { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, JSON.parse(JSON.stringify(pulito))); }
    else { d.RISCHI = d.RISCHI || []; d.RISCHI.unshift(pulito); rv.set(pulito.id, pulito); mieR++; if (lim) lim.r--; }
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

// servizio esterno occupato o fuori servizio per un momento (non per colpa della richiesta): la lettura si rende
const OCCUPATO = st => st === 429 || st === 503 || st === 529;
// ---- chiamata a Claude: se il servizio è occupato o non risponde (niente lettura fatta) l'errore ha «rendi», e la lettura non si conta ----
async function chiamaClaude(env, corpo) {
  let r; try { r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(corpo) }); }
  catch (e) { throw Object.assign(new Error("Lettura non riuscita (rete)"), { rendi: true }); }
  if (!r.ok) throw Object.assign(new Error("Lettura non riuscita (" + r.status + ")"), { rendi: OCCUPATO(r.status) });
  return r;
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
  const r = await chiamaClaude(env, { model: MODELLO, max_tokens: 4000, system: sistema, messages: [{ role: "user", content: [blocco, { type: "text", text: "Leggi questo documento." }] }] });
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
  const r = await chiamaClaude(env, { model: MODELLO, max_tokens: 1200, system: sistema, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: b64s } }, { type: "text", text: "Leggi il riepilogo di questo volo." }] }] });
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
// nelle email automatiche nomi e testi scritti dagli utenti non portano indirizzi web (né http, né www, né nomi di dominio)
function mailHtml(nomeOp, righe, perAdmin, url) {
  nomeOp = SENZA_LINK(nomeOp, 60); righe = righe.map(r => Object.assign({}, r, { t: SENZA_LINK(r.t, 200), s: SENZA_LINK(r.s, 400) }));
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
    if (!r.ok) { const t = await r.text().catch(() => ""); console.error("posta:", r.status, t.slice(0, 300)); throw new Error("La posta non ha accettato la mail (" + r.status + ")"); }
    return;
  }
  // il messaggio d'errore dice solo cosa manca, mai i nomi delle impostazioni che ci sono
  if (!env.BREVO_API_KEY || !env.MITTENTE) throw new Error("posta:" + [env.RESEND_API_KEY || env.BREVO_API_KEY ? "" : "manca la chiave della posta", env.MITTENTE ? "" : "manca il mittente"].filter(Boolean).join(" · "));
  const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(Object.assign({ sender: { name: "Quota 120", email: env.MITTENTE }, to: [{ email: a }], subject: oggetto, htmlContent: html }, RISP ? { replyTo: { email: RISP } } : {}, allegati.length ? { attachment: allegati.map(x => ({ name: x.nome, content: x.b64 })) } : {})) });
  if (!r.ok) { const t = await r.text().catch(() => ""); console.error("posta:", r.status, t.slice(0, 300)); throw new Error("La posta non ha accettato la mail (" + r.status + ")"); }
}
const EMAIL = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
const minu = e => String(e || "").trim().toLowerCase();
// a chi andrebbero gli avvisi (indirizzi in minuscolo): l'Admin e i piloti con gli avvisi accesi
function destAvvisi(d, tutti) {
  const A = d.AVVISI || {}, out = new Set();
  if (EMAIL((A.adm || {}).email) && (tutti || A.adm.on !== false)) out.add(minu(A.adm.email));
  for (const p of LISTA(d.PILOTI)) { if (!p) continue; const c = (A.piloti || {})[p.id] || {}, pe = ((d.SCHEDEP || {})[p.id] || {}).email || "", em = EMAIL(c.email) ? c.email : pe, on = c.on !== undefined ? !!c.on : !!pe;
    if ((on || tutti) && EMAIL(em)) out.add(minu(em)); }
  return out;
}
function confermaHtml(nomeOp, link) {
  nomeOp = SENZA_LINK(nomeOp, 60);
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0F1C26;font-size:15px;line-height:1.5">
    <div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
    ${nomeOp ? "<b>" + esc(nomeOp) + "</b> vuole" : "Un operatore di droni vuole"} mandarti a questo indirizzo gli avvisi delle scadenze (attestati, polizze, manutenzioni) con Quota 120.
    <p>Se va bene, conferma:</p><a href="${esc(link, 400)}" style="display:inline-block;background:#1D5C7C;color:#fff;border-radius:8px;padding:12px 18px;font-weight:bold;text-decoration:none">Conferma l'indirizzo</a>
    <p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Se non sai di cosa si tratta, ignora questa email: senza la conferma non ti arriva niente.</p></div>`;
}
// pagina semplice (conferma dell'indirizzo degli avvisi)
const paginaSemplice = (tit, testo, extra) => new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Quota 120</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#0F1C26;line-height:1.5;background:#fff"><div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
<h1 style="font-size:20px">${tit}</h1><p>${testo}</p>${extra || ""}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
const b64 = buf => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

/* ---------- spazi degli operatori: ognuno il suo contenitore di dati ("op:<nome>"), più il registro delle iscrizioni ---------- */
const RISERVATI = new Set(["api", "corso", "interno", "prova", "privacy", "condizioni", "condividi", "leaflet", "lib", "dji", "index", "admin", "www", "app", "quota120", "registro", "iscriviti", "entra", "assistenza"]);
const SLUG_OK = s => /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s || "") && !RISERVATI.has(s);
const cod6 = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const GIORNI_TOKEN_ADM = 90, GIORNI_TOKEN_CORSO = 365;   // dopo quanti giorni scadono le chiavi dell'Admin del sito e del corso
const GIORNI_ADMIN = 15;   // l'Admin entrato con l'email resta dentro; se non usa quel telefono per 15 giorni, rifà il codice
function codiceHtml(nome, nomeOp, codice, iscrizione, solo) {
  // nome e operatore li ha scritti chi si iscrive: nella mail niente indirizzi web e niente testi lunghi
  nome = SENZA_LINK(nome, 50); nomeOp = SENZA_LINK(nomeOp, 60);
  // chi vola da solo: «il tuo spazio» (lo spazio porta il suo nome)
  const dove = solo ? (iscrizione ? " e creare il tuo spazio" : " nel tuo spazio") : (nomeOp ? " nello spazio di <b>" + esc(nomeOp) + "</b>" : "");
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0F1C26;font-size:15px;line-height:1.5">
    <div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
    ${nome ? "Ciao " + esc(nome) + "," : "Ciao,"} ecco il codice ${iscrizione ? "per confermare l'iscrizione" : "per entrare"}${dove}:
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
  // versione di prova personale: allo scadere (6 ore ferma o 24 ore dalla nascita) si cancella tutto, file compresi
  async alarm() {
    const st = this.ctx.storage, c = await st.get("prova:creato"); if (!c) return;
    const v = (await st.get("prova:visto")) || c, scad = Math.min(c + PROVA_MAX, v + PROVA_FERMA);
    if (Date.now() >= scad - 1000) await this.provaCancella(); else await st.setAlarm(scad);
  }
  async provaCancella() { const st = this.ctx.storage; await st.deleteAlarm(); await st.deleteAll(); this.PIL = null; }
  async gestisci(request) {
    const url = new URL(request.url), st = this.ctx.storage, p = url.pathname;
    // l'intestazione x-q120-prova la mette solo lo smistatore, e solo per i contenitori delle prove personali
    if (request.headers.get("x-q120-prova") === "1") { const no = await this.provaVive(request, p); if (no) return no; }
    if (p.startsWith("/api/registro/")) return this.registro(request, url, p);
    if (p === "/interno/elenco") return J((await st.get("elenco")) || []);
    // registro dei problemi dell'app (errori e messaggi «Qualcosa non funziona?»): lo legge l'Admin del sito nel Pannello
    if (p === "/interno/log" && request.method === "POST") {
      // aut: telefono riconosciuto dal suo spazio (lo controlla lo smistatore); senza, il nome dello spazio è solo «dichiarato»
      const { b, op, ip, ua, aut } = await request.json().catch(() => ({}));
      if (!b || typeof b !== "object") return J({ ok: false });
      const ora = Date.now(), s = (x, m) => String(x == null ? "" : x).slice(0, m), g = giornoUTC(), mess = b.tipo === "mess";
      if (aut) {
        // chi è entrato nel programma: le sue segnalazioni entrano sempre, con un tetto suo (per telefono, al giorno)
        const kd = "logd:" + s(aut.op, 40) + ":" + s(aut.disp, 20) + ":" + g, nd = (await st.get(kd)) || { n: 0, m: 0 };
        if (nd.n >= LIM.logDisp || (mess && nd.m >= LIM.logMessDisp)) return J({ ok: false, troppi: true });
        nd.n++; if (mess) nd.m++; await st.put(kd, nd);
      } else {
        // anonimi: un tetto per rete (IPv6: per /64) all'ora, e uno per tutti al giorno (separato da quello di chi è entrato)
        const kr = "logr:" + s(ip, 60) + ":" + Math.floor(ora / 36e5), nr = (await st.get(kr)) || { n: 0, m: 0 };
        if (nr.n >= LIM.logRete || (mess && nr.m >= LIM.logMessRete)) return J({ ok: false, troppi: true });
        const ka = "loga:" + g, na = (await st.get(ka)) || 0; if (na >= LIM.logAnonimi) return J({ ok: false, troppi: true });
        nr.n++; if (mess) nr.m++; await st.put(kr, nr); await st.put(ka, na + 1);
      }
      const opR = aut ? s(aut.op, 40) : s(op, 40);
      const tipo = mess ? "mess" : "err", fp = tipo === "err" ? "logfp:" + (aut ? "" : "?") + opR + ":" + s(b.msg, 160) + "|" + s(b.vista, 40) : "";
      if (fp) { const f = await st.get(fp); const e = f && await st.get(f.id);
        if (e && ora - e.ult < 864e5) { e.n = (e.n || 1) + 1; e.ult = ora; e.risolto = false; e.passi = (Array.isArray(b.passi) ? b.passi : []).slice(-30).map(x => s(x, 160)); await st.put(f.id, e); await st.put(fp, { id: f.id, at: ora }); return J({ ok: true }); } }
      const id = "log:" + String(ora).padStart(14, "0") + ":" + Math.random().toString(36).slice(2, 7);
      const e = { id, tipo, op: opR, opn: aut ? s(aut.opn, 80) : "non verificato", verificato: !!aut, chi: aut ? s(aut.n, 80) : s(b.chi, 80), ruolo: aut ? (aut.ruolo === "adm" ? "Admin" : "Pilota") : s(b.ruolo, 40),
        testo: s(b.testo, 2000), msg: s(b.msg, 600), stack: s(b.stack, 1500), vista: s(b.vista, 60),
        rete: s(b.rete, 30), schermo: s(b.schermo, 20), ua: s(ua, 220), email: EMAIL(b.email) ? s(String(b.email).trim(), 120) : "", passi: (Array.isArray(b.passi) ? b.passi : []).slice(-30).map(x => s(x, 160)), at: ora, ult: ora, n: 1 };
      await st.put(id, e); if (fp) await st.put(fp, { id, at: ora });
      let mail = false;
      if (tipo === "mess") { const gm = "logmail:" + (aut ? "a:" : "") + g, nm = ((await st.get(gm)) || 0) + 1; await st.put(gm, nm); mail = nm <= (aut ? 50 : 20); }
      return J({ ok: true, id, mail });
    }
    // tetti di tutti gli spazi insieme (chiavi DJI, email automatiche, byte delle prove, codici d'iscrizione): si prenota prima, si rende se non serve
    if (p === "/interno/conta" && request.method === "POST") {
      const b = await request.json().catch(() => ({})), max = { dji: LIM.djiTutti, mail: LIM.mailTutti, provabyte: LIM.provaByteTutti, iscr: LIM.iscrizioniTutti }[b.tipo];
      if (!max) return J({ ok: false }, 400);
      const k = "tetto:" + b.tipo + ":" + giornoUTC(), n = Math.max(1, Math.floor(+b.n || 1)), c = (await st.get(k)) || 0;
      if (b.rendi) { await st.put(k, Math.max(0, c - n)); return J({ ok: true }); }
      if (c + n > max) return J({ ok: false });
      await st.put(k, c + n); return J({ ok: true });
    }
    if (p === "/interno/log") return J([...(await st.list({ prefix: "log:", reverse: true, limit: 300 })).values()]);
    if (p === "/interno/log/risolto" && request.method === "POST") { const b = await request.json().catch(() => ({})); const e = b.id && String(b.id).startsWith("log:") && await st.get(b.id); if (e) { e.risolto = !!b.on; await st.put(b.id, e); } return J({ ok: !!e }); }
    if (p === "/interno/log/pulizia") { const ora = Date.now(), via = [];
      for (const [k, v] of await st.list({ prefix: "log:", limit: 1000 })) { if (ora - (v.ult || v.at) > 30 * 864e5) via.push(k); }
      for (const pre of ["logn:", "logr:"]) for (const [k] of await st.list({ prefix: pre, limit: 1000 })) { if (+k.split(":").pop() < Math.floor(ora / 36e5) - 2) via.push(k); }
      for (const [k, v] of await st.list({ prefix: "logfp:", limit: 1000 })) { if (ora - (v.at || 0) > 2 * 864e5) via.push(k); }
      const ieri = new Date(ora - 864e5).toISOString().slice(0, 10);
      for (const pre of ["logg:", "loga:", "logd:", "logmail:", "claude:tutti:", "claude:prova:", "lim:ave:", "lim:pn:", "lim:pnt:", "tetto:"]) for (const [k] of await st.list({ prefix: pre, limit: 1000 })) { if (k.split(":").pop() < ieri) via.push(k); }
      // chiavi dell'Admin del sito (90 giorni) e del corso (365 giorni) scadute, e contatori vecchi
      for (const [k, v] of await st.list({ prefix: "at:", limit: 1000 })) { if (ora - ((v && v.dal) || 0) > GIORNI_TOKEN_ADM * 864e5) via.push(k); }
      for (const [k, v] of await st.list({ prefix: "ct:", limit: 5000 })) { if (ora - ((v && v.dal) || 0) > GIORNI_TOKEN_CORSO * 864e5) via.push(k); }
      for (let i = 0; i < via.length; i += 128) await st.delete(via.slice(i, i + 128));
      return J({ ok: true, tolti: via.length }); }
    // letture con l'intelligenza artificiale di tutti gli spazi insieme: un tetto al giorno (lo chiede ogni spazio prima di leggere)
    if (p === "/interno/claude-conta" && request.method === "POST") {
      const k = "claude:tutti:" + giornoUTC(), n = (await st.get(k)) || 0;
      if (n >= LIM.claudeTutti) return J({ ok: false });
      // le prove personali hanno anche un tetto loro, tutte insieme
      const kp = "claude:prova:" + giornoUTC(), np = url.searchParams.get("prova") === "1" ? (await st.get(kp)) || 0 : -1;
      if (np >= LIM.claudeProvaTutti) return J({ ok: false, prova: true });
      await st.put(k, n + 1); if (np >= 0) await st.put(kp, np + 1); return J({ ok: true });
    }
    if (p === "/interno/claude-rendi" && request.method === "POST") {
      const k = "claude:tutti:" + giornoUTC(), n = (await st.get(k)) || 0; if (n > 0) await st.put(k, n - 1);
      if (url.searchParams.get("prova") === "1") { const kp = "claude:prova:" + giornoUTC(), np = (await st.get(kp)) || 0; if (np > 0) await st.put(kp, np - 1); }
      return J({ ok: true });
    }
    // una prova personale nuova: al massimo LIM.provaNuoveIp al giorno per rete e LIM.provaNuoveTutti per tutti
    if (p === "/interno/prova-nuova" && request.method === "POST") {
      const b = await request.json().catch(() => ({})), g = giornoUTC(), kt = "lim:pnt:" + g, nt = (await st.get(kt)) || 0;
      const ki = b.ip ? "lim:pn:" + String(b.ip).slice(0, 60) + ":" + g : "", ni = ki ? (await st.get(ki)) || 0 : 0;
      if (ki && ni >= LIM.provaNuoveIp) return J({ ok: false, rete: true });
      if (nt >= LIM.provaNuoveTutti) return J({ ok: false });
      if (ki) await st.put(ki, ni + 1); await st.put(kt, nt + 1); return J({ ok: true });
    }
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
    if (p === "/interno/op-info") { const op = String(url.searchParams.get("op") || ""); return J(SLUG_OK(op) ? (await st.get("op:" + op)) || {} : {}); }
    // il titolare approva (o toglie) i video dei corsi di un'azienda
    if (p === "/interno/op-video" && request.method === "POST") { const b = await request.json().catch(() => ({})), x = SLUG_OK(b.op) ? await st.get("op:" + b.op) : null;
      if (!x) return J({ errore: "operatore" }, 404); x.video = !!b.on; await st.put("op:" + b.op, x); return J({ ok: true, video: x.video }); }
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
    // telefoni da dimenticare: usciti, rifiutati o tolti da più di 7 giorni; nella prova anche quelli non usati da 2 giorni
    const pulisciDisp = () => { let n = 0; for (const [i, x] of Object.entries(disp)) {
      if ((["uscito", "rifiutato", "tolto"].includes(x.stato) && now - (x.visto || 0) > 7 * 864e5) || (PROVA && now - (x.visto || x.at || 0) > 2 * 864e5)
        || (x.stato === "invito" && now - (x.at || 0) > 14 * 864e5)) { delete disp[i]; n++; } } return n; };
    // inv: il profilo mandato dal link di invito (solo finché aspetta l'approvazione)
    const pub = () => Object.keys(disp).map(id => { const x = disp[id]; return Object.assign({ id, ruolo: x.ruolo, n: x.n, codice: x.codice, stato: x.stato, at: x.at, visto: x.visto, nuovo: !!x.nuovo, pid: x.pid, dev: x.dev || "" },
      x.stato === "invito" && x.inv ? { inv: { n: x.inv.n, tel: x.inv.tel, email: x.inv.email, at: x.inv.at } } : {}); });
    const leggiMain = async () => { const row = await st.get("main"); return row ? { row, d: JSON.parse(row.json) } : null; };
    // piloti che ci sono adesso (id → nome e nomi), ricordati finché i dati non cambiano
    const pilotiOra = async () => { const row = await st.get("main"); const ver = row ? row.ver : 0;
      if (!this.PIL || this.PIL.ver !== ver) { let L = []; try { L = row ? LISTA(JSON.parse(row.json).PILOTI) : []; } catch (e) {}
        this.PIL = { ver, id: new Map(L.filter(q => q && q.nome).map(q => [q.id, q.nome])), nome: new Set(L.filter(q => q && q.nome).map(q => q.nome)) }; }
      return this.PIL; };
    // prima di scrivere si misura: oltre il limite si ferma con «Spazio pieno» (lo trasforma in risposta fetch, qui sopra)
    const scriviMain = async (d, ver) => { const json = JSON.stringify(d);
      if (new TextEncoder().encode(json).length > MAX_MAIN) throw Object.assign(new Error("spazio pieno"), { pieno: true });
      await st.put("main", { json, ver }); };
    const PROVA = !OPN;                                       // versione di prova: chiunque può essere Admin (codice 1234)
    // letture con Claude (la chiave è di Quota 120): un tetto al giorno per spazio, per telefono e per tutti gli spazi insieme
    // la rete di chi chiama (IPv6: il /64), messa dallo smistatore
    const IPR = reteDi(request.headers.get("x-q120-ip") || "");
    // letture con Claude (la chiave è di Quota 120): un tetto al giorno per spazio, per telefono e per tutti gli spazi insieme.
    // La lettura si prenota PRIMA di chiamare Claude, tutta in un colpo (nessun'altra richiesta in mezzo), e si rende se Claude non risponde
    const limiteClaude = async did => {
      const g = giornoUTC(); let no = null;
      await this.ctx.blockConcurrencyWhile(async () => {
        const c = (await st.get("claude:giorno")) || {}, n = c.g === g ? c.n || 0 : 0, disp2 = c.g === g ? Object.assign({}, c.disp) : {}, nd = disp2[did] || 0;
        if (n >= (PROVA ? LIM.claudeProva : LIM.claudeSpazio)) { no = J({ errore: PROVA ? "Nella versione di prova le letture con l'intelligenza artificiale di oggi sono finite: riprova domani, oppure iscriviti per avere il tuo spazio." : "Oggi questo spazio ha già fatto " + LIM.claudeSpazio + " letture con l'intelligenza artificiale: riprova domani, oppure scrivi i dati a mano." }, 429); return; }
        if (nd >= (PROVA ? LIM.claudeProvaDisp : LIM.claudeDisp)) { no = J({ errore: "Oggi da questo telefono hai già fatto " + nd + " letture con l'intelligenza artificiale: riprova domani, oppure scrivi i dati a mano." }, 429); return; }
        disp2[did] = nd + 1; await st.put("claude:giorno", { g, n: n + 1, disp: disp2 });
      });
      if (no) return no;
      const tutti = await this.env.STATO.get(this.env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/claude-conta" + (PROVA ? "?prova=1" : ""), { method: "POST" })).then(r => r.json()).catch(() => ({ ok: true }));
      if (!tutti.ok) { await rendiClaude(did, false); return J({ errore: tutti.prova ? "Oggi le letture con l'intelligenza artificiale della versione di prova sono finite: riprova domani, oppure iscriviti per avere il tuo spazio." : "Oggi le letture con l'intelligenza artificiale sono finite per tutti: riprova domani, oppure scrivi i dati a mano." }, 429); }
      return null; };
    // Claude non ha risposto (occupato o rete): la lettura prenotata torna indietro (anche nel conto di tutti, se «anche»)
    const rendiClaude = async (did, anche) => {
      const g = giornoUTC();
      await this.ctx.blockConcurrencyWhile(async () => { const c = (await st.get("claude:giorno")) || {}; if (c.g !== g) return;
        c.n = Math.max(0, (c.n || 0) - 1); c.disp = c.disp || {}; c.disp[did] = Math.max(0, (c.disp[did] || 0) - 1); await st.put("claude:giorno", c); });
      if (anche) await this.env.STATO.get(this.env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/claude-rendi" + (PROVA ? "?prova=1" : ""), { method: "POST" })).catch(() => {}); };
    // spazio occupato dai file caricati (byte): si tiene il conto; la prima volta si somma tutto
    const usoFile = async () => { let u = await st.get("uso:byte"); if (typeof u !== "number") { u = 0; for (const [, i] of await st.list({ prefix: "docinfo:" })) u += +(i && i.size) || 0; await st.put("uso:byte", u); } return u; };
    const contaFile = async delta => { const u = await usoFile(); await st.put("uso:byte", Math.max(0, u + delta)); };
    // prima di salvare un file: c'è posto nello spazio? questo telefono (e questa rete) ha caricato troppo nell'ultima ora?
    const puoCaricare = async (chi, byte) => {
      if ((await usoFile()) + byte > (PROVA ? LIM.byteProva : LIM.byteSpazio)) return "pieno";
      const ora = Math.floor(now / 36e5), kk = ["car:" + chi + ":" + ora].concat(IPR ? ["car:ip:" + IPR + ":" + ora] : []), cc = [];
      for (const k of kk) { const c = (await st.get(k)) || { n: 0, b: 0 }; if (c.n >= LIM.caricaOra * (k.startsWith("car:ip:") ? 2 : 1) || c.b + byte > LIM.byteOra * (k.startsWith("car:ip:") ? 2 : 1)) return "troppi"; cc.push(c); }
      for (let i = 0; i < kk.length; i++) { cc[i].n++; cc[i].b += byte; await st.put(kk[i], cc[i]); }
      // prove personali: anche un tetto di byte al giorno per tutte insieme
      if (PROVA && !(await this.tetto("provabyte", byte))) { for (let i = 0; i < kk.length; i++) { cc[i].n--; cc[i].b -= byte; await st.put(kk[i], cc[i]); } return "prova"; }
      return ""; };
    const NO_CARICA = { pieno: "Lo spazio per i file è pieno: elimina documenti o voli vecchi, oppure scrivi all'assistenza.", troppi: "Hai caricato troppi file nell'ultima ora: riprova più tardi.",
      prova: "Oggi nelle versioni di prova sono già stati caricati tanti file: riprova domani, oppure crea il tuo spazio gratis su app.quota120.com." };
    // file: si cancellano i pezzi e le informazioni
    const togliFile = async did => { if (!/^d[a-z0-9]+$/.test(did || "")) return; const info = await st.get("docinfo:" + did); if (!info) return;
      for (let i = 0; i < (+info.pezzi || 0); i++) await st.delete("doc:" + did + ":" + i); await st.delete("docinfo:" + did); await contaFile(-(+info.size || 0)); };
    // un file nuovo: i pezzi, le informazioni e il conto dello spazio
    const salvaFile = async (buf, info) => { const did = "d" + now.toString(36) + rnd(3), pezzi = Math.ceil(buf.byteLength / PEZZO);
      for (let i = 0; i < pezzi; i++) await st.put("doc:" + did + ":" + i, buf.slice(i * PEZZO, (i + 1) * PEZZO));
      await st.put("docinfo:" + did, Object.assign({ pezzi, size: buf.byteLength, at: now, confermato: false }, info)); await contaFile(buf.byteLength); return did; };
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
        const kk = "pinerr:" + (IPR || "x"), err = (await st.get(kk)) || { n: 0, t: now };
        if (now - err.t > 900000) { err.n = 0; err.t = now; }
        if (err.n >= 5) return J({ errore: "Troppi codici sbagliati: riprova tra 15 minuti" }, 429);
        if (String(b.pin || "") !== pin) { err.n++; await st.put(kk, err); return J({ errore: "Codice sbagliato" }, 403); }
        await st.delete(kk);
        if (!(await st.get("main"))) await scriviMain(b.data || {}, 1);
      } else {
        let m = await leggiMain();
        // prova personale: se il visitatore entra subito come pilota, i dati di esempio li prepara il primo ingresso (come per l'Admin)
        if (!m && PROVA && b.data && typeof b.data === "object" && !Array.isArray(b.data)) { await scriviMain(b.data, 1); m = await leggiMain(); }
        if (!m) return J({ errore: "L'Admin deve ancora preparare il programma: riprova più tardi" }, 409);
        const kk = "operr:" + (IPR || "x"), err = (await st.get(kk)) || { n: 0, t: now };
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
      pulisciDisp();
      const ipN = IPR;   // c'è sempre dietro Cloudflare; nelle prove in locale no
      if (PROVA && ipN && !/^(127\.0\.0\.1|0:0:0:0::\/64)$/.test(ipN)) { const kn = "nuovidisp:" + ipN + ":" + Math.floor(now / 36e5), nn = (await st.get(kn)) || 0;
        if (nn >= 20) return J({ errore: "Troppi ingressi da questa rete: riprova tra un'ora" }, 429); await st.put(kn, nn + 1); }
      if (Object.keys(disp).length >= (PROVA ? LIM.dispProva : LIM.dispSpazio)) return J({ errore: "Ci sono troppi telefoni collegati: l'Admin deve togliere quelli che non si usano più (Piloti › Telefoni collegati)." }, 429);
      disp[id] = { k, ruolo, n: ruolo === "adm" ? "Admin" : n, pid, nuovo, codice: cod4(), stato: ruolo === "adm" || PROVA ? "ok" : "attesa", at: now, visto: now, app: ruolo === "adm", dev: nomeDisp(request.headers.get("user-agent")) };
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
      // voli arrivati dal telefono e mai sistemati: via dopo 60 giorni (nella prova dopo 1 giorno); il file resta solo se un volo lo usa
      const limA = now - (PROVA ? 1 : 60) * 864e5, A = (await st.get("arrivi")) || [], viaA = A.filter(x => (+x.at || 0) < limA);
      if (viaA.length) { await st.put("arrivi", A.filter(x => !viaA.includes(x))); vecchi.push(...viaA.map(x => x.id)); }
      for (const [kk, info] of await st.list({ prefix: "docinfo:" })) if (info && !info.confermato && (+info.at || 0) < (PROVA ? limA : lim)) vecchi.push(kk.slice(8));
      await togliSeLiberi(vecchi);
      // promemoria dei file già arrivati (per non prenderli due volte) e contatori vecchi
      const via = [], oraH = Math.floor(now / 36e5);
      for (const [kk, did] of await st.list({ prefix: "arrivo:" })) { const t = parseInt(String(did).slice(1, -6), 36); if (!(t > limA)) via.push(kk); }
      for (const pre of ["car:", "nuovidisp:", "lavlim:", "invlim:"]) for (const [kk] of await st.list({ prefix: pre })) { if (+kk.split(":").pop() < oraH - 1) via.push(kk); }
      for (const pre of ["dji:", "invia:dest:", "segnmail:", "prova-avvisi:", "bud:", "invgio:"]) for (const [kk] of await st.list({ prefix: pre })) { const g2 = kk.split(":").pop(); if (g2 < giornoUTC() && g2.length === 10) via.push(kk); }
      for (let i = 0; i < via.length; i += 128) await st.delete(via.slice(i, i + 128));
      // telefoni: via quelli usciti da 7 giorni (nella prova quelli non usati da 2 giorni)
      if (pulisciDisp()) await st.put("disp", disp);
      return J({ ok: true, guardati: vecchi.length, arrivi: viaA.length });
    }
    if (p === "/interno/posta" && LOCALE(this.env, request)) return J(globalThis.__POSTA || []);

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
      { const no = await puoCaricare("invio-" + chi.n, buf.byteLength); if (no) return new Response(NO_CARICA[no], { status: no === "pieno" ? 413 : 429 }); }
      const pidI = chi.adm ? null : ((pilotaDi(((await leggiMain()) || {}).d || {}, chi.n) || {}).id ?? null);
      const did = await salvaFile(buf, { mime: "text/plain", nome, da: chi.n, pid: pidI });
      await st.put(k1, did);
      const L = (await st.get("arrivi")) || []; L.push({ id: did, nome, size: buf.byteLength, da: chi.n, pid: pidI, at: now, via: "iPhone" }); await st.put("arrivi", L.slice(-300));
      if (L.length > 300) await togliSeLiberi(L.slice(0, L.length - 300).map(x => x.id));   // quelli usciti dall'elenco: via i file non usati
      await st.put("invio:ultimo:" + chi.n, { at: now, nuovi: (prima.at && now - prima.at < 600000 ? prima.nuovi || 0 : 0) + 1, via: "iPhone" });
      return new Response("ok");
    }

    // ---- etichetta QR inquadrata da chi non è entrato in questo spazio: solo il nome dell'operatore, nient'altro ----
    if (p === "/api/q/nome") { const m = await leggiMain(); return J({ nome: TX(String(((m && m.d.OP) || {}).nome || "").replace(/\s*\(dati di esempio\)\s*$/i, ""), 120) }); }

    // ---- conferma dell'indirizzo per gli avvisi (link nell'email): la pagina chiede di toccare il tasto, poi si conferma (POST) ----
    if (p === "/api/avvisi/conferma") {
      const t = url.searchParams.get("t") || "", C = OPN ? (await st.get("conferme")) || {} : {};
      const a = /^[a-f0-9]{32}$/.test(t) ? Object.keys(C).find(x => C[x] && C[x].tok === t) : null, x = a && C[a];
      if (!x || (!x.ok && now - (+x.inviato || 0) > 30 * 864e5)) return paginaSemplice("Link non valido", "Questo link non vale più. Se ti servono gli avvisi, chiedi all'Admin di salvare di nuovo il tuo indirizzo: ti arriverà un'altra email.");
      if (x.ok) return paginaSemplice("Indirizzo già confermato", "Riceverai gli avvisi delle scadenze di Quota 120 a " + esc(a, 120) + ".");
      const m0 = await leggiMain(), nomeOp = SENZA_LINK(String(((m0 && m0.d.OP) || {}).nome || ""), 60);
      if (request.method !== "POST") return paginaSemplice("Conferma l'indirizzo", "Tocca il tasto per ricevere a <b>" + esc(a, 120) + "</b> gli avvisi delle scadenze" + (nomeOp ? " di <b>" + esc(nomeOp) + "</b>" : "") + " con Quota 120.",
        '<form method="post"><button type="submit" style="background:#1D5C7C;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-weight:bold;font-size:15px;cursor:pointer">Conferma</button></form>');
      await this.ctx.blockConcurrencyWhile(async () => { const C2 = (await st.get("conferme")) || {}; if (C2[a] && C2[a].tok === t) { C2[a] = { ok: true, il: now }; await st.put("conferme", C2); } });
      return paginaSemplice("Fatto", "Indirizzo confermato: da ora a " + esc(a, 120) + " arrivano gli avvisi delle scadenze di Quota 120.");
    }
    // ---- chi è questo telefono? Lo chiede lo smistatore per il registro dei problemi (da fuori /interno/ non arriva) ----
    if (p === "/interno/chi-disp") {
      const [i2, k2] = String(request.headers.get("x-disp") || "").split(":"), x = Object.prototype.hasOwnProperty.call(disp, i2) ? disp[i2] : null;
      if (!x || !k2 || x.k !== k2 || x.stato !== "ok") return J({ ok: false });
      const m0 = await leggiMain();
      return J({ ok: true, op: OPN || "prova", opn: OPN ? String(((m0 && m0.d.OP) || {}).nome || OPN).slice(0, 80) : "versione di prova", n: x.n, ruolo: x.ruolo, disp: i2 });
    }

    // ---- link di invito dei piloti (pubblico): il pilota apre /<spazio>/invito/<chiave>, vede solo il nome dell'operatore e manda il suo profilo ----
    // la chiave (128 bit) sta qui, in «invito»; «Cambia il link» la cambia e la vecchia non vale più. Limiti per rete e per chiave, tetto di richieste in attesa.
    if (p === "/api/invito/info" || p === "/api/invito/manda") {
      if (request.method !== "POST") return J({ errore: "Richiesta non valida" }, 405);
      const txt = await request.text(); if (txt.length > 2000) return J({ errore: "Dati non validi" }, 400);
      let b; try { b = JSON.parse(txt); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (!b || typeof b !== "object") return J({ errore: "Dati non validi" }, 400);
      const ora = Math.floor(now / 36e5), conta = async (k, max) => { const n = (await st.get(k)) || 0; if (n >= max) return true; await st.put(k, n + 1); return false; };
      const rete = IPR || "x", NON_VALE = () => J({ errore: "Questo link non vale più: chiedi all'azienda il link nuovo." }, 404);
      if (p === "/api/invito/info") { if (await conta("invlim:i:" + rete + ":" + ora, 60)) return J({ errore: "Troppe richieste: riprova tra un'ora." }, 429); }
      else if (await conta("invlim:m:" + rete + ":" + ora, 5)) return J({ errore: "Da questa rete sono già stati mandati tanti profili: riprova tra un'ora." }, 429);
      const inv = PROVA ? null : await st.get("invito"), t = String(b.t || "");
      if (!inv || !/^[a-f0-9]{32}$/.test(t) || t !== inv.tok) return NON_VALE();
      const m0 = await leggiMain(), nomeOp = TX(String(((m0 && m0.d.OP) || {}).nome || ""), 120);
      if (p === "/api/invito/info") return J({ nome: nomeOp });
      // il profilo: nome, telefono ed email, controllati e accorciati
      const nome = SENZA_LINK(String(b.n || ""), 80), tel = String(b.tel || "").replace(/[^\d+ ]/g, "").replace(/\s+/g, " ").trim().slice(0, 20), email = minu(b.email).slice(0, 120);
      if (nome.length < 3 || !/\s/.test(nome) || norm(nome) === "admin") return J({ errore: "Scrivi il tuo nome e cognome." }, 400);
      if (tel.replace(/\D/g, "").length < 6) return J({ errore: "Scrivi il tuo numero di telefono." }, 400);
      if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
      const g = giornoUTC();
      if (await conta("invgio:" + t.slice(0, 12) + ":" + g, 30)) return J({ errore: "Oggi da questo link sono già arrivati tanti profili: riprova domani." }, 429);
      pulisciDisp();
      if (Object.values(disp).filter(x => x.stato === "invito").length >= 20) return J({ errore: "L'azienda ha già tanti profili da approvare: riprova tra qualche giorno." }, 429);
      if (Object.keys(disp).length >= LIM.dispSpazio) return J({ errore: "L'azienda ha troppi telefoni collegati: avvisala." }, 429);
      const id = rnd(8), k = rnd(18);
      disp[id] = { k, ruolo: "op", n: nome, pid: null, nuovo: false, codice: cod4(), stato: "invito", at: now, visto: now, app: false, dev: nomeDisp(request.headers.get("user-agent")), inv: { n: nome, tel, email, at: now } };
      await st.put("disp", disp);
      return J({ id, k, n: nome, stato: "invito", codice: disp[id].codice, op: nomeOp });
    }

    // ---- da qui serve un dispositivo riconosciuto ----
    // la chiave del telefono arriva solo nell'intestazione X-Disp (mai nell'indirizzo, che finisce nella cronologia e nei registri)
    let id = "", k = "";
    const h = request.headers.get("x-disp") || ""; if (h.includes(":")) [id, k] = h.split(":");
    const me = Object.prototype.hasOwnProperty.call(disp, id) ? disp[id] : null;
    if (!me || typeof k !== "string" || me.k !== k) return J({ errore: "dispositivo" }, 401);
    if (me.via === "email" && now - (me.visto || 0) > GIORNI_ADMIN * 86400000) { delete disp[id]; await st.put("disp", disp); return J({ errore: "dispositivo", scaduto: true }, 401); }
    if (now - (me.visto || 0) > 60000 || !me.dev) { me.visto = now; if (!me.dev) me.dev = nomeDisp(request.headers.get("user-agent")); await st.put("disp", disp); }
    if (me.ruolo === "op" && me.pid == null && me.stato !== "invito") { const m0 = await leggiMain(), p0 = m0 && pilotaDi(m0.d, me.n); if (p0) { me.pid = p0.id; await st.put("disp", disp); } }
    // il pilota tolto dall'Admin non entra più: ogni richiesta controlla che ci sia ancora (se l'Admin l'ha rinominato, il telefono prende il nome nuovo)
    if (me.ruolo === "op" && ["ok", "attesa"].includes(me.stato)) {
      const pi = await pilotiOra(), q = me.pid != null ? pi.id.get(me.pid) : null;
      if (q && q !== me.n && !pi.nome.has(me.n)) { me.n = q; await st.put("disp", disp); }
      else if (!(q === me.n || (me.pid == null && pi.nome.has(me.n)))) { me.stato = "tolto"; await st.put("disp", disp); }
    }
    if (me.ruolo === "op" && me.pid != null && blocchi[me.pid] && me.stato === "ok") { me.stato = "bloccato"; await st.put("disp", disp); }
    if (p === "/api/disp/stato") return J({ stato: me.stato, codice: me.codice, ruolo: me.ruolo, n: me.n, asp: aspetti[me.n] || ASP_BASE });
    // chi esce toglie il suo telefono dall'elenco (anche se era ancora in attesa)
    if (p === "/api/disp/esci" && request.method === "POST") { me.stato = "uscito"; await st.put("disp", disp); return J({ ok: true }); }
    if (me.stato !== "ok") return J({ errore: "non approvato", stato: me.stato }, 403);
    const adm = me.ruolo === "adm";
    // di chi è un file o un volo arrivato: se c'è l'id del pilota vale quello; il nome da solo solo per i file vecchi (senza id)
    const mio = x => !!x && (adm || (x.pid != null ? me.pid != null && x.pid === me.pid : x.da === me.n));
    // record nuovi al giorno per pilota (v voli, r valutazioni del rischio, z verifiche delle zone, s segnalazioni)
    const kBud = "bud:" + me.n + ":" + giornoUTC(), leggiBud = async () => Object.assign({ v: 0, r: 0, z: 0, s: 0 }, (await st.get(kBud)) || {});
    // i piloti non fanno crescere i dati oltre la riserva: l'ultimo spazio resta all'Admin
    const oltreRiserva = (d, row) => { const g = new TextEncoder().encode(JSON.stringify(d)).length; return g > LIM.riservaAdmin && g > row.json.length; };
    const PIENO_PILOTA = () => J({ errore: "Lo spazio dei dati è quasi pieno: avvisa l'Admin (deve eliminare voli o documenti vecchi)." }, 413);
    // elenchi pieni: le verifiche delle zone più vecchie e le segnalazioni chiuse più vecchie passano nell'archivio (si tengono, non si cancellano)
    const archivia = async d => { let fatto = false;
      if (LISTA(d.ZONE).length > LIM.zoneMax) { const via = d.ZONE.splice(LIM.zoneMax - 200); await st.put("archivio:ZONE:" + now + ":" + rnd(2), via); fatto = true; }
      if (LISTA(d.SEGN).length > LIM.segnMax) { const chiuse = d.SEGN.filter(x => x && x.stato === "chiusa" && !x.fermo).slice(-(d.SEGN.length - LIM.segnMax + 50));
        if (chiuse.length) { const S = new Set(chiuse); d.SEGN = d.SEGN.filter(x => !S.has(x)); await st.put("archivio:SEGN:" + now + ":" + rnd(2), chiuse); fatto = true; } }
      return fatto; };

    // ---- corsi dell'azienda: li prepara l'Admin, li vedono i suoi piloti ----
    if (p === "/api/corsi" && request.method === "GET") {
      const F = (await st.get("corsi-fatti")) || {};
      return J({ az: (await st.get("corsi-az")) || [], fatti: adm ? F : { [me.n]: F[me.n] || {} }, io: me.n, adm });
    }
    if (p === "/api/corsi" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin prepara i corsi" }, 403);
      const tx = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, max);
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (!Array.isArray(b)) return J({ errore: "Dati non validi" }, 400);
      // i video li fa Quota 120 per tutti: ogni azienda ha un tetto di corsi, lezioni e scene
      if (b.length > LIM.corsi) return J({ errore: "Si possono preparare al massimo " + LIM.corsi + " corsi: togline uno prima di aggiungerne un altro." }, 400);
      for (const c of b) { if (!c || typeof c !== "object") return J({ errore: "Dati non validi" }, 400);
        if (LISTA(c.lezioni).length > LIM.lezioni) return J({ errore: "Un corso può avere al massimo " + LIM.lezioni + " lezioni." }, 400);
        for (const l of LISTA(c.lezioni)) if (!l || typeof l !== "object" || LISTA(l.scene).length > LIM.scene) return J({ errore: "Una lezione può avere al massimo " + LIM.scene + " scene." }, 400); }
      const pulito = b.map(c => ({ id: String(c.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "c" + now.toString(36), tok: /^[a-f0-9]{12}$/.test(c.tok || "") ? c.tok : rnd(6),
        t: tx(String(c.t || "Corso"), 120), s: tx(String(c.s || ""), 300), vis: "azienda", rev: String(c.rev || ""),
        // id in minuscolo: il nome del video (az-...) deve passare dal controllo del percorso dei video, che è in minuscolo
        lezioni: LISTA(c.lezioni).slice(0, LIM.lezioni).map(l => ({ id: String(l.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60) || "l" + now.toString(36) + rnd(2), t: tx(String(l.t || "Lezione"), 120), s: tx(String(l.s || ""), 200),
          leg: LISTA(l.leg).slice(0, 20).map(r => [tx(String(LISTA(r)[0] || ""), 80), tx(String(LISTA(r)[1] || ""), 300)]), h: "",
          q: LISTA(l.q).slice(0, 40).map(q => [tx(String(LISTA(q)[0] || ""), 300), LISTA(LISTA(q)[1]).slice(0, 6).map(o => tx(String(o || ""), 200)), Math.max(0, Math.min(5, Math.floor(+LISTA(q)[2] || 0))), tx(String(LISTA(q)[3] || ""), 400)]),
          scene: LISTA(l.scene).slice(0, LIM.scene).filter(x => x && typeof x === "object").map(x => { const y = {}; for (const k of ["k", "t", "n", "v"]) if (x[k]) y[k] = tx(String(x[k]), k === "v" ? 1500 : 120); if (Array.isArray(x.p) && x.p.length) y.p = x.p.slice(0, 8).map(z => tx(String(z), 160)); if (Array.isArray(x.l) && x.l.length) y.l = x.l.slice(0, 8).map(r => [tx(String(r[0] || ""), 60), tx(String(r[1] || ""), 160)]); return y; }) })) }));
      if (JSON.stringify(pulito).length > 400000) return J({ errore: "I corsi sono troppo lunghi: accorcia i testi." }, 413);
      // la voce dei video (testo letto): un tetto per lezione e per tutti i corsi dell'azienda
      let voceTot = 0;
      for (const c of pulito) for (const l of c.lezioni) { const nv = l.scene.reduce((a, x) => a + String(x.v || x.t || "").length, 0); voceTot += nv;
        if (nv > LIM.vocePerLezione) return J({ errore: "Il testo letto nel video della lezione «" + l.t + "» è troppo lungo (" + nv + " caratteri, al massimo " + LIM.vocePerLezione + "): accorcialo o dividi la lezione in due." }, 400); }
      if (voceTot > LIM.vocePerSpazio) return J({ errore: "I testi letti nei video di tutti i corsi sono troppo lunghi (" + voceTot + " caratteri, al massimo " + LIM.vocePerSpazio + "): accorciane qualcuno." }, 400);
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
      const x = Object.prototype.hasOwnProperty.call(disp, b.id) ? disp[b.id] : null; if (!x) return J({ errore: "Dispositivo non trovato" }, 404);
      if (x.stato === "invito" && b.op === "approva") return J({ errore: "È un pilota nuovo: tocca «Approva» nella sua riga" }, 400);
      if (b.id === id && b.op === "togli") return J({ errore: "Non puoi togliere te stesso" }, 400);
      x.stato = b.op === "approva" ? "ok" : b.op === "rifiuta" ? "rifiutato" : b.op === "togli" ? "tolto" : x.stato;
      if (b.op === "approva") x.app = true;
      if (b.op === "togli" && x.n) await togliCodici(x.n);   // via anche il calendario e l'invio dei voli di quella persona
      await st.put("disp", disp);
      return J({ ok: true, disp: pub(), blocchi });
    }

    // ---- link di invito: l'Admin lo crea o lo cambia, approva o rifiuta i profili arrivati ----
    if (p.startsWith("/api/invito/")) {
      if (!adm) return J({ errore: "Solo l'Admin" }, 403);
      if (request.method !== "POST") return J({ errore: "Richiesta non valida" }, 405);
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      b = b && typeof b === "object" ? b : {};
      if (p === "/api/invito/link") {
        if (PROVA) return SPENTA_PROVA();
        let inv = await st.get("invito");
        if (!inv || b.cambia) { inv = { tok: rnd(16), at: now }; await st.put("invito", inv); }
        return J({ tok: inv.tok, at: inv.at, msg: inv.msg || null });
      }
      if (p === "/api/invito/messaggio") {
        if (PROVA) return SPENTA_PROVA();
        const inv = await st.get("invito"); if (!inv) return J({ errore: "Prepara prima il link" }, 409);
        const pul = (v, n) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim().slice(0, n);
        if (b.parti) delete inv.msg;
        else { const o = pul(b.o, 120).replace(/\n/g, " "), t = pul(b.t, 1500);
          if (!o || !t) return J({ errore: "Scrivi l'oggetto e il messaggio" }, 400);
          inv.msg = { o, t }; }
        await st.put("invito", inv);
        return J({ ok: true, msg: inv.msg || null });
      }
      const x = Object.prototype.hasOwnProperty.call(disp, b.id) ? disp[b.id] : null;
      if (!x || x.stato !== "invito" || !x.inv) return J({ errore: "Questa richiesta non c'è più" }, 404);
      if (p === "/api/invito/rifiuta") { x.stato = "rifiutato"; delete x.inv; await st.put("disp", disp); return J({ ok: true, disp: pub(), blocchi }); }
      if (p === "/api/invito/approva") {
        const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
        const d = m.d, P = d.PILOTI = LISTA(d.PILOTI), S = d.SCHEDEP = d.SCHEDEP && typeof d.SCHEDEP === "object" ? d.SCHEDEP : {}, PE = d.PERM = d.PERM && typeof d.PERM === "object" ? d.PERM : {};
        const I = x.inv; let q = P.find(z => z && norm(z.nome) === norm(I.n)), esisteva = !!q;
        if (q && blocchi[q.id]) return J({ errore: q.nome + " è bloccato: sbloccalo prima in Utenti e permessi" }, 409);
        if (!q) { let pid = now * 10 + Math.floor(Math.random() * 10); while (P.some(z => z && z.id === pid)) pid++;
          q = { id: pid, nome: I.n, matr: "", att: [], scad: "", ok: true, sts: false, link: true }; P.push(q);
          S[pid] = { ruolo: "Pilota", tel: I.tel, email: I.email, ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
          PE[pid] = { admin: false, voliTutti: false, flotta: true, documenti: false, clienti: false, prezzi: false, enac: false, agri: false };
        } else { const sq = S[q.id] = S[q.id] && typeof S[q.id] === "object" ? S[q.id] : { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
          if (!sq.tel) sq.tel = I.tel; if (!sq.email) sq.email = I.email; }
        await scriviMain(d, m.row.ver + 1);
        Object.assign(x, { stato: "ok", app: true, pid: q.id, n: q.nome }); delete x.inv; await st.put("disp", disp);
        // l'email del pilota: gli avvisi partono solo dopo la conferma con il link (la stessa regola degli altri indirizzi)
        try { await this.chiediConferme(d, url.origin, OPN); } catch (e) { console.error("conferme:", e && e.message || e); }
        return J({ ok: true, pid: q.id, nome: q.nome, esisteva, ver: m.row.ver + 1, disp: pub(), blocchi });
      }
      return J({ errore: "Richiesta sconosciuta" }, 404);
    }

    // ---- codice lavoro: il pilota lo scrive e riceve solo cliente, lavoro e luogo (niente importi) ----
    if (p === "/api/lavoro") {
      // un tetto alle ricerche (niente tentativi a raffica sui codici) e solo i lavori che il pilota può vedere
      const kl = "lavlim:" + id + ":" + Math.floor(now / 36e5), nl = (await st.get(kl)) || 0;
      if (!adm && nl >= LIM.lavoroOra) return J({ errore: "Troppe ricerche di codici: riprova tra un'ora" }, 429);
      await st.put(kl, nl + 1);
      const c = norm(url.searchParams.get("c")).replace(/\s/g, ""), m = await leggiMain();
      const l = c && m && (m.d.LAVORI || []).find(x => norm(x.codice).replace(/\s/g, "") === c && x.stato !== "concluso" && lavoroVisibile(m.d, x, adm, me.n));
      return J({ lavoro: l ? { id: l.id, codice: l.codice, cliente: l.cliente, titolo: l.titolo, luogo: l.luogo, data: l.data, istr: LISTA(l.istr).slice(0, 30), quota: l.missione && l.missione.quota || null } : null });
    }
    if (p === "/api/avvisi/prova" && request.method === "POST") {
      if (!adm) return J({ errore: "Solo l'Admin" }, 403);
      if (PROVA) return SPENTA_PROVA();
      // la prova degli avvisi manda una mail: al massimo 3 all'ora e 10 al giorno
      { const ko = "prova-avvisi:" + giornoUTC(), c = (await st.get(ko)) || { n: 0, ore: [] }, ore = LISTA(c.ore).filter(t => now - t < 36e5);
        if (c.n >= LIM.provaAvvisiGiorno) return J({ errore: "Oggi hai già mandato " + LIM.provaAvvisiGiorno + " prove degli avvisi: riprova domani." }, 429);
        if (ore.length >= LIM.provaAvvisi) return J({ errore: "Hai già mandato " + LIM.provaAvvisi + " prove nell'ultima ora: riprova più tardi." }, 429);
        ore.push(now); await st.put(ko, { n: c.n + 1, ore }); }
      try { return J(await this.avvisi(true, BASEURL)); } catch (e) { const m = String(e.message || e); return J({ errore: m.startsWith("posta") ? "posta" : m, dettaglio: m.startsWith("posta:") ? m.slice(6) : "" }, m.startsWith("posta") || m.startsWith("La posta") ? 502 : 400); }
    }
    if (p === "/api/volo/trk") {
      const vid = +url.searchParams.get("id"), m = await leggiMain(), v = m && (m.d.VOLI || []).find(x => x.id === vid);
      if (!v) return J({ errore: "Volo non trovato" }, 404);
      if (!adm && v.pilota !== me.n && !permDi(m.d, me.n).voliTutti) return J({ errore: "Non puoi vederlo" }, 403);
      return J({ trk: (await st.get("trk:" + vid)) || [] });
    }
    // ---- etichetta QR del drone: «Lo prendo io» / «Lo riconsegno». Il pilota non scrive i droni: qui cambia solo chi ce l'ha ----
    if (p === "/api/drone/presa" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      if (!adm && !pilotaDi(m.d, me.n)) return J({ errore: "Non sei tra i piloti" }, 403);
      const dr = (m.d.DRONI || []).find(x => x.id === +b.id); if (!dr) return J({ errore: "Drone non trovato" }, 404);
      // riconsegnarlo può solo chi ce l'ha (o l'Admin): nessuno toglie il nome di un altro
      if (!b.on && dr.chi && dr.chi.n !== me.n && !adm) return J({ errore: "Lo ha " + TX(dr.chi.n, 80) + ": lo riconsegna lui (o l'Admin)." }, 403);
      if (b.on) dr.chi = { n: TX(me.n, 80), dal: new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(",", "") };
      else delete dr.chi;
      await scriviMain(m.d, m.row.ver + 1);
      return J({ ok: true, chi: dr.chi || null, ver: m.row.ver + 1 });
    }
    // ---- registri di volo DJI: la chiave resta qui, il telefono chiede solo le chiavi del suo file ----
    if (p === "/api/dji/keychains" && request.method === "POST") {
      if (PROVA) return SPENTA_PROVA();
      if (!this.env.DJI_API_KEY) return J({ errore: "chiave_dji" }, 503);
      const txt = await request.text(); if (txt.length > 300000) return J({ errore: "Richiesta troppo grande" }, 413);
      // solo la forma che usa il lettore dei registri: { version, department, keychainsArray: [[{...}]] }
      let kb; try { kb = JSON.parse(txt); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const okK = kb && typeof kb === "object" && !Array.isArray(kb) && Number.isFinite(+kb.version) && Number.isFinite(+kb.department) && Array.isArray(kb.keychainsArray) && kb.keychainsArray.length <= 2000
        && kb.keychainsArray.every(a => Array.isArray(a) && a.length <= 200 && a.every(x => x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length <= 10 && Object.values(x).every(v => ["string", "number"].includes(typeof v) && String(v).length <= 2000)))
        && Object.keys(kb).every(x => ["version", "department", "keychainsArray"].includes(x));
      if (!okK) return J({ errore: "Dati non validi" }, 400);
      // la richiesta si prenota prima (telefono, spazio e tutti gli spazi insieme) e si rende se DJI non risponde
      const g = giornoUTC(), kd = "dji:" + id + ":" + g, ks = "dji:spazio:" + g;
      const rendi = async tutti => { await this.ctx.blockConcurrencyWhile(async () => { await st.put(kd, Math.max(0, ((await st.get(kd)) || 0) - 1)); await st.put(ks, Math.max(0, ((await st.get(ks)) || 0) - 1)); }); if (tutti) await this.tetto("dji", 1, true); };
      { let no = false;
        await this.ctx.blockConcurrencyWhile(async () => { const nd = (await st.get(kd)) || 0, ns = (await st.get(ks)) || 0;
          if (nd >= LIM.djiDisp || ns >= LIM.djiSpazio) { no = true; return; } await st.put(kd, nd + 1); await st.put(ks, ns + 1); });
        if (no) return J({ errore: "Oggi sono già stati letti tanti registri DJI: riprova domani." }, 429);
        if (!(await this.tetto("dji"))) { await rendi(false); return J({ errore: "Oggi sono già stati letti tanti registri DJI: riprova domani." }, 429); } }
      try {
        const r = await fetch(DJI_KEYCHAINS, { method: "POST", headers: { "content-type": "application/json", "api-key": this.env.DJI_API_KEY }, body: txt });
        const j = await r.json().catch(() => ({}));
        if (OCCUPATO(r.status)) await rendi(true);
        if (!r.ok || !j.data) return J({ errore: "DJI non ha dato le chiavi" + (j.result && j.result.msg ? ": " + TX(j.result.msg, 200) : " (" + r.status + ")") }, 502);
        return J({ data: j.data });
      } catch (e) { await rendi(true); return J({ errore: "DJI non risponde: riprova tra poco" }, 502); }
    }
    if (p === "/api/volo/leggifoto" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Foto non trovata" }, 404);
      if (!mio(info)) return J({ errore: "Non è tua" }, 403);
      if (!this.env.ANTHROPIC_API_KEY) return J({ errore: "chiave" }, 503);
      if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) return J({ errore: "Serve una foto JPEG o PNG" }, 415);
      if (info.lettoFoto) return J({ letto: info.lettoFoto, gia: true });   // la stessa foto letta di nuovo: la risposta di prima
      { const no = await limiteClaude(id); if (no) return no; }
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(new Uint8Array(await st.get("doc:" + b.id + ":" + i)));
      const tutto = new Uint8Array(info.size); let o = 0; for (const x of parti) { tutto.set(x, o); o += x.length; }
      const m = await leggiMain(), droni = ((m && m.d.DRONI) || []).map(x => x.nome).join("; ");
      try { const letto = await leggiFotoVolo(this.env, b64(tutto.buffer), info.mime, droni);
        if (letto && typeof letto === "object" && JSON.stringify(letto).length < 20000) { info.lettoFoto = letto; await st.put("docinfo:" + b.id, info); }
        return J({ letto }); }
      catch (e) { if (e && e.rendi) await rendiClaude(id, true); return J({ errore: String(e.message || e) }, 502); }
    }
    if (p === "/api/segnala" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      if (!SG_TIPI[b.tipo]) return J({ errore: "Scegli cosa è successo" }, 400);
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, dr = (d.DRONI || []).find(x => x.nome === b.drone);
      if (!dr) return J({ errore: "Scegli il drone" }, 400);
      const foto = [];
      for (const f of (Array.isArray(b.foto) ? b.foto : []).slice(0, 8)) { if (typeof f !== "string") continue; const info = await st.get("docinfo:" + f); if (mio(info)) foto.push(TX(f, 40)); }
      const x = { id: now * 10 + Math.floor(Math.random() * 10), at: now, data: DATA(b.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(b.ora || "") ? b.ora : "", pilota: adm && b.pilota ? TX(b.pilota, 80) : me.n,
        drone: dr.nome, tipo: b.tipo, feriti: !!b.feriti, danni: !!b.danni, testo: TX(b.testo, 2000, true), luogo: TX(b.luogo, 160), foto, volo: TX(b.volo, 20), fermo: true, stato: "aperta", eccairs: "" };
      // guasto trovato a terra nella check list prima del volo (il drone non ha volato): non è un evento da segnalare a ENAC
      if (b.prima === true && b.tipo === "guasto") x.prima = true;
      x.liv = x.prima ? "facolt" : livSegn(x);
      // un tetto al giorno per pilota; le segnalazioni già fatte non si cancellano mai (quando l'elenco è pieno vanno in archivio solo quelle chiuse)
      const bu = adm ? null : await leggiBud();
      if (bu && bu.s >= LIM.segnPilota) return J({ errore: "Oggi hai già mandato " + LIM.segnPilota + " segnalazioni: per le altre avvisa l'Admin." }, 429);
      d.SEGN = d.SEGN || []; d.SEGN.unshift(x);
      if (d.SEGN.length > LIM.segnMax) { await archivia(d); if (d.SEGN.length > LIM.segnMax) return J({ errore: "L'elenco delle segnalazioni è pieno (" + LIM.segnMax + " aperte): l'Admin deve chiudere quelle sistemate in Pannello Admin › Segnalazioni." }, 413); }
      if (!adm && oltreRiserva(d, m.row)) return PIENO_PILOTA();
      await scriviMain(d, m.row.ver + 1);
      if (bu) { bu.s++; await st.put(kBud, bu); }
      // mail subito all'Admin (non nella versione di prova: lì le email sono spente)
      const A = (d.AVVISI || {}).adm || {};
      // al massimo 10 email di segnalazione all'ora per spazio (la segnalazione resta comunque nel programma)
      const ksm = "segnmail:" + Math.floor(now / 36e5) + ":" + giornoUTC(), nsm = (await st.get(ksm)) || 0;
      // solo a un indirizzo confermato, e dentro il tetto delle email automatiche dello spazio
      if (!PROVA && EMAIL(A.email) && A.on !== false && nsm < LIM.segnMail && (await this.confermate()).ok.has(minu(A.email)) && await this.puoMandare()) {
        await st.put(ksm, nsm + 1);
        const txt = x.liv === "grave" ? "Incidente grave: avvisare subito ANSV e segnalare a ENAC su ECCAIRS 2 entro 72 ore." : x.liv === "enac" ? "Da segnalare a ENAC su ECCAIRS 2 entro 72 ore." : "Segnalazione facoltativa a ENAC, consigliata se riguarda la sicurezza.";
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#0F1C26;font-size:15px;line-height:1.45"><div style="border-bottom:2px solid #132A3A;padding-bottom:10px;margin-bottom:14px;font-size:20px;font-weight:bold;color:#132A3A">Quota 120</div>
          <div style="background:${x.liv === "grave" ? "#AE2F28" : "#A5660A"};color:#fff;border-radius:8px;padding:10px 14px;font-weight:bold">${esc(txt)}</div>
          <p><b>${esc(SG_TIPI[x.tipo])}</b> · ${esc(SENZA_LINK(x.drone, 80))}<br>${esc(SENZA_LINK(x.pilota, 80))} · ${x.data} ${x.ora}${x.luogo ? " · " + esc(SENZA_LINK(x.luogo, 160)) : ""}<br>Feriti: ${x.feriti ? "sì" : "no"} · Danni: ${x.danni ? "sì" : "no"}</p><p>${esc(x.testo)}</p>
          <p>Il drone resta fermo finché non lo sblocchi in Pannello Admin › Segnalazioni.</p><a href="${(await st.get("origine")) || BASEURL}" style="display:inline-block;background:#1D5C7C;color:#fff;border-radius:8px;padding:12px 18px;font-weight:bold;text-decoration:none">Apri Quota 120</a></div>`;
        try { await mandaMail(this.env, A.email.trim(), (x.liv === "grave" ? "URGENTE · " : "") + "Segnalazione: " + SG_TIPI[x.tipo] + " · " + SENZA_LINK(x.drone, 80), html); } catch (e) {}
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
      return J({ arrivi: L.filter(x => mio(x)) });
    }
    if (p === "/api/arrivi" && request.method === "POST") {   // file arrivati da Android (Condividi › Quota 120) o dal telefono
      const nome = TX(dec(request.headers.get("x-nome") || "") || "volo.txt", 120), buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 30 * 1024 * 1024) return J({ errore: "File non valido" }, 400);
      const k1 = "arrivo:" + me.n + ":" + nome + ":" + buf.byteLength;
      if (await st.get(k1)) return J({ ok: true, gia: true });
      { const no = await puoCaricare(id, buf.byteLength); if (no) return J({ errore: NO_CARICA[no] }, no === "pieno" ? 413 : 429); }
      const did = await salvaFile(buf, { mime: "text/plain", nome, da: me.n, pid: me.pid ?? null });
      await st.put(k1, did);
      const L = (await st.get("arrivi")) || []; L.push({ id: did, nome, size: buf.byteLength, da: me.n, pid: me.pid ?? null, at: now, via: TX(request.headers.get("x-via") || "Android", 20) }); await st.put("arrivi", L.slice(-300));
      if (L.length > 300) await togliSeLiberi(L.slice(0, L.length - 300).map(x => x.id));   // quelli usciti dall'elenco: via i file non usati
      return J({ ok: true, id: did });
    }
    // lettura automatica: chi apre Quota 120 «prende» i voli arrivati (uno alla volta, nessun doppione tra due telefoni aperti insieme)
    if (p === "/api/arrivi/prendi" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ids = new Set(Array.isArray(b.ids) ? b.ids.slice(0, 20) : []), L = (await st.get("arrivi")) || [], presi = [];
      for (const x of L) if (ids.has(x.id) && mio(x) && !x.sist && !(x.presa && now - x.presa < 600000)) { x.presa = now; x.chi = me.n; presi.push(x.id); }
      await st.put("arrivi", L);
      return J({ presi });
    }
    if (p === "/api/arrivi/sistemare" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const L = (await st.get("arrivi")) || [], x = L.find(y => y.id === b.id && mio(y));
      if (x) { x.sist = TX(b.motivo || "da controllare", 200); x.presa = 0; if (b.info && typeof b.info === "object") x.info = { data: TX(b.info.data, 10), ora: TX(b.info.ora, 5), drone: TX(b.info.drone, 80) }; await st.put("arrivi", L); }
      return J({ ok: true });
    }
    if (p === "/api/arrivi/libera" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ids = new Set(Array.isArray(b.ids) ? b.ids : []), L = (await st.get("arrivi")) || [];
      for (const x of L) if (ids.has(x.id) && mio(x)) x.presa = 0;
      await st.put("arrivi", L); return J({ ok: true });
    }
    if (p === "/api/arrivi/letti" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ids = new Set(Array.isArray(b.ids) ? b.ids : []), L = (await st.get("arrivi")) || [];
      const via = L.filter(x => ids.has(x.id) && mio(x));
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
      // i voli caricati dal pilota hanno lo stesso tetto giornaliero dei voli salvati dal telefono
      const bu = adm ? null : await leggiBud();
      if (bu && bu.v >= LIM.voliGiornoPilota) return J({ errore: "Oggi hai già caricato " + LIM.voliGiornoPilota + " voli: gli altri li carichi domani (o li carica l'Admin)." }, 429);
      const L = pulisciLetto(Object.assign({}, v0, { letto: true }));
      L.fotoDoc = "";   // la foto allegata la mette solo il server (qui sotto, quando completa un volo caricato con la foto)
      if (L.batt && !(d.BATT || []).some(x => x.id === L.batt)) L.batt = "";
      if (v0.codLav && !v0.cliente) { const lw = (d.LAVORI || []).find(x => norm(x.codice).replace(/\s/g, "") === norm(v0.codLav).replace(/\s/g, "") && lavoroVisibile(d, x, adm, me.n)); if (lw) { v0.cliente = lw.cliente + ": " + String(lw.titolo || "").toLowerCase(); if (!v0.luogo) v0.luogo = lw.luogo; } }
      if (L.daFoto) L.logKey = "foto|" + TX(v0.drone, 80) + "|" + (DATA(v0.data) || "") + "|" + TX(v0.ora, 5);
      if (L.logKey && (d.VOLI || []).some(x => x.logKey === L.logKey)) return J({ errore: "doppio" }, 409);
      // lo stesso volo letto due volte con una chiave diversa: stesso drone, giorno, ora di decollo e durata → non si conta di nuovo
      { const dd = DATA(v0.data) || oggi(), oo = /^\d{2}:\d{2}$/.test(v0.ora || "") ? v0.ora : "00:00", mm = NUM(v0.min, 0, 600);
        if (!L.daFoto && (d.VOLI || []).some(x => x.letto && !x.daFoto && x.drone === v0.drone && x.data === dd && x.ora === oo && Math.abs((+x.min || 0) - mm) < 1)) return J({ errore: "doppio" }, 409); }
      // la stessa foto (o un'altra foto dello stesso volo) caricata due volte: non si conta due volte
      if (L.daFoto && (d.VOLI || []).some(x => x.daFoto && x.pilota === pilota && x.drone === v0.drone && x.data === (DATA(v0.data) || oggi()) && x.ora === v0.ora)) return J({ errore: "doppio" }, 409);
      if (typeof b.docLog !== "string") b.docLog = "";
      if (b.docLog) { const info = await st.get("docinfo:" + b.docLog); if (!info || !mio(info)) b.docLog = ""; }
      const v = Object.assign({ id: Date.now() * 10 + Math.floor(Math.random() * 10), data: DATA(v0.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(v0.ora || "") ? v0.ora : "00:00",
        drone: v0.drone, pilota, luogo: TX(v0.luogo, 120), min: NUM(v0.min, 0, 600), stato: "completo", ctrl: !!v0.ctrl, ctrlOra: TX(v0.ctrlOra, 5),
        cliente: TX(v0.cliente, 200), codLav: TX(v0.codLav, 20), note: TX(v0.note, 2000, true), importato: true, amano: false, cat: TX(v0.cat, 60), inc: "Nessuno",
        docLog: TX(b.docLog, 40), logNome: TX(v0.logNome, 120) }, L, { daTelefono: true });   // i valori li ha letti il telefono dal registro: restano com'erano, ma si sa da dove vengono
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
        Object.assign(v, { id: att.id, ctrl: att.ctrl, ctrlOra: att.ctrlOra, cliente: v.cliente || att.cliente || "", codLav: att.codLav || "", meteo: att.meteo || "", zona: att.zona || "", ck: att.ck || "", istrOk: att.istrOk,
          luogo: v.luogo || att.luogo, note: [att.note, v.note].filter(Boolean).join(" · "), cat: att.cat || v.cat });
        if (daFoto) Object.assign(v, { cliente: att.cliente || v.cliente, luogo: att.luogo || v.luogo, batt: att.batt || v.batt, fotoDoc: att.docLog || "" });
        d.VOLI[d.VOLI.indexOf(att)] = v;
      } else d.VOLI.unshift(v);
      if (!daFoto) applicaVolo(d, v);
      v.contato = true;
      if (!adm && oltreRiserva(d, m.row)) return PIENO_PILOTA();
      if (v.haTrk) await st.put("trk:" + v.id, trk);
      await scriviMain(d, m.row.ver + 1);
      if (bu) { bu.v++; await st.put(kBud, bu); }
      return J({ ok: true, id: v.id, ver: m.row.ver + 1 });
    }

    // ---- dati ----
    if (p === "/api/stato") {
      const m = await leggiMain();
      if (!m) return J({ vuoto: true });
      // emailOk (solo Admin): per ogni indirizzo degli avvisi, true = confermato, "inviata" = gli abbiamo mandato l'email di conferma, false = non ancora
      const statoEmail = async d => { if (!OPN) return {}; const { ok, C } = await this.confermate(), out = {}; for (const a of destAvvisi(d, true)) out[a] = ok.has(a) ? true : C[a] && C[a].inviato ? "inviata" : false; return out; };
      const { row } = m, io = { r: me.ruolo, n: me.n, id, asp: aspetti[me.n] || ASP_BASE, email: me.via === "email" ? me.email : "" }, extra = adm ? { disp: pub(), blocchi, pinIniziale: !!OPN && !(await st.get("pin")), emailOk: await statoEmail(m.d) } : {};
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
          const nuovi = new Set(LISTA(nd.PILOTI).map(q => q && q.nome)), nuoviId = new Map(LISTA(nd.PILOTI).filter(q => q && q.nome).map(q => [q.id, q.nome]));
          let dispCambiati = false;
          for (const q of LISTA(m.d.PILOTI)) if (q && q.nome && !nuovi.has(q.nome)) { await togliCodici(q.nome);
            // pilota tolto: i suoi telefoni escono subito; rinominato (stesso id): i telefoni prendono il nome nuovo
            const nuovoNome = nuoviId.get(q.id);
            for (const x of Object.values(disp)) if (x.ruolo === "op" && (x.pid === q.id || (x.pid == null && x.n === q.nome))) {
              if (nuovoNome) { x.n = nuovoNome; x.pid = q.id; } else if (x.stato !== "tolto") x.stato = "tolto"; dispCambiati = true; } }
          if (dispCambiati) await st.put("disp", disp);
          // valutazioni del rischio: anche quelle salvate dall'Admin passano dal controllo dei campi
          if (Array.isArray(nd.RISCHI)) nd.RISCHI = nd.RISCHI.slice(0, 2000).map(pulisciRischio).filter(Boolean);
          // date, ore, livelli e stati: solo valori del loro tipo (il resto diventa vuoto); avvisi: ora, soglie ammesse ed email vere
          for (const k3 of Object.keys(nd)) if (!["RISCHI", "DOCS", "ZONEINFO", "AVVISI"].includes(k3)) nd[k3] = pulisciAdmin(nd[k3], k3);
          if (nd.AVVISI != null) nd.AVVISI = pulisciAvvisi(nd.AVVISI);
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
            if (x && !docOk.has(x) && docOk.size < 50) { const info = await st.get("docinfo:" + x); if (info && mio(info)) docOk.add(x); } }
          // tetto giornaliero di record nuovi per pilota, e spazio sempre libero per l'Admin
          const bu = await leggiBud(), lim = { v: LIM.voliGiornoPilota - bu.v, r: LIM.rischiGiornoPilota - bu.r, z: LIM.zonePilota - bu.z }, lim0 = Object.assign({}, lim);
          nd = unisci(m.d, b.data || {}, me.n, docOk, lim);
          if (lim.troppe === "zone") avviso = "Oggi hai già registrato " + LIM.zonePilota + " verifiche delle zone: le altre non sono state salvate (i voli sì).";
          if (oltreRiserva(nd, row)) return PIENO_PILOTA();
          if (lim.v !== lim0.v || lim.r !== lim0.r || lim.z !== lim0.z) await st.put(kBud, Object.assign(bu, { v: bu.v + (lim0.v - lim.v), r: bu.r + (lim0.r - lim.r), z: bu.z + (lim0.z - lim.z) }));
        }
        if (await archivia(nd)) salto = true;
        await scriviMain(nd, row.ver + 1);
        // indirizzi nuovi negli avvisi: una email di conferma (finché non confermano, gli avvisi non partono)
        try { await this.chiediConferme(nd, url.origin, OPN); } catch (e) { console.error("conferme:", e && e.message || e); }
        return J(Object.assign({ ver: row.ver + 1, salto }, avviso ? { avviso } : {}, adm && OPN ? { emailOk: await statoEmail(nd) } : {}));
      }
    }

    // ---- documenti ----
    if (p === "/api/doc" && request.method === "POST") {
      const mime = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!TIPI_FILE[mime]) return J({ errore: "Si possono caricare PDF, foto o il file del registro di volo" }, 415);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return J({ errore: "File vuoto" }, 400);
      if (buf.byteLength > MAXDOC) return J({ errore: "Il file supera i 10 MB" }, 413);
      { const no = await puoCaricare(id, buf.byteLength); if (no) return J({ errore: NO_CARICA[no] }, no === "pieno" ? 413 : 429); }
      const nome = TX(dec(request.headers.get("x-nome") || "") || "documento", 120);
      const did = await salvaFile(buf, { mime, nome, da: me.n, pid: me.pid ?? null });
      return J({ id: did, nome, size: buf.byteLength });
    }
    // manda un documento (es. la valutazione del rischio in PDF) per email, con l'allegato; la risposta arriva all'operatore
    if (p === "/api/doc/invia" && request.method === "POST") {
      if (PROVA) return SPENTA_PROVA();
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.d); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!mio(info)) return J({ errore: "Non puoi mandarlo" }, 403);
      const a = String(b.a || "").trim(); if (!EMAIL(a)) return J({ errore: "Indirizzo email non valido" }, 400);
      // spazi appena nati: i documenti per email partono solo dopo 3 giorni, oppure dopo aver confermato un indirizzo degli avvisi (con il link nell'email)
      if (now - (+(creato || {}).at || 0) < 3 * 864e5 && !Object.values((await st.get("conferme")) || {}).some(x => x && x.ok))
        return J({ errore: "Nei primi 3 giorni dall'iscrizione i documenti per email partono solo dopo aver confermato un indirizzo degli avvisi (Pannello Admin › Avvisi via email). Intanto puoi scaricare il PDF e mandarlo tu." }, 403);
      // al massimo 30 invii al giorno per spazio e 10 per telefono (giorno UTC)
      // al massimo 30 invii al giorno per spazio, 10 per telefono e 3 allo stesso indirizzo (giorno UTC)
      const g = giornoUTC(), cnt0 = (await st.get("invia:giorno")) || {}, cnt = cnt0.g === g ? cnt0 : { g, n: 0, disp: {} }, kd = "invia:dest:" + a.toLowerCase() + ":" + g, nd = (await st.get(kd)) || 0;
      if (cnt.n >= LIM.inviaSpazio) return J({ errore: "Oggi sono già stati mandati " + LIM.inviaSpazio + " documenti per email da questo spazio: riprova domani." }, 429);
      if ((cnt.disp[id] || 0) >= LIM.inviaDisp) return J({ errore: "Oggi hai già mandato " + LIM.inviaDisp + " documenti per email da questo telefono: riprova domani." }, 429);
      if (nd >= LIM.inviaDest) return J({ errore: "Oggi a questo indirizzo sono già stati mandati " + LIM.inviaDest + " documenti: riprova domani." }, 429);
      cnt.n++; cnt.disp[id] = (cnt.disp[id] || 0) + 1; await st.put("invia:giorno", cnt); await st.put(kd, nd + 1);
      if (!(await this.tetto("mail"))) { await this.ctx.blockConcurrencyWhile(async () => { const c2 = (await st.get("invia:giorno")) || {}; if (c2.g === g) { c2.n = Math.max(0, c2.n - 1); c2.disp[id] = Math.max(0, (c2.disp[id] || 1) - 1); await st.put("invia:giorno", c2); } await st.put(kd, Math.max(0, ((await st.get(kd)) || 1) - 1)); });
        return J({ errore: "Oggi sono partite troppe email da Quota 120: riprova domani." }, 429); }
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(await st.get("doc:" + b.d + ":" + i));
      const buf = await new Blob(parti).arrayBuffer(), m = await leggiMain(), op = m ? String((m.d.OP || {}).nome || "").replace(/ \(dati di esempio\)/, "") : "";
      const testo = esc(String(b.testo || "").slice(0, 2000), 2000).replace(/\n/g, "<br>");
      // nome del file: solo caratteri semplici, con l'estensione giusta; oggetto: sempre con il nome dell'operatore e «tramite Quota 120»
      const est = TIPI_FILE[info.mime] || "pdf", base = String(info.nome || "documento").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^\w\-. àèéìòùÀÈÉÌÒÙ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "documento", nomeAll = base + "." + est;
      const opS = SENZA_LINK(op, 60) || "Un operatore", oggetto = opS + " tramite Quota 120: " + (SENZA_LINK(b.oggetto, 100) || base);
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#0F1C26;font-size:15px;line-height:1.5">${testo}<p style="font-size:12.5px;color:#5E6D77;margin-top:18px;border-top:1px solid #E3E8EB;padding-top:10px">Inviato da ${esc(opS, 120)} con Quota 120. In allegato: ${esc(nomeAll, 120)}.</p></div>`;
      try { await mandaMail(this.env, a, oggetto, html, [{ nome: nomeAll, b64: b64(buf) }], m && EMAIL((m.d.OP || {}).email) ? m.d.OP.email.trim() : null); }
      catch (e) { return J({ errore: String(e.message || e).replace(/^posta:/, "La posta non è pronta: ").slice(0, 300) }, 502); }
      return J({ ok: true });
    }
    if (p === "/api/doc/leggi" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!mio(info)) return J({ errore: "Non è tuo" }, 403);
      if (!this.env.ANTHROPIC_API_KEY) return J({ errore: "chiave" }, 503);
      if (info.mime === "image/heic") return J({ errore: "heic" }, 415);
      if (info.mime === "text/plain") return J({ errore: "Il registro di volo non si legge come documento" }, 415);
      if (info.letto) return J({ letto: info.letto, gia: true });   // lo stesso documento letto di nuovo: la risposta di prima, senza rifare la lettura
      { const no = await limiteClaude(id); if (no) return no; }
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(new Uint8Array(await st.get("doc:" + b.id + ":" + i)));
      const tutto = new Uint8Array(info.size); let o = 0; for (const x of parti) { tutto.set(x, o); o += x.length; }
      const m = await leggiMain();
      let letto; try { letto = await leggiConClaude(this.env, b64(tutto.buffer), info.mime, m ? m.d : {}); }
      catch (e) { if (e && e.rendi) await rendiClaude(id, true); return J({ errore: String(e.message || e) }, 502); }
      // quello che ha letto Claude resta col file: alla conferma si confronta con quello che manda il telefono
      const ld = (letto && letto.dest) || {}, lx = (letto && letto.dati) || {};
      info.claude = { tipo: TX(letto && letto.tipo, 120), dest: { k: TX(ld.k, 20), id: ld.id == null ? null : +ld.id, voce: TX(ld.voce, 30) },
        dati: { numero: TX(lx.numero, 60), rilascio: DATA(lx.rilascio), scadenza: DATA(lx.scadenza) }, il: now };
      if (letto && typeof letto === "object" && JSON.stringify(letto).length < 60000) info.letto = letto;
      await st.put("docinfo:" + b.id, info);
      return J({ letto });
    }
    if (p === "/api/doc/conferma" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const info = await st.get("docinfo:" + b.id); if (!info) return J({ errore: "Documento non trovato" }, 404);
      if (!mio(info)) return J({ errore: "Non è tuo" }, 403);
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, dest = b.dest || {};
      const k2 = ["pilota", "drone", "operatore", "altro"].includes(dest.k) ? dest.k : "altro";
      if (!adm) { const mio = pilotaDi(d, me.n); if (!(k2 === "pilota" && mio && +dest.id === mio.id)) return J({ errore: "Puoi caricare solo i tuoi documenti" }, 403); }
      const cat = {}; for (const [c, arr] of Object.entries(b.categorie || {}).slice(0, 20)) cat[TX(c, 60)] = LISTA(arr).slice(0, 40).map(r => Array.isArray(r) ? [TX(r[0], 80), TX(r[1], 300)] : ["", TX(r, 300)]);
      const dati = { numero: TX((b.dati || {}).numero, 60), rilascio: DATA((b.dati || {}).rilascio), scadenza: DATA((b.dati || {}).scadenza) };
      const doc = { id: b.id, nome: info.nome, mime: info.mime, tipo: TX(b.tipo, 120) || "Documento", dest: { k: k2, id: dest.id == null ? null : +dest.id, voce: TX(dest.voce, 30) },
        dati, categorie: cat, data: oggi(), da: me.n, dapid: adm ? null : me.pid ?? null };
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
      if (!adm && oltreRiserva(d, m.row)) return PIENO_PILOTA();
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
        if (!(mio(info) || suoVolo || (doc && docVisibile(m.d, doc, me.n)))) return J({ errore: "Non puoi vederlo" }, 403); }
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
  const soglie = giorniAvviso(A.giorni).sort((a, b) => b - a);
  const inviati = (await st.get("avvisi:inviati")) || {};
  // una scadenza si manda quando passa una soglia (e una volta sola per soglia)
  const righe = [];
  for (const [k, t, s, data, pid] of scadenze(d)) {
    const ts = dtS(data); if (ts == null) continue;
    const g = Math.round((ts - oggi.t) / 86400000), dentro = soglie.filter(x => x >= g), sg = dentro.length ? Math.min(...dentro) : null;
    if (sg == null && g >= 0) continue;
    const chiave = k + "|" + data + "|" + (g < 0 ? "scaduto" : sg);
    if (!prova && inviati[chiave]) continue;
    if (prova && g > soglie[0]) continue;
    righe.push({ t, s, g, pid, k: chiave });
  }
  for (const [k, t, s] of battPeggio(d)) { if (!prova && inviati[k]) continue; righe.push({ t, s, g: null, pid: null, k }); }
  for (const [k, t, s] of manutenzioni(d)) { if (!prova && inviati[k]) continue; righe.push({ t, s, g: null, pid: null, k }); }
  righe.sort((a, b) => (a.g == null ? 999 : a.g) - (b.g == null ? 999 : b.g));
  const nomeOp = SENZA_LINK(String((d.OP || {}).nome || "").replace(/ \(dati di esempio\)/, ""), 60), url = (await st.get("origine")) || origine || "", esiti = [], errori = [], saltati = [];
  const adm = A.adm || {}, { ok: conf } = await this.confermate(), mandate = new Set();
  if (prova && !EMAIL(adm.email)) throw new Error("Scrivi prima la tua email e salva");
  if (prova && !conf.has(minu(adm.email))) throw new Error("Prima conferma il tuo indirizzo: ti abbiamo mandato un'email con il link (guarda anche nello spam).");
  // gli avvisi partono solo verso indirizzi confermati, e dentro il tetto delle email automatiche (per spazio e per tutti)
  // nell'invio programmato una mail che non parte non ferma le altre; nella prova l'errore torna all'Admin
  const manda = async (a, ogg, html, mie) => {
    if (!conf.has(minu(a))) { saltati.push(a); return; }
    if (!(await this.puoMandare())) { if (prova) throw new Error("Oggi sono già partite tante email da questo spazio: riprova domani."); saltati.push(a); return; }
    if (prova) { await mandaMail(this.env, a, ogg, html); esiti.push(a); return; }
    try { await mandaMail(this.env, a, ogg, html); esiti.push(a); for (const r of mie) mandate.add(r.k); } catch (e) { console.error("avviso non mandato:", e && e.message || e); errori.push(a); } };
  if (adm.on !== false && EMAIL(adm.email) && (righe.length || prova)) {
    const ogg = prova ? "Prova degli avvisi di Quota 120" : pl0(righe.length, "scadenza in arrivo", "scadenze in arrivo") + (nomeOp ? " · " + nomeOp : "");
    await manda(adm.email.trim(), ogg, righe.length ? mailHtml(nomeOp, righe, true, url) : mailHtml(nomeOp, [{ t: "Nessuna scadenza in arrivo", s: "Gli avvisi funzionano: quando qualcosa starà per scadere riceverai una mail come questa.", g: null }], true, url), righe);
  }
  if (!prova) for (const p of d.PILOTI || []) {
    const c = (A.piloti || {})[p.id] || {}, pe = ((d.SCHEDEP || {})[p.id] || {}).email || "", em = EMAIL(c.email) ? c.email : pe, on = c.on !== undefined ? !!c.on : !!pe;
    if (!on || !EMAIL(em)) continue;
    const mie = righe.filter(r => r.pid === p.id); if (!mie.length) continue;
    await manda(em.trim(), pl0(mie.length, "tua scadenza in arrivo", "tue scadenze in arrivo"), mailHtml(nomeOp, mie, false, url), mie);
  }
  // si segnano come mandate solo le scadenze arrivate davvero a qualcuno (le altre riprovano il giorno dopo)
  if (!prova && mandate.size) { for (const k of mandate) inviati[k] = oggi.data; await st.put("avvisi:inviati", inviati); }
  return Object.assign({ ok: true, mandate: esiti, righe: righe.length }, errori.length ? { nonMandate: errori } : {}, saltati.length ? { saltati: saltati.length } : {});
};
// tetti di tutti gli spazi insieme, nel registro (dji, mail, provabyte, iscr): true = si può (se il registro non risponde, si va avanti)
Stato.prototype.tetto = async function (tipo, n = 1, rendi = false) {
  return this.env.STATO.get(this.env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/conta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tipo, n, rendi }) }))
    .then(r => r.json()).then(j => !!j.ok).catch(() => true);
};
// una email automatica in più (avvisi, prova degli avvisi, segnalazioni, conferme): tetto dello spazio e di tutti, prenotato prima
Stato.prototype.puoMandare = async function () {
  const st = this.ctx.storage, g = giornoUTC(); let ok = false;
  await this.ctx.blockConcurrencyWhile(async () => { const c = (await st.get("mail:giorno")) || {}, n = c.g === g ? c.n || 0 : 0; if (n >= LIM.mailSpazio) return; await st.put("mail:giorno", { g, n: n + 1 }); ok = true; });
  if (!ok) return false;
  if (await this.tetto("mail")) return true;
  await this.ctx.blockConcurrencyWhile(async () => { const c = (await st.get("mail:giorno")) || {}; if (c.g === g) await st.put("mail:giorno", { g, n: Math.max(0, (c.n || 0) - 1) }); });
  return false;
};
// indirizzi confermati: quelli confermati con il link, più le email con cui l'Admin entra (già verificate con il codice)
Stato.prototype.confermate = async function () {
  const st = this.ctx.storage, C = (await st.get("conferme")) || {}, cr = (await st.get("creato")) || {}, dsp = (await st.get("disp")) || {};
  const ok = new Set(Object.keys(C).filter(k => C[k] && C[k].ok));
  if (EMAIL(cr.email)) ok.add(minu(cr.email));
  for (const x of Object.values(dsp)) if (x && x.via === "email" && x.stato === "ok" && EMAIL(x.email)) ok.add(minu(x.email));
  return { ok, C };
};
// indirizzi degli avvisi nuovi o cambiati: UNA email di conferma per indirizzo (un'altra solo dopo 7 giorni, se non ha confermato)
Stato.prototype.chiediConferme = async function (d, origine, op) {
  if (!op) return;   // nella prova le email sono spente
  const st = this.ctx.storage, now = Date.now(), { ok, C } = await this.confermate();
  const nomeOp = String((d.OP || {}).nome || ""); let n = 0;
  for (const a of destAvvisi(d)) {
    if (ok.has(a) || (C[a] && now - (+C[a].inviato || 0) < 7 * 864e5)) continue;
    if (n >= LIM.confermeSalva || !(await this.puoMandare())) break;
    const tok = rnd(16); n++;
    await this.ctx.blockConcurrencyWhile(async () => { const C2 = (await st.get("conferme")) || {}; if (!(C2[a] && C2[a].ok)) { C2[a] = { ok: false, tok, inviato: now }; await st.put("conferme", C2); } });
    try { await mandaMail(this.env, a, "Conferma il tuo indirizzo per gli avvisi di Quota 120", confermaHtml(nomeOp, origine + "/api/avvisi/conferma?op=" + encodeURIComponent(op) + "&t=" + tok)); }
    catch (e) { console.error("conferma non mandata:", e && e.message || e);
      await this.ctx.blockConcurrencyWhile(async () => { const C2 = (await st.get("conferme")) || {}; if (C2[a] && C2[a].tok === tok && !C2[a].ok) { delete C2[a]; await st.put("conferme", C2); } }); }
  }
};
const pl0 = (n, s, p) => n + " " + (n === 1 ? s : p);

/* ---------- prova personale: è ancora viva? (null = sì, va avanti) ----------
   nasce solo con la richiesta che la crea (x-q120-prova-nuova, la mette lo smistatore); ogni uso sposta in avanti la scadenza */
Stato.prototype.provaVive = async function (request, p) {
  const st = this.ctx.storage, now = Date.now(), c = await st.get("prova:creato");
  if (!c) {
    if (request.headers.get("x-q120-prova-nuova") !== "1") return PROVA_SCADUTA();
    await st.put({ "prova:creato": now, "prova:visto": now }); await st.setAlarm(now + PROVA_FERMA); return null;
  }
  const v = (await st.get("prova:visto")) || c;
  if (now >= Math.min(c + PROVA_MAX, v + PROVA_FERMA)) { await this.provaCancella(); return PROVA_SCADUTA(); }
  // solo nelle prove in locale: guardare la prova e farla invecchiare (per provare la scadenza senza aspettare ore)
  if (LOCALE(this.env, request) && p === "/interno/prova-info") return J({ creato: c, visto: v, allarme: await st.getAlarm(), chiavi: (await st.list()).size });
  if (LOCALE(this.env, request) && p === "/interno/prova-invecchia" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    await st.put({ "prova:creato": c - (+b.creato || 0), "prova:visto": v - (+b.visto || 0) }); await this.alarm();
    return J({ ok: true, viva: !!(await st.get("prova:creato")), chiavi: (await st.list()).size, allarme: await st.getAlarm() });
  }
  if (now - v > 60000) { await st.put("prova:visto", now); await st.setAlarm(Math.min(c + PROVA_MAX, now + PROVA_FERMA)); }
  return null;
};

/* ---------- registro delle iscrizioni (un solo contenitore, "registro") ----------
   op:<spazio> → operatore · em:<email> → i suoi spazi · att:<email> → codice in attesa · elenco → tutti gli spazi */
Stato.prototype.registro = async function (request, url, p) {
  const st = this.ctx.storage, now = Date.now(), env = this.env, POST = request.method === "POST";
  const ip = reteDi(request.headers.get("x-q120-ip") || "") || "x";   // la rete di chi chiama (IPv6: il /64), messa dallo smistatore
  const corpo = async () => { try { return await request.json(); } catch (e) { return {}; } };
  const troppi = async (k, max, ms) => { const r = (await st.get(k)) || { n: 0, t: now }; if (now - r.t > ms) { r.n = 0; r.t = now; } r.n++; await st.put(k, r); return r.n > max; };
  const mail = b => String(b.email || "").trim().toLowerCase();
  const spazio = op => env.STATO.get(env.STATO.idFromName("op:" + op));
  // corso A1-A3: registrazione con email e codice (cc:<email> in attesa · ce:<email> iscritto · ct:<chiave> → email)
  // Admin del sito (quota120.com/admin): solo l'email in SITO_ADMIN · ac:<email> codice in attesa · at:<chiave> → entrato
  const tok = () => [...crypto.getRandomValues(new Uint8Array(20))].map(x => x.toString(16).padStart(2, "0")).join("");
  // le chiavi scadono anche sul server: 90 giorni per l'Admin del sito, 365 per il corso
  const chiaveOk = async (pre, t, giorni) => { if (!/^[a-f0-9]{40}$/.test(t || "")) return false; const x = await st.get(pre + t); if (!x) return false;
    if (now - (+x.dal || 0) > giorni * 864e5) { await st.delete(pre + t); return false; } return true; };
  const admOk = t => chiaveOk("at:", t, GIORNI_TOKEN_ADM);
  // codici sbagliati dell'Admin del sito: ogni codice vale 5 tentativi; per rete 20 all'ora; per email al massimo 10 in 15 minuti
  // (poi si aspetta al massimo 15 minuti: nessuno può tenere fuori il titolare per un giorno intero)
  const kErrAdm = email => "lim:avm:" + email, FINESTRA_ADM = 15 * 60000;
  const errAdm = async email => { const r = await st.get(kErrAdm(email)); return r && now - r.t < FINESTRA_ADM ? r : { n: 0, t: now }; };
  if (p === "/api/registro/adm-codice" && POST) {
    const b = await corpo(), email = mail(b), ammesso = String(env.SITO_ADMIN || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
    if (await troppi("lim:ac:" + ip, 10, 3600000)) return J({ errore: "Troppe richieste: riprova più tardi." }, 429);
    if (!ammesso.includes(email)) return J({ errore: "Questa sezione è riservata al titolare del sito." }, 403);
    if ((await errAdm(email)).n >= 10) return J({ errore: "Troppi codici sbagliati: riprova tra 15 minuti." }, 429);
    const prima = await st.get("ac:" + email);
    if (prima && now - (+prima.inviato || 0) < 60000) return J({ errore: "Ti ho appena mandato un codice: aspetta un minuto prima di chiederne un altro." }, 429);
    const codice = cod6(); await st.put("ac:" + email, { codice, scad: now + 15 * 60000, tent: 0, inviato: now });
    try { await mandaMail(env, email, "Codice Admin del sito Quota 120: " + codice, codiceHtml("", "", codice, false)); }
    catch (e) { await st.delete("ac:" + email); return J({ errore: "Non sono riuscito a mandare l'email: riprova tra poco." }, 502); }
    return J({ ok: true });
  }
  if (p === "/api/registro/adm-verifica" && POST) {
    if (await troppi("lim:av:" + ip, 20, 3600000)) return J({ errore: "Troppi tentativi: riprova più tardi." }, 429);
    const b = await corpo(), email = mail(b), c = String(b.codice || "").replace(/\D/g, ""), a = await st.get("ac:" + email);
    const ea = await errAdm(email);
    if (ea.n >= 10) { await st.delete("ac:" + email); return J({ errore: "Troppi codici sbagliati: riprova tra 15 minuti." }, 429); }
    if (!a || now > a.scad) return J({ errore: "Il codice è scaduto: chiedine un altro." }, 400);
    if (a.codice !== c) { a.tent++; ea.n++; await st.put(kErrAdm(email), ea); if (a.tent >= 5) await st.delete("ac:" + email); else await st.put("ac:" + email, a); return J({ errore: a.tent >= 5 ? "Il codice non è giusto ed è scaduto: chiedine un altro." : "Il codice non è giusto: controllalo nella mail." }, 400); }
    await st.delete("ac:" + email); await st.delete(kErrAdm(email)); const t = tok(); await st.put("at:" + t, { email, dal: now });
    return J({ ok: true, t });
  }
  if (p === "/api/registro/adm-ok") return J({ ok: await admOk(url.searchParams.get("t")) });
  if (p === "/api/registro/adm-esci" && POST) { const t = url.searchParams.get("t"); if (await admOk(t)) await st.delete("at:" + t); return J({ ok: true }); }
  if (p === "/api/registro/adm-iscritti") {
    if (!(await admOk(url.searchParams.get("t")))) return J({ errore: "Entra di nuovo" }, 401);
    const L = []; for (const [k, v] of await st.list({ prefix: "ce:" })) L.push({ email: k.slice(3), dal: v.dal, ultimo: v.ultimo, novita: !!v.novita });
    return J({ iscritti: L });
  }
  if (p === "/api/registro/corso-ok") return J({ ok: await chiaveOk("ct:", String(url.searchParams.get("t") || ""), GIORNI_TOKEN_CORSO) });
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
    // codici d'iscrizione: anche un tetto al giorno per tutti
    if (dati.tipo === "iscrizione") { const kg = "tetto:iscr:" + giornoUTC(), ng = (await st.get(kg)) || 0;
      if (ng >= LIM.iscrizioniTutti) return J({ errore: "Oggi ci sono già state tante iscrizioni: riprova domani." }, 429); await st.put(kg, ng + 1); }
    const codice = cod6();
    await st.put("att:" + email, Object.assign({ codice, scad: now + 15 * 60000, tent: 0, inviato: now }, dati));
    const op = dati.op ? (await st.get("op:" + dati.op)) || {} : {};
    try { await mandaMail(env, email, "Il tuo codice per Quota 120: " + codice, codiceHtml(dati.nome || op.adm || "", dati.nomeOp || op.nome || "", codice, dati.tipo === "iscrizione", dati.tipo === "iscrizione" ? !!dati.solo : !!op.solo)); }
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
    const b = await corpo(), email = mail(b), solo = b.tipo === "solo";
    // chi vola da solo: lo spazio porta il suo nome (operatore e pilota sono la stessa persona)
    const nome = TX(String(b.nome || "").replace(/\s+/g, " ").trim(), 80), nomeOp = solo ? nome : TX(String(b.op || "").replace(/\s+/g, " ").trim(), 80), df = TX(String(b.df || "").trim(), 40);
    if (!solo && nomeOp.length < 2) return J({ errore: "Scrivi il nome dell'operatore." }, 400);
    if (nome.length < 3) return J({ errore: "Scrivi il tuo nome e cognome." }, 400);
    if (solo && norm(nome) === "admin") return J({ errore: "Scrivi il tuo nome e cognome." }, 400);
    if (!EMAIL(email)) return J({ errore: "L'email non sembra giusta: controllala." }, 400);
    if (!b.ok) return J({ errore: "Per continuare spunta l'accettazione delle condizioni d'uso e della privacy." }, 400);
    if (((await st.get("em:" + email)) || []).length) return J({ errore: solo ? "Con questa email c'è già uno spazio: entra con la tua email, qui sotto." : "Con questa email c'è già uno spazio: torna indietro e tocca «Entra con la tua email»." }, 409);
    return manda(email, Object.assign({ tipo: "iscrizione", nomeOp, nome, df }, solo ? { solo: true } : {}));
  }
  // iscrizione: un codice nuovo con i dati già controllati (anche dall'anti-robot) la prima volta
  if (p === "/api/registro/rimanda" && POST) {
    if (await troppi("lim:rim:" + ip, 10, 3600000)) return J({ errore: "Troppe richieste: riprova tra un'ora" }, 429);
    const b = await corpo(), email = mail(b), a = EMAIL(email) ? await st.get("att:" + email) : null;
    if (!a || a.tipo !== "iscrizione") return J({ errore: "Il codice è scaduto: torna indietro e rifai l'iscrizione." }, 410);
    return manda(email, Object.assign({ tipo: "iscrizione", nomeOp: a.nomeOp, nome: a.nome, df: a.df }, a.solo ? { solo: true } : {}));
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
      if (((await st.get("em:" + email)) || []).length) return J({ errore: "Con questa email c'è già uno spazio: entra con la tua email." }, 409);
      let base = nomeSpazio(a.nomeOp), op = base, n = 1;
      while (RISERVATI.has(op) || !SLUG_OK(op) || (await st.get("op:" + op))) op = base.slice(0, 34) + "-" + (++n);
      const data = { OP: { nome: a.nomeOp, codice: a.df, resp: a.nome, dfReg: "", dfAbb: "", email, tel: "" } };
      // chi vola da solo: lo spazio nasce con lui come unico pilota, collegato all'Admin (OP.soloPid), con la stessa email (già confermata)
      if (a.solo) { const pid = Date.now() * 10 + Math.floor(Math.random() * 10);
        Object.assign(data.OP, { solo: true, soloPid: pid });
        data.PILOTI = [{ id: pid, nome: a.nome, matr: "", att: [], scad: "", ok: true, sts: false }];
        data.SCHEDEP = { [pid]: { ruolo: "Pilota", tel: "", email, ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} } };
        data.PERM = { [pid]: { admin: false, voliTutti: true, flotta: true, documenti: true, clienti: true, prezzi: false, enac: true, agri: false } }; }
      const r = await spazio(op).fetch("https://q/interno/crea", { method: "POST", headers: { "x-q120-op": op, "content-type": "application/json" }, body: JSON.stringify({ email, data }) });
      if (!r.ok) return J({ errore: "Non sono riuscito a creare lo spazio: riprova." }, 500);
      const dev = await r.json();
      await st.put("op:" + op, Object.assign({ nome: a.nomeOp, email, adm: a.nome, df: a.df, at: now }, a.solo ? { solo: true } : {}));
      await st.put("em:" + email, [op]);
      const L = (await st.get("elenco")) || []; L.push(op); await st.put("elenco", L);
      // avviso al titolare di Quota 120: un'azienda nuova ha creato il suo spazio
      const tit = String(this.env.SITO_ADMIN || "").split(",").map(x => x.trim()).filter(EMAIL)[0];
      if (tit) {
        const nomeO = SENZA_LINK(a.nomeOp, 80) || op, chi = SENZA_LINK(a.nome, 80);
        const html = "<p>" + (a.solo ? "Una persona che vola da sola ha creato il suo spazio in Quota 120." : "Un'azienda nuova ha creato il suo spazio in Quota 120.") + "</p><table cellpadding=\"4\">"
          + "<tr><td><b>Tipo</b></td><td>" + (a.solo ? "da solo" : "azienda") + "</td></tr>"
          + "<tr><td><b>Operatore</b></td><td>" + esc(nomeO) + "</td></tr>"
          + "<tr><td><b>Responsabile</b></td><td>" + esc(chi) + "</td></tr>"
          + "<tr><td><b>Email</b></td><td>" + esc(email) + "</td></tr>"
          + "<tr><td><b>Indirizzo dello spazio</b></td><td>app.quota120.com/" + esc(op) + "</td></tr>"
          + "<tr><td><b>Iscritte in tutto</b></td><td>" + L.length + "</td></tr></table>"
          + "<p><a href=\"https://quota120.com/admin/pannello/\">Apri il Pannello</a></p>";
        try { await mandaMail(this.env, tit, "Quota 120 · " + (a.solo ? "nuovo iscritto da solo: " : "nuova azienda iscritta: ") + nomeO, html); } catch (e) { console.error("avviso nuova azienda:", e && e.message || e); }
      }
      return J(Object.assign({ op, nuovo: true }, dev));
    }
    const r = await spazio(a.op).fetch("https://q/interno/nuovoadmin", { method: "POST", headers: { "x-q120-op": a.op, "content-type": "application/json" }, body: JSON.stringify({ email }) });
    if (!r.ok) return J({ errore: "Lo spazio non risponde: riprova." }, 500);
    return J(Object.assign({ op: a.op }, await r.json()));
  }
  return J({ errore: "Richiesta sconosciuta" }, 404);
};

// regole per il browser sulle pagine del programma: il programma usa script e gestori scritti nella pagina, quindi 'unsafe-inline' serve ancora;
// tutto il resto è chiuso (niente altri siti che caricano script, niente pagine dentro cornici, collegamenti solo a meteo, mappe e indirizzi)
const CSP_APP = ["default-src 'self'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com", "font-src 'self' data:",
  "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://nominatim.openstreetmap.org", "media-src 'self' blob:",
  "worker-src 'self' blob:", "frame-src 'self' blob: https://challenges.cloudflare.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'"].join("; ");
// sito quota120.com (pagine, Pannello del titolare, corso): niente script da altri siti tranne Turnstile; le pagine usano script e stili scritti dentro
const CSP_SITO = ["default-src 'self'", "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "media-src 'self' blob:", "frame-src https://challenges.cloudflare.com",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'"].join("; ");
// le richieste che cambiano qualcosa sul sito (Admin del sito, corso) devono arrivare dalle sue pagine: JSON e stessa origine
function stessoSito(request, env) {
  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return false;
  const sfs = request.headers.get("sec-fetch-site"), or = request.headers.get("origin"), locale = LOCALE(env, request);
  if (sfs) return sfs === "same-origin";
  if (or) return or === "https://quota120.com" || (locale && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(or));
  return locale;   // senza nessuna delle due intestazioni (prove a mano in locale)
}

export default {
  async scheduled(evento, env, ctx) {
    // la vecchia prova condivisa ("main", non si apre più ai visitatori): solo la pulizia dei file.
    // Le prove personali (demo:<id>) non passano di qui: si cancellano da sole con l'allarme del loro contenitore.
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
    // Posizionamento dei siti di Paolo: ogni ora si chiede al gestionale DPD di andare avanti con il giro della settimana
    // (lavora solo se il giro non è finito, se no risponde subito). Qui perché le azioni di GitHub del gestionale sono a pagamento.
    ctx.waitUntil((async () => {
      for (let i = 0; i < 8; i++) {
        const t = await fetch("https://gestionale.delpiccolodiavolo.it/api/public/pos-aggiorna", { method: "POST" }).then(r => r.text()).catch(() => "");
        if (!t || t.includes('"finito":true') || t.includes('"ok":false')) break;
      }
    })());
  },
  async fetch(request, env) {
    let r;
    try { r = await this.smista(request, env); }
    catch (e) { console.error("smista:", e && e.stack || e); return J({ errore: "Errore interno" }, 500); }
    // quota120.com: intestazioni di sicurezza su tutte le risposte del sito
    const h = (LOCALE(env, request) && request.headers.get("x-prova-host")) || new URL(request.url).hostname;
    if (r.status === 101) return r;
    if (h !== "quota120.com") {
      // il programma (app.quota120.com): niente pagine dentro altri siti, script solo da qui (più Turnstile), collegamenti solo ai servizi che usa
      const x = new Response(r.body, r);
      x.headers.set("X-Content-Type-Options", "nosniff");
      x.headers.set("X-Frame-Options", "DENY");
      x.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      if (/^text\/html/i.test(x.headers.get("content-type") || "")) x.headers.set("Content-Security-Policy", CSP_APP);
      return x;
    }
    const x = new Response(r.body, r);
    x.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    x.headers.set("X-Content-Type-Options", "nosniff");
    x.headers.set("X-Frame-Options", "DENY");
    x.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    x.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    // sito, Pannello del titolare e corso: script, stili e caratteri solo da qui (più Turnstile), niente pagine dentro altri siti
    if (/^text\/html/i.test(x.headers.get("content-type") || "")) x.headers.set("Content-Security-Policy", CSP_SITO);
    return x;
  },
  async smista(request, env) {
    const url = new URL(request.url), p = url.pathname;
    // quota120.com è il sito; il programma sta su app.quota120.com (e su quota120.staffordshire.workers.dev)
    const host = (LOCALE(env, request) && request.headers.get("x-prova-host")) || url.hostname;   // l'intestazione vale solo nelle prove in locale (localhost)
    const IPC = ipCliente(request, env);   // la rete del visitatore: va ai contenitori nell'intestazione interna x-q120-ip
    if (host === "www.quota120.com") return Response.redirect("https://quota120.com" + p + url.search, 301);
    const reg = () => env.STATO.get(env.STATO.idFromName("registro"));
    // video dei corsi: niente percorsi codificati (%) o con barre doppie, che potrebbero aggirare il controllo della firma qui sotto
    if (/^\/corso\/+video\//i.test(p) && (p.includes("%") || !p.startsWith("/corso/video/"))) return new Response("Indirizzo non valido", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (p.startsWith("/corso/video/az-") || (p.startsWith("/corso/video/") && url.searchParams.has("s"))) {
      const m = p.match(/^\/corso\/video\/([a-z0-9-]+)\.(mp4|jpg|vtt|m4a)$/), [e, g] = (url.searchParams.get("s") || "").split(".");
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
    // controllo delle impostazioni: da fuori solo «ok»; i dettagli (quali chiavi ci sono) e la prova dal vivo di DJI e Claude (?prova=1) solo per l'Admin del sito (cookie q120a)
    if (p === "/api/salute") {
      const c = n => !!(env[n] && String(env[n]).trim()), u = new URL(request.url), ta = biscotto("q120a");
      const tit = ta && await reg().fetch(new Request("https://quota120.interno/api/registro/adm-ok?t=" + ta)).then(x => x.json()).then(j => j.ok).catch(() => false);
      if (!tit) return u.searchParams.get("prova") === "1" ? J({ errore: "Solo per l'Admin del sito: entra da quota120.com/admin" }, 401) : J({ ok: true });
      if (u.searchParams.get("prova") !== "1") { u.searchParams.delete("prova"); u.searchParams.delete("finta"); }
      const r = await env.STATO.get(env.STATO.idFromName("main")).fetch(new Request(u.toString())).then(x => x.json()).catch(() => ({}));
      return J({ ok: true, ...r, worker: { RESEND_API_KEY: c("RESEND_API_KEY"), ANTHROPIC_API_KEY: c("ANTHROPIC_API_KEY"), DJI_API_KEY: c("DJI_API_KEY") } });
    }
    // prova.quota120.com: solo la versione di prova, una per visitatore (separata dall'app vera)
    if (host === HOST_PROVA) return this.prova(request, env, url, p);
    // Admin del sito: codice via email, poi la chiave nel cookie q120a
    if (host === "quota120.com" && p.startsWith("/api/admin/")) {
      const az = p.slice(11), ta = biscotto("q120a"), I = "https://quota120.interno/api/registro/adm-";
      // le richieste che cambiano qualcosa arrivano solo dalle pagine di quota120.com (niente moduli da altri siti, nemmeno da app.quota120.com)
      if (request.method !== "GET" && request.method !== "HEAD" && !stessoSito(request, env)) return J({ errore: "Richiesta non valida: ricarica la pagina e riprova." }, 403);
      if ((az === "codice" || az === "verifica") && request.method === "POST") {
        const corpo = await request.text();
        if (az === "codice" && !(await antiRobot(env, corpo, request))) return J({ errore: "Controllo anti-robot non superato: ricarica la pagina e riprova." }, 403);
        const r = await reg().fetch(new Request(I + az, { method: "POST", headers: { "content-type": "application/json", "x-q120-ip": IPC }, body: corpo }));
        const j = await r.json().catch(() => ({}));
        if (!j.t) return J(j, r.status);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": "q120a=" + j.t + "; Path=/; Max-Age=" + GIORNI_TOKEN_ADM * 86400 + "; Secure; HttpOnly; SameSite=Strict" } });
      }
      if (az === "iscritti") return reg().fetch(new Request(I + "iscritti?t=" + (ta || "")));
      if (!(ta && await reg().fetch(new Request(I + "ok?t=" + ta)).then(r => r.json()).then(j => j.ok).catch(() => false))) return J({ errore: "Entra di nuovo" }, 401);
      // Posizionamento (02/11/2026): archivio D1 POS, riempito dal gestionale DPD ogni lunedì; solo quota120.com
      if (az === "pos") {
        if (!env.POS) return J({ ok: false, manca: true });
        try { if (request.method === "POST") { const b = await request.json().catch(() => ({})); return J(await posParola(env.POS, "q", b.parola, !!b.togli)); }
          return J(await posLeggi(env.POS, "q")); } catch (e) { return J({ ok: false, error: e.message }, 400); }
      }
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
        return J({ operatori: ops.map(o => ({ op: o.op, nome: o.nome, email: o.email, adm: o.adm, at: o.at, piloti: o.piloti || 0, droni: o.droni || 0, voli: o.voli || 0, telefoni: o.telefoni || 0, ultimo: o.ultimo || 0, sospeso: !!o.sospeso, video: !!o.video })),
          problemi: prob.filter(x => !x.risolto).length, iscritti: isc, stato: { posta: c("RESEND_API_KEY") || c("BREVO_API_KEY"), mittente: env.MITTENTE || "", dji: c("DJI_API_KEY"), claude: c("ANTHROPIC_API_KEY"), robot: c("TURNSTILE_SECRET"), video: lez.filter(l => l.pronto).length, lezioni: lez.length }, corsi: corsi.map(x => ({ id: x.id, t: x.t, n: (x.lezioni || []).length })) });
      }
      if (az === "log" && request.method === "GET") return reg().fetch(new Request(N + "/interno/log"));
      if (az === "log-risolto" && request.method === "POST") return reg().fetch(new Request(N + "/interno/log/risolto", { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() }));
      if (az === "sospendi" && request.method === "POST") { const b = await request.json().catch(() => ({})); if (!SLUG_OK(b.op)) return J({ errore: "operatore" }, 400);
        return env.STATO.get(env.STATO.idFromName("op:" + b.op)).fetch(new Request(N + "/interno/sospendi", { method: "POST", headers: { "x-q120-op": b.op }, body: JSON.stringify({ on: !!b.on }) })); }
      if (az === "video" && request.method === "POST") { const b = await request.json().catch(() => ({})); if (!SLUG_OK(b.op)) return J({ errore: "operatore" }, 400);
        return reg().fetch(new Request(N + "/interno/op-video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: b.op, on: !!b.on }) })); }
      if (az === "esci" && request.method === "POST") { if (ta) await reg().fetch(new Request(I + "esci?t=" + ta, { method: "POST" })); return new Response('{"ok":true}', { headers: { "content-type": "application/json", "set-cookie": "q120a=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict" } }); }
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
      // corsi delle aziende: anche quelli salvati prima dei tetti restano dentro i limiti (corsi, lezioni, scene)
      const out = []; for (const c of tutti) for (const l of c.lezioni || []) if ((l.scene || []).length) out.push({ file: (c.tok ? "az-" + c.tok + "-" : "") + l.id + "-" + await vh(l.scene), titolo: l.t, scene: l.scene });
      // corsi delle aziende: i video si fanno solo per gli spazi approvati dal titolare (Pannello › Operatori › «Video del corso approvati»),
      // dentro i tetti (corsi, lezioni, scene, caratteri della voce per lezione e per azienda); gli altri arrivano segnati «non approvato» e si saltano
      for (const op of ops) { const info = await reg().fetch(new Request("https://quota120.interno/interno/op-info?op=" + op)).then(r => r.json()).catch(() => ({}));
        const az = await env.STATO.get(env.STATO.idFromName("op:" + op)).fetch(new Request("https://quota120.interno/interno/corsi-az", { headers: { "x-q120-op": op } })).then(r => r.json()).catch(() => []);
        if (!Array.isArray(az)) continue; let voce = 0;
        for (const c of az.slice(0, LIM.corsi)) for (const l of LISTA(c.lezioni).slice(0, LIM.lezioni)) { const sc = LISTA(l.scene).slice(0, LIM.scene); if (!sc.length || !c.tok) continue;
          const nv = sc.reduce((a, x) => a + String((x && (x.v || x.t)) || "").length, 0); voce += nv;
          const file = "az-" + c.tok + "-" + l.id + "-" + await vh(l.scene);
          if (!info.video) { out.push({ file, az: true, approvato: false, op }); continue; }
          if (nv > LIM.vocePerLezione || voce > LIM.vocePerSpazio) { out.push({ file, az: true, approvato: false, op, troppo: true }); continue; }
          out.push({ file, titolo: l.t, scene: sc, az: true, approvato: true, op }); } }
      return J(out);
    }
    if (host === "quota120.com" && (p === "/api/corso/codice" || p === "/api/corso/verifica") && request.method === "POST") {
      if (!stessoSito(request, env)) return J({ errore: "Richiesta non valida: ricarica la pagina e riprova." }, 403);
      const corpo = await request.text();
      if (p.endsWith("/codice") && !(await antiRobot(env, corpo, request))) return J({ errore: "Controllo anti-robot non superato: ricarica la pagina e riprova." }, 403);
      const r = await reg().fetch(new Request("https://quota120.interno/api/registro/corso-" + p.split("/").pop(), { method: "POST", headers: { "content-type": "application/json", "x-q120-ip": IPC }, body: corpo }));
      const j = await r.json().catch(() => ({}));
      if (!j.t) return J(j, r.status);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": "q120c=" + j.t + "; Path=/; Max-Age=" + GIORNI_TOKEN_CORSO * 86400 + "; Secure; HttpOnly; SameSite=Lax" } });
    }
    if (host === "quota120.com" || url.searchParams.get("sito") === "1" && LOCALE(env, request)) {
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
    const pulita = (op) => { const r = new Request(request); for (const k of ["x-q120-op", "x-q120-prova", "x-q120-prova-nuova", "x-q120-ip"]) r.headers.delete(k); if (op) r.headers.set("x-q120-op", op); if (IPC) r.headers.set("x-q120-ip", IPC); return r; };
    // registro: da fuori solo quello che chiamano le pagine dell'app (iscrizione e entrata dell'Admin dello spazio);
    // codici del corso e dell'Admin del sito passano solo da /api/corso/* e /api/admin/* (con il controllo anti-robot)
    if (p.startsWith("/api/registro/")) {
      if (!["/api/registro/info", "/api/registro/iscrivi", "/api/registro/rimanda", "/api/registro/codice", "/api/registro/verifica"].includes(p)) return J({ errore: "Non trovato" }, 404);
      // iscrizione: anche qui il controllo anti-robot, come sul sito (se Turnstile è configurato)
      if (p === "/api/registro/iscrivi" && request.method === "POST") {
        const corpo = await request.text(); if (corpo.length > 4000) return J({ errore: "Dati non validi" }, 400);
        // si accende con la variabile TS_ISCRIZIONE=1, dopo aver aggiunto app.quota120.com ai nomi del widget Turnstile (se no le iscrizioni si fermerebbero)
        if (env.TS_ISCRIZIONE === "1" && !(await antiRobot(env, corpo, request))) return J({ errore: "Controllo anti-robot non superato: aspetta che compaia la spunta e riprova.", robot: true }, 403);
        return reg().fetch(new Request("https://quota120.interno/api/registro/iscrivi", { method: "POST", headers: { "content-type": "application/json", "x-q120-ip": IPC }, body: corpo }));
      }
      return reg().fetch(pulita());
    }
    if (p === "/api/corsi" && request.method === "GET") {
      const op = String(request.headers.get("x-op") || url.searchParams.get("op") || "").toLowerCase();
      // la vecchia prova condivisa ("main") non si apre più: la prova sta su prova.quota120.com
      if (!SLUG_OK(op)) return J({ errore: !op || op === "prova" ? PROVA_ALTROVE : "operatore" }, !op || op === "prova" ? 410 : 404);
      return this.corsi(env, url, env.STATO.get(env.STATO.idFromName("op:" + op)).fetch(pulita(op)));
    }
    if (p === "/api/log" && request.method === "POST") {
      // chi è entrato nel programma (x-disp valido nel suo spazio) ha la sua riserva: lo spazio lo dice il server, non la pagina
      const op = String(request.headers.get("x-op") || "").toLowerCase(), xd = request.headers.get("x-disp") || "";
      const aut = SLUG_OK(op) && /^[a-f0-9]{16}:[a-f0-9]{36}$/.test(xd) ? await env.STATO.get(env.STATO.idFromName("op:" + op)).fetch(new Request("https://quota120.interno/interno/chi-disp", { headers: { "x-q120-op": op, "x-disp": xd } })).then(r => r.json()).catch(() => null) : null;
      return this.log(request, env, op, aut && aut.ok ? aut : null);
    }
    if (p.startsWith("/api/")) {
      const op = String(request.headers.get("x-op") || url.searchParams.get("op") || "").toLowerCase();
      if (!op || op === "prova") return J({ errore: PROVA_ALTROVE }, 410);
      if (!SLUG_OK(op)) return J({ errore: "operatore" }, 404);
      return env.STATO.get(env.STATO.idFromName("op:" + op)).fetch(pulita(op));
    }
    if (p.startsWith("/interno/") && LOCALE(env, request)) {   // solo per le prove in locale (POSTA_FINTA=1 e localhost)
      const q = url.searchParams.get("do") || "", stub = q === "registro" ? env.STATO.get(env.STATO.idFromName("registro")) : SLUG_OK(q) ? env.STATO.get(env.STATO.idFromName("op:" + q)) : main();
      return stub.fetch(pulita(SLUG_OK(q) ? q : ""));
    }
    // etichette QR di droni e batterie: /q/<spazio>/d<id> (drone) o /q/<spazio>/b<id> (batteria) aprono il programma dello spazio sulla scheda dell'etichetta
    // (le etichette della prova portano alla prova, su prova.quota120.com)
    { const mq = p.match(/^\/q\/([A-Za-z0-9-]{3,40})\/([db][A-Za-z0-9_%.-]{1,80})\/?$/), sq = mq && mq[1].toLowerCase();
      if (mq && (sq === "prova" || SLUG_OK(sq))) { let c = mq[2]; try { c = decodeURIComponent(c); } catch (e) {}
        return new Response(null, { status: 302, headers: { location: (sq === "prova" ? "https://" + HOST_PROVA + "/" : "/" + sq) + "?q=" + encodeURIComponent(c), "cache-control": "no-store" } }); } }
    // /<spazio> apre il programma; / è l'ingresso; i vecchi indirizzi della prova (/prova) portano alla prova nuova
    const seg = p.replace(/^\/+|\/+$/g, "");
    // link di invito dei piloti: /<spazio>/invito/<chiave> apre il programma (la pagina chiede al server se la chiave vale)
    { const mi = p.match(/^\/([a-z0-9-]{3,40})\/invito\/([a-f0-9]{32})\/?$/); if (mi && SLUG_OK(mi[1])) { const ra = await env.ASSETS.fetch(new Request(new URL("/", url), request)); const r2 = new Response(ra.body, ra); r2.headers.set("Referrer-Policy", "no-referrer"); r2.headers.set("x-robots-tag", "noindex"); return r2; } }
    if (seg.toLowerCase() === "prova") return new Response(null, { status: 302, headers: { location: "https://" + HOST_PROVA + "/" + url.search, "cache-control": "no-store" } });
    if (seg && seg !== "corso" && !seg.includes("/") && !seg.includes(".") && SLUG_OK(seg.toLowerCase())) return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return env.ASSETS.fetch(request);
  },
  // corsi: quelli dell'azienda (o della prova) con i video firmati, più quelli di Quota 120
  async corsi(env, url, risposta) {
    const r = await risposta; if (!r.ok) return r;
    const j = await r.json();
    const tutti = await env.STATO.get(env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/corsi")).then(x => x.json()).catch(() => []);
    j.az = await corsiConVideo(env, url, j.az || [], !!j.adm);
    j.q120 = await corsiConVideo(env, url, tutti, false);
    return J(j);
  },
  // «Qualcosa non funziona?» e gli errori dell'app: nel registro; i messaggi anche per email all'assistenza (solo all'assistenza, mai ad altri indirizzi)
  // aut: telefono riconosciuto ({ op, opn, n, ruolo, disp }) oppure null (anonimo: lo spazio scritto dalla pagina resta «non verificato»)
  async log(request, env, op, aut) {
    const t = await request.text(); if (t.length > 16000) return J({ errore: "Troppo lungo" }, 413);
    let b; try { b = JSON.parse(t); } catch (e) { return J({ errore: "dati" }, 400); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return J({ errore: "dati" }, 400);
    const opOk = SLUG_OK(op) ? op : "prova";
    const j = await env.STATO.get(env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/log", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ b, op: opOk, aut: aut || null, ip: ipCliente(request, env), ua: request.headers.get("user-agent") || "" }) })).then(r => r.json()).catch(() => ({}));
    if (j.ok && b.tipo === "mess" && j.id && j.mail) {
      const E = x => String(x == null ? "" : x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const chi = aut ? aut.n : SENZA_LINK(b.chi || "Qualcuno", 80) + " (non verificato)", dove = aut ? (aut.ruolo === "adm" ? "Admin" : "Pilota") + ", " + aut.opn : E(b.ruolo) + ", spazio dichiarato " + opOk + ", non verificato";
      const html = "<p><b>" + E(chi) + "</b> (" + E(dove) + ") ha scritto:</p><blockquote>" + E(b.testo).replace(/\n/g, "<br>") + "</blockquote>"
        + "<p>Pagina: " + E(b.vista) + " · rete: " + E(b.rete) + (aut && EMAIL(b.email) ? " · email: " + E(b.email) : "") + "</p><p>Le ultime cose fatte:</p><pre>" + E((Array.isArray(b.passi) ? b.passi : []).join("\n")) + "</pre><p>Lo trovi anche nel Pannello › Problemi dell'app.</p>";
      // «rispondi a» solo per chi è entrato nel programma (telefono riconosciuto)
      await mandaMail(env, "assistenza@quota120.com", "Quota 120 · problema segnalato da " + SENZA_LINK(aut ? aut.n + " · " + aut.opn : "non verificato", 80), html, null, aut && EMAIL(b.email) ? String(b.email).trim().slice(0, 120) : undefined).catch(e => console.error("mail problema:", e && e.message || e));
    }
    return J({ ok: !!j.ok });
  },
  /* ---------- prova.quota120.com: solo la versione di prova, una per visitatore ----------
     il visitatore ha il suo contenitore "demo:<id>" (id casuale di 128 bit nel cookie q120p, HttpOnly, solo per questo indirizzo);
     la prova nasce quando il visitatore entra (Admin con 1234, o pilota) e si cancella da sola (vedi Stato.alarm) */
  async prova(request, env, url, p) {
    const locale = LOCALE(env, request), IPC = ipCliente(request, env);
    const pulita = () => { const r = new Request(request); for (const k of ["x-q120-op", "x-q120-prova", "x-q120-prova-nuova", "x-q120-ip"]) r.headers.delete(k); if (IPC) r.headers.set("x-q120-ip", IPC); return r; };
    if (p === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (p === "/corso" || p.startsWith("/corso/")) return Response.redirect("https://quota120.com" + p, 302);   // il corso si apre solo su quota120.com
    if (p.startsWith("/api/registro/") || p.startsWith("/api/admin/") || p.startsWith("/api/corso/")) return J({ errore: "Nella versione di prova questa funzione non c'è: crea il tuo spazio gratis su app.quota120.com" }, 404);
    const cookie = n => ((request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + n + "=([a-f0-9]{32})(?:;|$)")) || [])[1] || "";
    if (p === "/api/log" && request.method === "POST") {
      // telefono riconosciuto nella sua prova personale (cookie q120p + x-disp): ha la sua riserva nel registro dei problemi
      const idp = cookie("q120p"), xd = request.headers.get("x-disp") || "";
      const aut = idp && /^[a-f0-9]{16}:[a-f0-9]{36}$/.test(xd) ? await env.STATO.get(env.STATO.idFromName("demo:" + idp)).fetch(new Request("https://quota120.interno/interno/chi-disp", { headers: { "x-q120-prova": "1", "x-disp": xd } })).then(r => r.json()).catch(() => null) : null;
      return this.log(request, env, "prova", aut && aut.ok ? Object.assign(aut, { op: "prova" }) : null);
    }
    const BISCOTTO = id => "q120p=" + id + "; Path=/; Max-Age=" + PROVA_MAX / 1000 + "; Secure; HttpOnly; SameSite=Lax";
    const VIA = "q120p=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";
    const conBiscotto = (r, v, idProva) => { const x = new Response(r.body, r); if (v) x.headers.append("set-cookie", v); if (idProva) x.headers.set("x-q120-prova-id", idProva); return x; };
    if (p.startsWith("/api/")) {
      const stub = id => env.STATO.get(env.STATO.idFromName("demo:" + id));
      // calendario e invio dei voli arrivano da altre app (senza cookie): la prova è nell'indirizzo (?p=)
      const fuori = p === "/api/cal.ics" || p === "/api/invio";
      let id = cookie("q120p"); const dalBiscotto = !!id;
      if (!id && fuori && ID_PROVA(url.searchParams.get("p"))) id = url.searchParams.get("p");
      if (!id && p === "/api/q/nome") return J({ nome: "" });   // etichetta inquadrata da chi non ha una prova aperta
      const crea = p === "/api/disp/richiesta" && request.method === "POST";
      const corpo = crea ? await request.text() : null;
      if (corpo && corpo.length > 3000000) return J({ errore: "Dati non validi" }, 400);
      const manda = (id, nuova) => { const r = crea ? new Request(url.toString(), { method: "POST", headers: request.headers, body: corpo }) : pulita();
        const q = new Request(r); q.headers.delete("x-q120-op"); q.headers.delete("x-q120-ip"); if (IPC) q.headers.set("x-q120-ip", IPC); q.headers.set("x-q120-prova", "1"); if (nuova) q.headers.set("x-q120-prova-nuova", "1"); else q.headers.delete("x-q120-prova-nuova");
        return p === "/api/corsi" && request.method === "GET" ? this.corsi(env, url, stub(id).fetch(q)) : stub(id).fetch(q); };
      if (id) {
        const r = await manda(id, false);
        if (r.headers.get("x-q120-prova-scaduta") !== "1") return conBiscotto(r, "", p === "/api/stato" ? id : "");
        if (!crea) return conBiscotto(r, dalBiscotto ? VIA : "");   // la prova di prima è scaduta: la pagina ne apre una nuova
      } else if (!crea) return request.headers.get("x-disp") ? PROVA_SCADUTA() : J({ errore: "dispositivo" }, 401);   // telefono di una prova che non c'è più
      // una prova nuova: al massimo LIM.provaNuoveIp al giorno da ogni rete
      const ip = IPC || (locale ? "" : "x");   // rete del visitatore (IPv6: il /64)
      const ok = await env.STATO.get(env.STATO.idFromName("registro")).fetch(new Request("https://quota120.interno/interno/prova-nuova", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ip }) })).then(r => r.json()).catch(() => ({ ok: false }));
      if (!ok.ok) return J({ errore: ok.rete ? "Oggi da questa rete sono già state aperte " + LIM.provaNuoveIp + " versioni di prova: riprova domani, oppure crea il tuo spazio gratis su app.quota120.com." : "Oggi sono state aperte troppe versioni di prova: riprova domani, oppure crea il tuo spazio gratis su app.quota120.com." }, 429);
      const nuovo = rnd(16);
      return conBiscotto(await manda(nuovo, true), BISCOTTO(nuovo));
    }
    if (p.startsWith("/interno/") && locale) {   // solo per le prove in locale: ?prova=<id> apre il contenitore di quella prova
      const q = url.searchParams.get("prova") || "", r = pulita(); r.headers.set("x-q120-prova", "1");
      return ID_PROVA(q) ? env.STATO.get(env.STATO.idFromName("demo:" + q)).fetch(r) : J({ errore: "prova?" }, 400);
    }
    // etichette QR della prova: aprono la prova sulla scheda dell'etichetta
    { const mq = p.match(/^\/q\/[A-Za-z0-9-]{3,40}\/([db][A-Za-z0-9_%.-]{1,80})\/?$/);
      if (mq) { let c = mq[1]; try { c = decodeURIComponent(c); } catch (e) {} return new Response(null, { status: 302, headers: { location: "/?q=" + encodeURIComponent(c), "cache-control": "no-store" } }); } }
    const seg = p.replace(/^\/+|\/+$/g, "");
    if (seg.toLowerCase() === "prova") return new Response(null, { status: 302, headers: { location: "/" + url.search, "cache-control": "no-store" } });
    // gli spazi veri stanno su app.quota120.com
    if (seg && !seg.includes("/") && !seg.includes(".") && SLUG_OK(seg.toLowerCase())) return new Response(null, { status: 302, headers: { location: "https://app.quota120.com/" + seg.toLowerCase() + url.search, "cache-control": "no-store" } });
    if (seg === "" || seg === "index.html") {
      // la pagina sa di essere la prova da questo segno (anche nelle prove in locale, dove l'indirizzo è localhost)
      const ra = await env.ASSETS.fetch(new Request(new URL("/", url), request));
      if (!/^text\/html/i.test(ra.headers.get("content-type") || "")) return ra;
      const t = (await ra.text()).replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="q120-prova" content="1">');
      const h = new Headers(ra.headers); h.delete("content-length"); h.delete("etag");
      return new Response(t, { status: ra.status, headers: h });
    }
    return env.ASSETS.fetch(request);
  }
};
