# Genera public/sito/prezzi/index.html a partire dalla pagina Contatti (stessa testa, menu e piede)
import json, re, sys, base64, os
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = open(R + '/public/sito/contatti/index.html').read()
U = 'https://quota120.com/prezzi/'
TIT = 'Prezzi di Quota 120 · gratis nel periodo di lancio'
DES = 'Quanto costa Quota 120, gestionale per operatori di droni: nel periodo di lancio è gratis con tutte le funzioni, senza carta di credito né limiti di piloti.'
FAQ = [
 ('Quota 120 è davvero gratis?', 'Sì. Nel periodo di lancio si usa gratis, con tutte le funzioni, senza carta di credito e senza limiti di piloti o droni.'),
 ('Perché è gratis?', 'Lo stiamo provando sul lavoro vero con i primi operatori. Le vostre segnalazioni ci dicono cosa migliorare prima di renderlo a pagamento.'),
 ('Quanto costerà dopo?', 'Non è ancora deciso. Quando sarà deciso lo saprai almeno 60 giorni prima, per email, e sarai libero di restare o di andartene.'),
 ('Se un giorno non lo voglio più, cosa succede ai miei dati?', 'I dati restano tuoi. Ti mandiamo una copia di tutto (voli, documenti, schede) e poi cancelliamo lo spazio, se ce lo chiedi.'),
 ('Serve un contratto o una carta di credito?', 'No. Ti iscrivi con l’email dell’azienda e accetti le condizioni d’uso: niente carta, niente contratto da firmare.'),
]
main = '''<main><div class="kh">
<section class="khero" style="padding:80px 0 60px"><div class="blob b1"></div><div class="blob b2"></div><div class="grid-bg"></div>
<div class="w"><div class="kpill"><b></b>Periodo di lancio</div>
<h1>Prezzi</h1>
<p class="lead">Quota 120 oggi è gratis, con tutte le funzioni. Niente carta di credito, niente limiti di piloti o droni.</p>
<div style="display:flex;gap:12px;flex-wrap:wrap"><a class="kbtn kbp" href="https://app.quota120.com/">Crea il tuo spazio gratis</a><a class="kbtn kbs" href="https://app.quota120.com/prova">Guarda la prova con i dati di esempio</a></div>
</div></section>
<section class="cz"><div class="w"><div>
<p class="kick">Cosa c’è dentro</p><h2 style="font:800 34px/1.1 var(--disp);margin:0;color:var(--ink)">Tutto, per tutti</h2>
<p style="margin:10px 0 18px;color:var(--muted);max-width:62ch">Nel periodo di lancio non ci sono versioni ridotte: ogni operatore ha il programma intero.</p>
<ul class="pz-l">
<li><b>Lavori e calendario</b>dal preventivo alla fattura, con chi vola e con quale drone</li>
<li><b>Controllo prima del volo</b>dal telefono del pilota, con meteo e zone D-Flight presi da soli</li>
<li><b>Registro voli</b>che si scrive da solo dai file DJI</li>
<li><b>Droni, batterie e manutenzioni</b>con l’andamento delle celle</li>
<li><b>Documenti e scadenze</b>con le email che avvisano prima</li>
<li><b>Valutazione del rischio, permessi e segnalazioni</b>pronti da mandare</li>
<li><b>Agricoltura</b>campi, trattamenti e quaderno di campagna</li>
<li><b>Rapporto PDF per il cliente</b>con tutti i voli del lavoro</li>
<li><b>Corsi A1-A3, A2 e STS</b>per i tuoi piloti</li>
</ul>
<div class="im pz-im"><img src="/img/home.webp" alt="La Home dell’Admin di Quota 120" width="1060" height="620" loading="lazy"></div>
</div>
<div><div class="reg"><p class="kick" style="margin-bottom:6px">Periodo di lancio</p><h3 class="pz-p">0 €</h3><p>Tutte le funzioni, piloti e droni senza limite.</p>
<ul class="pz-ok"><li><b>Nessuna carta di credito</b>ti iscrivi con l’email e basta</li><li><b>Niente addebiti a sorpresa</b>se diventerà a pagamento lo saprai almeno 60 giorni prima, e decidi tu se restare</li><li><b>I dati restano tuoi</b>quando vuoi ti mandiamo una copia di tutto</li></ul>
<a class="kbtn kbp" href="https://app.quota120.com/" style="margin-top:6px;justify-content:center;width:100%">Crea il tuo spazio gratis</a>
<p style="margin-top:12px;font-size:14px">Prima vuoi guardarlo? <a href="https://app.quota120.com/prova">Apri la prova con i dati di esempio</a>.</p></div></div>
</div></section>
<section class="faq" id="domande"><div class="w"><div><p class="kick">Domande</p><h2>Le domande sul prezzo</h2></div>
''' + ''.join('<details><summary>%s</summary><p>%s</p></details>' % q for q in FAQ) + '''
<p style="margin-top:22px;color:var(--muted)">Le regole del servizio sono nelle <a href="/condizioni/">condizioni d’uso di Quota 120</a>. Per altre domande scrivi ad <a href="mailto:assistenza@quota120.com">assistenza@quota120.com</a>.</p>
</div></section>
</div></main>'''
css = '''.pz-l{list-style:none;padding:0;margin:0 0 24px;display:grid;gap:10px}
.pz-l li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px 12px 44px;position:relative;color:var(--muted);font-size:15.5px}
.pz-l li::before{content:"";position:absolute;left:14px;top:15px;width:18px;height:18px;border-radius:50%;background:#1E6B6F url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3'%3E%3Cpath d='M5 12l5 5 9-10'/%3E%3C/svg%3E") center/12px no-repeat}
.pz-l b,.pz-ok b{display:block;color:var(--ink);font-size:16.5px}
.pz-im{border-radius:14px;border:1px solid var(--line);box-shadow:0 14px 40px rgba(15,34,48,.12)}
.pz-p{font:800 56px/1 var(--disp)!important;color:#1E6B6F!important;margin:0 0 4px!important}
.pz-ok{list-style:none;padding:0;margin:14px 0 18px;display:grid;gap:12px;font-size:15px;color:var(--muted)}
.pz-ok li{border-left:4px solid #E8C15A;padding-left:12px}
@media(max-width:860px){.cz .w{grid-template-columns:1fr!important}.cz .w>div:last-child{order:-1}.reg{position:static!important}}
'''
ld = {"@context": "https://schema.org", "@graph": [
 {"@type": "WebPage", "@id": U + "#page", "url": U, "name": TIT, "description": DES, "inLanguage": "it-IT", "isPartOf": {"@id": "https://quota120.com/#web"}, "about": {"@id": "https://quota120.com/#app"}, "datePublished": "2026-11-01", "dateModified": "2026-11-01", "author": {"@id": "https://quota120.com/#paolo"}},
 {"@type": "SoftwareApplication", "@id": "https://quota120.com/#app", "name": "Quota 120", "applicationCategory": "BusinessApplication", "operatingSystem": "Web, iPhone, Android", "url": "https://app.quota120.com/",
  "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR", "description": "Gratis nel periodo di lancio, con tutte le funzioni", "url": U}},
 {"@type": "FAQPage", "@id": U + "#faq", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]},
 {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Quota 120", "item": "https://quota120.com/"}, {"@type": "ListItem", "position": 2, "name": "Prezzi", "item": U}]},
 {"@type": "Person", "@id": "https://quota120.com/#paolo", "name": "Paolo Boldrini", "url": "https://puntowebferrara.com/"}]}
