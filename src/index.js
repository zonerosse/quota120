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
  const b = (d.BATT || []).find(x => x.id === v.batt);
  if (b) { b.cicli = (+b.cicli || 0) + 1; b.ultimo = v.data; if (v.bsn && !b.sn) b.sn = v.bsn;
    if (Array.isArray(v.celle) && v.celle.length) b.celle = v.celle.slice(0, 14);
    if (v.dev > 0.1) b.stato = "warn"; }
  const p = (d.PILOTI || []).find(x => x.nome === v.pilota);
  if (p) { const sp = (d.SCHEDEP = d.SCHEDEP || {})[p.id] = (d.SCHEDEP || {})[p.id] || { ruolo: "Pilota", ore: "0 h", voli: 0, ore90: "0 h", inc: 0, att: {} };
    sp.ore = hDi(minDi(sp.ore) + min); sp.voli = (+sp.voli || 0) + 1; sp.ore90 = hDi(minDi(sp.ore90) + min); }
  return d;
}
// i campi di un volo letto dal registro, ripuliti
function pulisciLetto(v) {
  return { letto: !!v.letto, quotaMax: NUM(v.quotaMax, 0, 9999), oltre120: NUM(v.oltre120, 0, 99999), km: NUM(v.km, 0, 9999), velMax: NUM(v.velMax, 0, 999),
    foto: NUM(v.foto, 0, 99999), videoS: NUM(v.videoS, 0, 999999), cIni: NUM(v.cIni, 0, 100), cFin: NUM(v.cFin, 0, 100), tMax: NUM(v.tMax, -50, 150),
    dev: NUM(v.dev, 0, 5), celle: Array.isArray(v.celle) ? v.celle.slice(0, 14).map(x => NUM(x, 0, 10)) : [], batt: esc(v.batt, 40), bsn: esc(v.bsn, 60),
    sn: esc(v.sn, 60), logKey: esc(v.logKey, 120), fine: esc(v.fine, 5), sec: NUM(v.sec, 0, 86400),
    prof: Array.isArray(v.prof) ? v.prof.slice(0, 160).map(x => Math.round(NUM(x, -999, 9999))) : [] };
}

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
  v.OP = d.OP; v.MATR = d.MATR;
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
  if (P.clienti) { v.CLIENTI = d.CLIENTI; v.LAVORI = (d.LAVORI || []).map(l => P.prezzi ? l : Object.assign({}, l, { importo: null })); }
  if (P.prezzi) v.PREV = d.PREV;
  if (P.enac) { v.AUT_ENAC = d.AUT_ENAC; v.DOMANDA = d.DOMANDA; v.ASSIC = d.ASSIC; }
  if (P.agri) { v.CAMPI = d.CAMPI; v.TRATT = d.TRATT; if (!v.CLIENTI) v.CLIENTI = d.CLIENTI; }
  v.DOCS = (d.DOCS || []).filter(x => docVisibile(d, x, n));
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
      cat: esc(v.cat, 60), inc: esc(v.inc, 60), docLog: (o && o.docLog) || esc(v.docLog, 40), logNome: esc(v.logNome, 120) };
    // i dati letti dal registro li scrive solo il server (/api/volo/importa): il telefono non li può cambiare
    if (o && o.letto) Object.assign(pulito, pulisciLetto(o), { drone: o.drone, data: o.data, ora: o.ora, min: o.min, pilota: o.pilota });
    if (o) Object.assign(o, pulito); else { d.VOLI = d.VOLI || []; d.VOLI.unshift(pulito); }
  }
  const zk = z => z.data + "|" + z.ora + "|" + z.drone + "|" + z.pilota, zs = new Set((d.ZONE || []).map(zk));
  for (const z of (m.ZONE || []).slice(0, 50)) {
    if (!z || z.pilota !== n) continue;
    const pz = { data: DATA(z.data) || oggi(), ora: esc(z.ora, 5), drone: esc(z.drone, 80), pilota: n };
    if (!zs.has(zk(pz))) { d.ZONE = d.ZONE || []; d.ZONE.unshift(pz); zs.add(zk(pz)); }
  }
  d.ZONE = (d.ZONE || []).slice(0, 2000);
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
    '"dest":{"k":"pilota|drone|operatore|altro","id":numero o null,"voce":"A1-A3|A2|STS-01|patentino|qr|classe|manuale|fattura|manutenzione|assicurazione|autorizzazione|dflight|altro"},' +
    '"dati":{"numero":"","rilascio":"","scadenza":""}}';
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
const b64 = buf => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

