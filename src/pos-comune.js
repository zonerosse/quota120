/* Posizionamento: lettura e parole per il pannello (02/11/2026). COPIA della parte comune di
   gestionale-allevamento/functions/_pos.js (lì c'è anche il giro del lunedì che riempie l'archivio): se cambia lì, cambia qui.
   Archivio D1 «posizionamento», collegato a questo progetto con il nome POS. */
export const SITI = {
  vm: { nome: "Verba Manent e Scripta Manent", dom: "verbamanent.app" },
  q: { nome: "Quota 120", dom: "quota120.com" },
  km: { nome: "Kennel Manager", dom: "kennelmanager.app", chiuso: true },
  pwf: { nome: "Punto Web Ferrara", dom: "puntowebferrara.com" },
  dpd: { nome: "Del Piccolo Diavolo", dom: "delpiccolodiavolo.it" },
};
const T = [
  "CREATE TABLE IF NOT EXISTS pos_parole (sito TEXT, parola TEXT, vol INTEGER, aggiunta TEXT, PRIMARY KEY (sito, parola))",
  "CREATE TABLE IF NOT EXISTS pos_misure (sito TEXT, parola TEXT, sett TEXT, pos INTEGER, url TEXT, PRIMARY KEY (sito, parola, sett))",
  "CREATE TABLE IF NOT EXISTS pos_gsc (sito TEXT, sett TEXT, json TEXT, PRIMARY KEY (sito, sett))",
  "CREATE TABLE IF NOT EXISTS pos_giri (sett TEXT PRIMARY KEY, at TEXT, costo REAL, controlli INTEGER, err TEXT, fine INTEGER)",
];
export async function posTabelle(db) { for (const q of T) await db.prepare(q).run(); }
// lunedì della settimana (ora italiana circa: si guarda il giorno UTC)
export function lunedi(d = new Date()) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); }
const pulisci = p => String(p || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);

/* ---------- lettura per i pannelli ---------- */
export async function leggi(db, sito) {
  const S = SITI[sito]; if (!S) throw new Error("sito sconosciuto");
  await posTabelle(db);
  const par = (await db.prepare("SELECT parola, vol, aggiunta FROM pos_parole WHERE sito=? ORDER BY aggiunta, parola").bind(sito).all()).results || [];
  const mis = (await db.prepare("SELECT parola, sett, pos, url FROM pos_misure WHERE sito=? AND sett >= ? ORDER BY sett").bind(sito, settPrima(9)).all()).results || [];
  const sett = [...new Set(mis.map(m => m.sett))].slice(-8);
  const parole = par.map(p => {
    const st = sett.map(s => { const m = mis.find(x => x.parola === p.parola && x.sett === s); return m ? m.pos : null; });
    const ult = [...mis].reverse().find(x => x.parola === p.parola);
    return { parola: p.parola, vol: p.vol, storia: st, url: ult && ult.url || "", nuova: !ult };
  });
  const g = await db.prepare("SELECT sett, json FROM pos_gsc WHERE sito=? ORDER BY sett DESC LIMIT 1").bind(sito).first();
  const mese = new Date().toISOString().slice(0, 7);
  const giri = (await db.prepare("SELECT sett, at, costo, controlli, err, fine FROM pos_giri ORDER BY sett DESC LIMIT 6").all()).results || [];
  const costoMese = giri.filter(x => (x.at || "").startsWith(mese)).reduce((a, x) => a + (x.costo || 0), 0);
  return { ok: true, sito, nome: S.nome, dom: S.dom, chiuso: !!S.chiuso, settimane: sett, parole,
    gsc: g ? JSON.parse(g.json) : null, ultimo: giri[0] ? { at: giri[0].at, fine: !!giri[0].fine, err: erroriDi(giri[0].err, S.dom, par.map(p => p.parola)) } : null, costoMese: Math.round(costoMese * 100) / 100 };
}
// solo gli errori di questo sito: le sue parole, il suo dominio, e quelli che valgono per tutti (credito, tetto, Google);
// una parola saltata si dice in parole semplici
function erroriDi(js, dom, parole) {
  let L = []; try { L = JSON.parse(js || "[]"); } catch (e) {}
  return L.filter(x => { const m = /^«(.+?)»: /.exec(x); if (m) return parole.includes(m[1]);
      const d = /^([a-z0-9.-]+\.[a-z]{2,}): /.exec(x); if (d) return d[1] === dom; return true; })
    .map(x => x.replace(/^«(.+?)»: .*\(saltata\)$/, "«$1»: Google non ha risposto in tempo, si riprova lunedì prossimo"));
}
function settPrima(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n * 7); return lunedi(d); }
export async function parola(db, sito, testo, togli) {
  if (!SITI[sito]) throw new Error("sito sconosciuto");
  const p = pulisci(testo); if (p.length < 2) throw new Error("parola vuota");
  await posTabelle(db);
  if (togli) { await db.prepare("DELETE FROM pos_parole WHERE sito=? AND parola=?").bind(sito, p).run(); return { ok: true }; }
  const n = await db.prepare("SELECT COUNT(*) n FROM pos_parole WHERE sito=?").bind(sito).first();
  if ((n && n.n) >= 30) throw new Error("Al massimo 30 parole per sito: togline una prima.");
  await db.prepare("INSERT OR IGNORE INTO pos_parole (sito, parola, vol, aggiunta) VALUES (?,?,NULL,?)").bind(sito, p, new Date().toISOString()).run();
  return { ok: true };
}
