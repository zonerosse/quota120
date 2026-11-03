/* Posizionamento: la scheda dei pannelli (02/11/2026, anteprime 35-36 approvate). FILE UGUALE in tutti i siti
   (gestionale public/pos-ui.js, verbamanent-sito static/pos-ui.js, kennel-manager public/pos-ui.js, quota120 public/pos-ui.js,
   puntowebferrara static/pos-ui.js): se cambia, copiarlo in tutti.
   PosUI.scheda(el, url)  → disegna la scheda completa in el, dati da GET url (la API del pannello, che risponde come leggi())
   PosUI.riquadro(el, url, apri) → riquadro per la prima pagina del pannello; apri() = va alla scheda
   La API riceve POST {parola, togli} per aggiungere o togliere una parola, {aggiorna:1, forza} per rifare il giro (solo gestionale). */
(function () {
  const CSS = `.pz{--pzP:#0d4275;--pzA:#0369a1;--pzD:#111827;--pzM:#64748b;--pzL:#e5e7eb;--pzSu:#15803d;--pzGiu:#b91c1c;color:#334155;font:15px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}
.pz *{box-sizing:border-box}.pz h1{font-size:21px;color:var(--pzD);margin:0 0 2px}.pz .pz-s{color:var(--pzM);margin:0 0 14px;font-size:13.5px}
.pz-b{background:#fff;border:1px solid var(--pzL);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.pz-b h2{margin:0 0 2px;font-size:16px;color:var(--pzD);display:flex;align-items:center;gap:8px}.pz-b .pz-da{color:var(--pzM);font-size:12.5px;margin:0 0 10px}
.pz-ic{width:26px;height:26px;border-radius:7px;background:#0d4275;display:grid;place-items:center;flex:none}.pz-ic svg{width:15px;height:15px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pz-ic.v{background:#0f766e}.pz-ic.g{background:#475569}
.pz-n4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.pz-n{border:1px solid var(--pzL);border-radius:10px;padding:10px 12px}
.pz-n small{display:block;color:var(--pzM);font-size:12.5px}.pz-n b{font-size:23px;color:var(--pzD)}.pz-n i{font-style:normal;font-size:12.5px;font-weight:700;margin-left:6px}
.pz-su{color:var(--pzSu)}.pz-giu{color:var(--pzGiu)}.pz-ug{color:var(--pzM)}
.pz table{width:100%;border-collapse:collapse;font-size:14px}.pz th{text-align:left;font-size:11.5px;color:var(--pzM);font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--pzL)}
.pz td,.pz th{word-break:normal;overflow-wrap:break-word;hyphens:none}.pz td{padding:9px 8px;border-bottom:1px solid var(--pzL);vertical-align:middle}.pz .r{text-align:right}.pz tr:last-child td{border-bottom:0}
.pz-pos{font-weight:800;font-size:16px;color:var(--pzD)}.pz-pos.f{color:var(--pzM);font-weight:600;font-size:13px}
.pz-pill{display:inline-block;font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 8px;background:#f1f5f9;color:#475569;white-space:nowrap}
.pz-pill.p1{background:#dcfce7;color:#166534}.pz-pill.p2{background:#e0f2fe;color:#075985}.pz-pill.p3{background:#fef3c7;color:#92400e}
.pz-pg{color:var(--pzA);font-size:12.5px;word-break:break-all}.pz-tw{overflow-x:auto}
.pz-avv{border:1px solid #fcd34d;background:#fffbeb;color:#92400e;border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:14px}
.pz-agg{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.pz-agg input{flex:1 1 240px;min-width:0;border:1px solid #cbd5e1;border-radius:9px;padding:8px 10px;font:inherit}
.pz-bs{border:1px solid #cbd5e1;border-radius:9px;padding:6px 11px;background:#fff;color:var(--pzD);font:inherit;font-size:13.5px;cursor:pointer}.pz-bs:disabled{opacity:.6;cursor:wait}
.pz-bp{border:0;border-radius:9px;padding:8px 14px;background:var(--pzP);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.pz-x{border:0;background:none;color:#94a3b8;font-size:18px;cursor:pointer;padding:0 4px}.pz-x:hover{color:var(--pzGiu)}
.pz-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--pzM);margin-top:8px}
.pz-rot{display:inline-block;width:14px;height:14px;border:2px solid #cbd5e1;border-top-color:var(--pzA);border-radius:50%;animation:pzr .8s linear infinite;vertical-align:-2px;margin-right:6px}@keyframes pzr{to{transform:rotate(360deg)}}
@media(max-width:820px){.pz-n4{grid-template-columns:1fr 1fr}}@media(max-width:560px){.pz .hm{display:none}}`;
  const SV = { pos: '<path d="M4 19h16"/><path d="M7 15v-4"/><path d="M12 15V7"/><path d="M17 15v-6"/>', cerca: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
    ch: '<path d="M4 7h16M4 12h10M4 17h7"/>', pag: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>' };
  const ic = (k, c) => `<span class="pz-ic ${c || ''}"><svg viewBox="0 0 24 24">${SV[k]}</svg></span>`;
  const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nf = (n, d) => n == null ? '–' : Number(n).toLocaleString('it-IT', { maximumFractionDigits: d == null ? 1 : d });
  function css() { if (document.getElementById('pz-css')) return; const s = document.createElement('style'); s.id = 'pz-css'; s.textContent = CSS; document.head.appendChild(s); }
  function fr(a, b, basso) { if (a == null || b == null || !b) return ''; const d = basso ? b - a : a - b; if (Math.abs(d) < 0.05) return '<i class="pz-ug">=</i>';
    const q = basso ? nf(Math.abs(b - a)) : Math.round(Math.abs(a - b) / b * 100) + '%'; return `<i class="${d > 0 ? 'pz-su' : 'pz-giu'}">${d > 0 ? '▲' : '▼'} ${q}</i>`; }
  function spark(v) { const w = 120, h = 30, n = Math.max(v.length - 1, 1), p = v.map((x, i) => [i * (w / n), x ? 4 + ((Math.min(x, 100) - 1) / 99) * (h - 8) : null]);
    let d = '', su = false; p.forEach(([x, y]) => { if (y == null) { su = false; return; } d += (su ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; su = true; });
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><line x1="0" y1="4" x2="${w}" y2="4" stroke="#dcfce7" stroke-width="6"/><path d="${d}" fill="none" stroke="#0369a1" stroke-width="2"/>${p.map(([x, y]) => y == null ? '' : `<circle cx="${x}" cy="${y}" r="2" fill="#0369a1"/>`).join('')}</svg>`; }
  function fascia(x) { if (!x) return '<span class="pz-pill">non ancora</span>'; if (x <= 3) return '<span class="pz-pill p1">sul podio</span>'; if (x <= 10) return '<span class="pz-pill p1">1ª pagina</span>';
    if (x <= 20) return '<span class="pz-pill p2">2ª pagina</span>'; return '<span class="pz-pill p3">pagina ' + Math.ceil(x / 10) + '</span>'; }
  const dt = s => { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'long' }); };
  async function get(url) { const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); const j = await r.json().catch(() => ({})); if (!r.ok && !j.manca) throw new Error(j.error || j.errore || ('errore ' + r.status)); return j; }
  async function post(url, b) { const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) throw new Error(j.error || j.errore || ('errore ' + r.status)); return j; }
  const MANCA = '<div class="pz-avv"><b>Il Posizionamento non è ancora collegato.</b> Manca l\'archivio «posizionamento» in Cloudflare, collegato a questo sito con il nome POS.</div>';
  const pd = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '';
  function corpo(D, ag) {
    const S = D.storia; let h = `<h1>${e(D.nome)}</h1><p class="pz-s">${e(D.dom)} · ${D.ultimo ? 'ultimo aggiornamento ' + dt(D.ultimo.at) : 'ancora nessun aggiornamento: il primo arriva lunedì'} · si aggiorna da solo ogni lunedì${D.costoMese ? ' · spesa del mese ' + nf(D.costoMese, 2) + ' €' : ''}</p>`;
    if (D.chiuso) h += `<div class="pz-avv"><b>Il sito è chiuso a Google</b> (scelta tua finché la vendita non è pronta). Google non lo mostra nelle ricerche: le posizioni si controllano quando lo apri.</div>`;
    if (D.ultimo && D.ultimo.err && D.ultimo.err.length) h += `<div class="pz-avv">Nell'ultimo aggiornamento: ${D.ultimo.err.map(e).join(' · ')}</div>`;
    const g = D.gsc;
    if (!D.chiuso && g) h += `<div class="pz-b"><h2>${ic('cerca', 'v')}Da Google, ultime 4 settimane</h2><p class="pz-da">Search Console · dal ${pd(g.dal)} al ${pd(g.al)} · confronto con le 4 settimane prima</p><div class="pz-n4">
      <div class="pz-n"><small>Clic</small><b>${nf(g.tot.c, 0)}</b>${fr(g.tot.c, g.prev.c)}</div><div class="pz-n"><small>Volte che sei comparso</small><b>${nf(g.tot.i, 0)}</b>${fr(g.tot.i, g.prev.i)}</div>
      <div class="pz-n"><small>Chi ti vede e clicca</small><b>${nf(g.tot.ctr)}%</b>${fr(g.tot.ctr, g.prev.ctr)}</div><div class="pz-n"><small>Posizione media</small><b>${g.tot.pos ? nf(g.tot.pos) : '–'}</b>${g.tot.pos ? fr(g.tot.pos, g.prev.pos, 1) : ''}</div></div></div>`;
    h += `<div class="pz-b"><h2>${ic('ch')}Le tue parole chiave</h2><p class="pz-da">Le parole chiave delle pagine del sito (quelle di titoli e H1) · posizione media su Google negli ultimi 7 giorni, dai dati di Google (Search Console), aggiornata ogni lunedì</p><div class="pz-tw"><table>
      <tr><th>Parola</th><th class="r hm">Ricerche al mese</th><th class="r">Oggi</th><th class="r hm">Lun. prima</th><th class="hm">Ultime 8 settimane</th><th class="r hm">Comparso</th><th>Dove sei</th><th></th></tr>
      ${D.parole.map(p => { const st = p.storia || [], o = st.length ? st[st.length - 1] : null, pr = st.length > 1 ? st[st.length - 2] : null, d = o && pr ? pr - o : 0;
        return `<tr><td><b style="color:var(--pzD)">${e(p.parola)}</b>${p.url && o ? `<br><span class="pz-pg">${e(p.url)}</span>` : ''}</td><td class="r hm">${p.vol == null ? '…' : nf(p.vol, 0)}</td>
        <td class="r"><span class="pz-pos${o ? '' : ' f'}">${o ? nf(o) : '–'}</span> ${o && pr && d ? `<i class="${d > 0 ? 'pz-su' : 'pz-giu'}" style="font-style:normal;font-weight:700;font-size:12.5px">${d > 0 ? '▲' : '▼'}${nf(Math.abs(d))}</i>` : (p.nuova ? '<span class="pz-pill p2">nuova</span>' : '')}</td>
        <td class="r hm">${pr ? nf(pr) : '–'}</td><td class="hm">${spark(st.length ? st : [null, null])}</td><td class="r hm">${p.nuova ? '' : nf(p.imp || 0, 0)}</td><td>${p.nuova ? '<span class="pz-pill">da lunedì</span>' : fascia(o)}</td>
        <td>${ag ? `<button class="pz-x" data-pz-del="${e(p.parola)}" title="Togli «${e(p.parola)}»" aria-label="Togli ${e(p.parola)}">×</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="8" style="color:var(--pzM)">Nessuna parola: aggiungine una qui sotto.</td></tr>'}</table></div>
      <div class="pz-leg"><span><b class="pz-su">▲</b> salita rispetto al lunedì prima</span><span><b class="pz-giu">▼</b> discesa</span><span>– = Google non ti ha ancora mostrato per questa ricerca</span><span>Comparso = quante volte sei uscito negli ultimi 7 giorni</span><span>la linea in alto del grafico = 1ª posizione</span></div>
      ${ag ? `<div class="pz-agg"><input id="pz-np" placeholder="Aggiungi una parola da seguire" maxlength="80"><button class="pz-bs" data-pz-add>+ Aggiungi</button></div>` : ''}</div>`;
    if (!D.chiuso && g && g.query && g.query.length) h += `<div class="pz-b"><h2>${ic('cerca', 'v')}Le parole con cui ti trovano già</h2><p class="pz-da">Search Console · ultime 4 settimane · anche quelle che non sono nei titoli</p><div class="pz-tw"><table><tr><th>Ricerca</th><th class="r">Clic</th><th class="r hm">Comparso</th><th class="r">Posizione</th><th></th></tr>
      ${g.query.map(([q, c, i, p]) => `<tr><td>${e(q)}</td><td class="r"><b>${nf(c, 0)}</b></td><td class="r hm">${nf(i, 0)}</td><td class="r">${nf(p)}</td><td>${ag && !D.parole.some(x => x.parola === q) ? `<button class="pz-bs" data-pz-segui="${e(q)}">Segui</button>` : ''}</td></tr>`).join('')}</table></div></div>`;
    if (!D.chiuso && g && g.pagine && g.pagine.length) h += `<div class="pz-b"><h2>${ic('pag', 'g')}Le pagine che portano più visite</h2><p class="pz-da">Search Console · ultime 4 settimane</p><div class="pz-tw"><table><tr><th>Pagina</th><th class="r">Clic</th><th class="r hm">Comparsa</th><th class="r">Posizione</th></tr>
      ${g.pagine.map(([p, c, i, q]) => `<tr><td><span class="pz-pg" style="font-size:14px">${e(p)}</span></td><td class="r"><b>${nf(c, 0)}</b></td><td class="r hm">${nf(i, 0)}</td><td class="r">${nf(q)}</td></tr>`).join('')}</table></div></div>`;
    return h;
  }
  function pronta(D) { D.storia = D.settimane; D.parole.forEach(p => p.storia = (p.storia || []).filter((x, i) => i < D.settimane.length)); return D; }
  async function scheda(el, url, opz) {
    css(); opz = opz || {}; el.classList.add('pz'); el.innerHTML = '<p class="pz-s"><span class="pz-rot"></span>Un momento…</p>';
    let D; try { D = await get(url); } catch (x) { el.innerHTML = `<div class="pz-avv">Non riesco a leggere il Posizionamento: ${e(x.message)}</div>`; return; }
    if (D.manca) { el.innerHTML = MANCA; return; }
    pronta(D); el.innerHTML = corpo(D, true);
    const rifai = () => scheda(el, url, opz);
    const add = async (t, b) => { t = (t || '').trim(); if (!t) return; if (b) { b.disabled = true; b.innerHTML = '<span class="pz-rot"></span>Aggiungo…'; }
      try { await post(url, { parola: t }); rifai(); } catch (x) { alert(x.message); if (b) { b.disabled = false; b.textContent = '+ Aggiungi'; } } };
    el.onclick = async ev => { const a = ev.target.closest('[data-pz-add]'), s = ev.target.closest('[data-pz-segui]'), d = ev.target.closest('[data-pz-del]');
      if (a) add(el.querySelector('#pz-np').value, a);
      if (s) add(s.dataset.pzSegui, s);
      if (d && confirm('Togliere «' + d.dataset.pzDel + '» dalle parole da seguire? Le posizioni già misurate restano.')) { d.disabled = true; try { await post(url, { parola: d.dataset.pzDel, togli: 1 }); rifai(); } catch (x) { alert(x.message); d.disabled = false; } } };
    const np = el.querySelector('#pz-np'); if (np) np.onkeydown = ev => { if (ev.key === 'Enter') add(np.value, el.querySelector('[data-pz-add]')); };
  }
  async function riquadro(el, url, apri) {
    css(); el.classList.add('pz');
    let D; try { D = await get(url); } catch (x) { el.innerHTML = ''; return; }
    if (D.manca) { el.innerHTML = `<div class="pz-b"><h2>${ic('pos')}Posizionamento</h2><p class="pz-da" style="margin:0">Non ancora collegato.</p></div>`; return; }
    pronta(D); const P = D.parole, last = p => p.storia.length ? p.storia[p.storia.length - 1] : null, prev = p => p.storia.length > 1 ? p.storia[p.storia.length - 2] : null;
    const su = P.filter(p => last(p) && prev(p) && last(p) < prev(p)).length, pr = P.filter(p => last(p) && last(p) <= 10).length, g = D.gsc;
    el.innerHTML = `<div class="pz-b"><h2>${ic('pos')}Posizionamento</h2><p class="pz-da">${D.ultimo ? 'Ultimo aggiornamento ' + dt(D.ultimo.at) : 'Il primo aggiornamento arriva lunedì'} · si aggiorna da solo ogni lunedì</p>
      ${D.chiuso ? '<p style="margin:0 0 10px">Il sito è chiuso a Google: le posizioni partono quando lo apri.</p>' : `<div class="pz-n4"><div class="pz-n"><small>Parole in salita</small><b class="pz-su">${su}</b></div><div class="pz-n"><small>In prima pagina</small><b>${pr}</b> <small style="display:inline">su ${P.length}</small></div>
      <div class="pz-n"><small>Clic da Google (4 sett.)</small><b>${g ? nf(g.tot.c, 0) : '–'}</b>${g ? fr(g.tot.c, g.prev.c) : ''}</div><div class="pz-n"><small>Posizione media</small><b>${g && g.tot.pos ? nf(g.tot.pos) : '–'}</b>${g && g.tot.pos ? fr(g.tot.pos, g.prev.pos, 1) : ''}</div></div>`}
      <button class="pz-bp" style="margin-top:12px" data-pz-apri>Apri il Posizionamento</button></div>`;
    el.querySelector('[data-pz-apri]').onclick = apri;
  }
  window.PosUI = { scheda, riquadro };
})();