t = s
t = re.sub(r'<meta name="description" content="[^"]*">', '<meta name="description" content="%s">' % DES, t, count=1)
t = re.sub(r'<title>[^<]*</title>', '<title>Prezzi · Quota 120</title>', t, count=1)
t = t.replace('https://quota120.com/contatti/', U)
t = re.sub(r'<meta property="og:title" content="[^"]*">', '<meta property="og:title" content="%s">' % TIT, t, count=1)
t = re.sub(r'<meta property="og:description" content="[^"]*">', '<meta property="og:description" content="%s">' % DES, t, count=1)
t = re.sub(r'<script type="application/ld\+json">.*?</script>', '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False) + '</script>', t, count=1, flags=re.S)
t = t.replace('</style>', css + '</style>', 1)
a = t.index('<main>'); b = t.index('</main>') + 7
t = t[:a] + main + t[b:]
if '/prezzi/">Prezzi' not in t:
    t = t.replace('<a class="mn-a" href="/#domande">Domande</a>', '<a class="mn-a" href="/prezzi/">Prezzi</a><a class="mn-a" href="/#domande">Domande</a>', 1).replace('<a href="/#domande">Domande</a>', '<a href="/prezzi/">Prezzi</a><a href="/#domande">Domande</a>', 1)
os.makedirs(R + '/public/sito/prezzi', exist_ok=True)
open(R + '/public/sito/prezzi/index.html', 'w').write(t)
if len(sys.argv) > 1:   # anteprima autonoma: immagini dentro il file, link al sito vero
    img = 'data:image/webp;base64,' + base64.b64encode(open(R + '/public/sito/img/home.webp', 'rb').read()).decode()
    p = t.replace('src="/img/home.webp"', 'src="' + img + '"').replace('href="/', 'href="https://quota120.com/')
    open(sys.argv[1], 'w').write(p)
print('ok', len(t))