export class Stato extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url), st = this.ctx.storage, p = url.pathname;
    const disp = (await st.get("disp")) || {};
    const pin = (await st.get("pin")) || "1234";
    const now = Date.now();
    const blocchi = (await st.get("blocchi")) || {};          // id pilota -> true
    const aspetti = (await st.get("aspetti")) || {};          // nome -> A | B | C
    const pub = () => Object.keys(disp).map(id => { const x = disp[id]; return { id, ruolo: x.ruolo, n: x.n, codice: x.codice, stato: x.stato, at: x.at, visto: x.visto, nuovo: !!x.nuovo, pid: x.pid }; });
    const leggiMain = async () => { const row = await st.get("main"); return row ? { row, d: JSON.parse(row.json) } : null; };
    const scriviMain = async (d, ver) => { await st.put("main", { json: JSON.stringify(d), ver }); };

    // ---- entrata: Admin con codice, Pilota con nome e cognome + matricola ----
    if (p === "/api/disp/richiesta" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const ruolo = b.ruolo === "adm" ? "adm" : "op";
      let n = "", pid = null, nuovo = false;
      if (ruolo === "adm") {
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
      disp[id] = { k, ruolo, n: ruolo === "adm" ? "Admin" : n, pid, nuovo, codice: cod4(), stato: ruolo === "adm" ? "ok" : "attesa", at: now, visto: now, app: ruolo === "adm" };
      await st.put("disp", disp);
      return J({ id, k, n: disp[id].n, stato: disp[id].stato, codice: disp[id].codice, asp: aspetti[disp[id].n] || ASP_BASE });
    }

    // ---- da qui serve un dispositivo riconosciuto ----
    let id = url.searchParams.get("id") || "", k = url.searchParams.get("k") || "";
    const h = request.headers.get("x-disp") || ""; if (h.includes(":")) [id, k] = h.split(":");
    const me = disp[id];
    if (!me || me.k !== k) return J({ errore: "dispositivo" }, 401);
    if (now - (me.visto || 0) > 60000) { me.visto = now; await st.put("disp", disp); }
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
    if (p === "/api/volo/importa" && request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
      const m = await leggiMain(); if (!m) return J({ errore: "Nessun dato" }, 409);
      const d = m.d, v0 = b.volo || {};
      const pilota = adm ? String(v0.pilota || "") : me.n;
      if (!(d.PILOTI || []).some(x => x.nome === pilota)) return J({ errore: "Scegli il pilota" }, 400);
      if (!(d.DRONI || []).some(x => x.nome === v0.drone)) return J({ errore: "Scegli il drone" }, 400);
      const L = pulisciLetto(Object.assign({}, v0, { letto: true }));
      if (L.batt && !(d.BATT || []).some(x => x.id === L.batt)) L.batt = "";
      if (L.logKey && (d.VOLI || []).some(x => x.logKey === L.logKey)) return J({ errore: "doppio" }, 409);
      if (b.docLog) { const info = await st.get("docinfo:" + b.docLog); if (!info || (!adm && info.da !== me.n)) b.docLog = ""; }
      const v = Object.assign({ id: Date.now() * 10 + Math.floor(Math.random() * 10), data: DATA(v0.data) || oggi(), ora: /^\d{2}:\d{2}$/.test(v0.ora || "") ? v0.ora : "00:00",
        drone: v0.drone, pilota, luogo: esc(v0.luogo, 120), min: NUM(v0.min, 0, 600), stato: "completo", ctrl: !!v0.ctrl, ctrlOra: esc(v0.ctrlOra, 5),
        cliente: esc(v0.cliente, 200), note: esc(v0.note, 2000), importato: true, amano: false, cat: esc(v0.cat, 60), inc: "Nessuno",
        docLog: esc(b.docLog, 40), logNome: esc(v0.logNome, 120) }, L);
      d.VOLI = d.VOLI || []; d.VOLI.unshift(v);
      applicaVolo(d, v);
      await scriviMain(d, m.row.ver + 1);
      return J({ ok: true, id: v.id, ver: m.row.ver + 1 });
    }

    // ---- dati ----
    if (p === "/api/stato") {
      const m = await leggiMain();
      if (!m) return J({ vuoto: true });
      const { row } = m, io = { r: me.ruolo, n: me.n, id, asp: aspetti[me.n] || ASP_BASE }, extra = adm ? { disp: pub(), blocchi } : {};
      if (request.method === "GET") {
        if (+url.searchParams.get("since") === row.ver && !url.searchParams.get("all")) return J(Object.assign({ same: true, ver: row.ver }, extra));
        return J(Object.assign({ ver: row.ver, data: adm ? m.d : vista(m.d, me.n), io }, extra));
      }
      if (request.method === "PUT") {
        const txt = await request.text();
        if (txt.length > 1800000) return J({ errore: "Troppi dati" }, 413);
        let b; try { b = JSON.parse(txt); } catch (e) { return J({ errore: "Dati non validi" }, 400); }
        if (b.ver !== row.ver) return J({ ver: row.ver, data: adm ? m.d : vista(m.d, me.n) }, 409);
        const nd = adm ? Object.assign({}, b.data || {}, { DOCS: m.d.DOCS || [] }) : unisci(m.d, b.data || {}, me.n);
        await scriviMain(nd, row.ver + 1);
        return J({ ver: row.ver + 1 });
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
      if (!adm) { const m = await leggiMain(), doc = m && (m.d.DOCS || []).find(x => x.id === did); if (!(info.da === me.n || (doc && docVisibile(m.d, doc, me.n)))) return J({ errore: "Non puoi vederlo" }, 403); }
      const parti = []; for (let i = 0; i < info.pezzi; i++) parti.push(await st.get("doc:" + did + ":" + i));
      return new Response(new Blob(parti, { type: info.mime }), { headers: { "content-type": info.mime, "cache-control": "private, no-store",
        "content-disposition": "inline; filename=\"" + info.nome.replace(/[^\w.\- ]/g, "_") + "\"" } });
    }
    return J({ errore: "Non trovato" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return env.STATO.get(env.STATO.idFromName("main")).fetch(request);
    return env.ASSETS.fetch(request);
  }
};
