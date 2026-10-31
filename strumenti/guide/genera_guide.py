"""Pagine guida di quota120.com, stessa grafica del sito. Uso: python3 genera_guide.py <public/sito> [slug...]"""
import re, json, sys, os, html, importlib.util
S = sys.argv[1]; B = 'https://quota120.com'; QUI = os.path.dirname(os.path.abspath(__file__))
TPL = open(f'{S}/contatti/index.html').read()
CSS = ('.gd{padding:56px 0 30px}.gd .w{max-width:820px}.gd h2{font:800 30px/1.12 var(--disp);color:var(--ink);margin:44px 0 12px}.gd h2:first-child{margin-top:0}'
 '.gd p,.gd li{font-size:17px;line-height:1.65;color:var(--txt)}.gd p{margin:0 0 12px}.gd ul.pt{margin:0 0 12px;padding-left:22px}.gd li{margin:5px 0}'
 '.gd .breve{background:#fff;border:1px solid var(--line);border-left:5px solid #1E6B6F;border-radius:14px;padding:18px 20px;margin:0 0 8px}.gd .breve b.t{display:block;font:800 19px/1.2 var(--disp);color:var(--ink);margin-bottom:6px}.gd .breve p{margin:0}'
 '.gd figure{margin:22px 0}.gd figure img{display:block;width:100%;height:auto;border-radius:14px;border:1px solid var(--line);box-shadow:0 14px 36px rgba(15,34,48,.14)}.gd figcaption{margin-top:8px;color:var(--muted);font-size:14px}'
 '.gd table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:16px;margin:6px 0 10px}.gd th{text-align:left;background:#F3F6F7;color:var(--ink);padding:10px 12px;font-size:14.5px}.gd td{padding:10px 12px;border-top:1px solid var(--line);vertical-align:top;color:var(--txt)}.gd td:first-child{font-weight:700;color:var(--ink)}'
 '.gd th,.gd td{text-align:left!important;white-space:normal!important}.kh .gd table{min-width:0;table-layout:auto}.gd .tab{overflow-x:auto}.gd .nota{color:var(--muted);font-size:14px}'
 '.gd ol.passi{list-style:none;padding:0;margin:8px 0 12px;display:grid;grid-template-columns:1fr!important;gap:8px;counter-reset:p}.gd ol.passi li{counter-increment:p;display:flex;gap:12px;align-items:flex-start;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0}'
 '.gd ol.passi li::before{content:counter(p);width:30px;height:30px;border-radius:8px;background:#1E6B6F;color:#fff;display:grid;place-items:center;flex:none;font-weight:700;font-size:15px}'
 '.gd .cta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:30px 0 6px}.gd .cta div{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:8px}.gd .cta b{font:800 21px/1.15 var(--disp);color:var(--ink)}.gd .cta p{margin:0;font-size:15px;color:var(--muted);flex:1}.gd .cta .kbtn{align-self:flex-start}'
 '.gd details{background:#fff;border:1px solid var(--line);border-radius:12px;margin:8px 0}.gd summary{cursor:pointer;padding:13px 16px;font-weight:700;color:var(--ink);font-size:16.5px}.gd details p{padding:0 16px 14px;margin:0}'
 '.gd .fonti{background:#F3F6F7;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-top:36px;font-size:14.5px;color:var(--txt)}.gd .fonti b{display:block;color:var(--ink);margin-bottom:6px}.gd .fonti ul{margin:0;padding-left:20px}.gd .fonti li{font-size:14.5px;margin:3px 0}'
 '@media(max-width:700px){.gd .cta{grid-template-columns:minmax(0,1fr)}.gd .cta .kbtn{white-space:normal;text-align:center}.gd h2{font-size:26px}}')
def esc(t): return html.escape(t, quote=True)
def blocco(b):
    k = b[0]
    if k == 'p': return f'<p>{b[1]}</p>'
    if k == 'h2': return f'<h2 id="{b[2] if len(b)>2 else ""}">{b[1]}</h2>'
    if k == 'ul': return '<ul class="pt">' + ''.join(f'<li>{x}</li>' for x in b[1]) + '</ul>'
    if k == 'passi': return '<ol class="passi">' + ''.join(f'<li><span>{x}</span></li>' for x in b[1]) + '</ol>'
    if k == 'tab': return '<div class="tab"><table><tr>' + ''.join(f'<th>{h}</th>' for h in b[1]) + '</tr>' + ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in b[2]) + '</table></div>' + (f'<p class="nota">{b[3]}</p>' if len(b) > 3 else '')
    if k == 'img': return f'<figure><img src="/img/{b[1]}" width="{b[3]}" height="{b[4]}" alt="{esc(b[2])}" loading="lazy"><figcaption>{b[5]}</figcaption></figure>'
    if k == 'breve': return f'<div class="breve"><b class="t">In breve</b><p>{b[1]}</p></div>'
    raise ValueError(k)
def pagina(g):
    u = f'{B}/guide/{g["slug"]}/'
    h = TPL
    h = re.sub(r'<title>[^<]*</title>', f'<title>{esc(g["title"])}</title>', h)
    for a, v in [('name="description"', g['desc']), ('property="og:title"', g['title']), ('property="og:description"', g['desc']), ('property="og:image:alt"', g['h1'])]:
        h = re.sub(rf'<meta {a} content="[^"]*">', f'<meta {a} content="{esc(v)}">', h)
    h = re.sub(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{u}">', h)
    h = re.sub(r'<meta property="og:url" content="[^"]*">', f'<meta property="og:url" content="{u}">', h)
    h = re.sub(r'<meta property="og:type" content="[^"]*">', '<meta property="og:type" content="article">', h)
    h = h.replace('og-home.jpg', g.get('og', 'og-home.jpg'))
    m = re.search(r'(<script type="application/ld\+json">)(.*?)(</script>)', h, re.S); d = json.loads(m.group(2))
    org = next(n for n in d['@graph'] if n['@type'] == 'Organization'); per = next(n for n in d['@graph'] if n['@type'] == 'Person')
    d['@graph'] = [org, per,
      {"@type": "Article", "@id": u + "#articolo", "headline": g['h1'], "description": g['desc'], "url": u, "inLanguage": "it-IT", "datePublished": g['data'], "dateModified": g['data'],
       "author": {"@id": B + "/#paolo"}, "publisher": {"@id": B + "/#org"}, "isPartOf": {"@id": B + "/#web"}, "image": f'{B}/img/{g.get("og","og-home.jpg")}', "citation": [f[1] for f in g['fonti']], "about": g.get('about', [])},
      {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Quota 120", "item": B + "/"}, {"@type": "ListItem", "position": 2, "name": "Guide", "item": B + "/guide/"}, {"@type": "ListItem", "position": 3, "name": g['breve_nome'], "item": u}]},
      {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": re.sub('<[^>]+>', '', a)}} for q, a in g['faq']]}]
    h = h[:m.start(2)] + json.dumps(d, ensure_ascii=False) + h[m.end(2):]
    if '.gd{' not in h: h = h.replace('</style>', CSS + '</style>', 1)
    main = (f'<main><div class="kh"><section class="khero" style="padding:72px 0 56px"><div class="blob b1"></div><div class="blob b2"></div><div class="grid-bg"></div>'
      f'<div class="w"><div class="kpill"><b></b>Guida · aggiornata al {g["data_it"]}</div><h1>{g["h1"]}</h1><p class="lead">{g["lead"]}</p></div></section>'
      '<section class="gd"><div class="w">' + ''.join(blocco(b) for b in g['corpo'])
      + '<div class="cta">' + ''.join(f'<div><b>{t}</b><p>{p}</p><a class="kbtn kbp" href="{l}">{a}</a></div>' for t, p, a, l in g['cta']) + '</div>'
      + '<h2 id="domande">Domande frequenti</h2>' + ''.join(f'<details><summary>{q}</summary><p>{a}</p></details>' for q, a in g['faq'])
      + '<div class="fonti"><b>Fonti ufficiali</b><ul>' + ''.join(f'<li><a href="{l}" rel="noopener" target="_blank">{t}</a></li>' for t, l in g['fonti']) + f'</ul><p style="margin:8px 0 0">Scritta da Paolo Boldrini, Quota 120. Le regole cambiano: prima di volare controlla sempre le fonti ufficiali. Quota 120 non è collegato a ENAC, D-Flight o EASA.</p></div>'
      + '</div></section></div></main>')
    i = h.index('<main>'); j = h.index('</main>') + 7
    return h[:i] + main + h[j:]
def indice(guide):
    """Pagina /guide/: un riquadro con bottone per ogni guida."""
    u = f'{B}/guide/'
    h = TPL
    tit = 'Guide per chi vola con i droni in Italia · Quota 120'
    des = 'Guide semplici e aggiornate per operatori e piloti di droni: D-Flight, zone, NOTAM, assicurazione, patentino, drone agricolo, segnalazioni. Con le fonti ufficiali.'
    h = re.sub(r'<title>[^<]*</title>', f'<title>{esc(tit)}</title>', h)
    for a, v in [('name="description"', des), ('property="og:title"', tit), ('property="og:description"', des), ('property="og:image:alt"', tit)]:
        h = re.sub(rf'<meta {a} content="[^"]*">', f'<meta {a} content="{esc(v)}">', h)
    h = re.sub(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{u}">', h)
    h = re.sub(r'<meta property="og:url" content="[^"]*">', f'<meta property="og:url" content="{u}">', h)
    m = re.search(r'(<script type="application/ld\+json">)(.*?)(</script>)', h, re.S); d = json.loads(m.group(2))
    org = next(n for n in d['@graph'] if n['@type'] == 'Organization'); per = next(n for n in d['@graph'] if n['@type'] == 'Person')
    d['@graph'] = [org, per, {"@type": "CollectionPage", "@id": u + "#page", "url": u, "name": tit, "description": des, "inLanguage": "it-IT", "isPartOf": {"@id": B + "/#web"}, "author": {"@id": B + "/#paolo"},
       "hasPart": [{"@type": "Article", "headline": g['h1'], "url": f'{B}/guide/{g["slug"]}/'} for g in guide]},
      {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Quota 120", "item": B + "/"}, {"@type": "ListItem", "position": 2, "name": "Guide", "item": u}]}]
    h = h[:m.start(2)] + json.dumps(d, ensure_ascii=False) + h[m.end(2):]
    if '.gd{' not in h: h = h.replace('</style>', CSS + '</style>', 1)
    main = ('<main><div class="kh"><section class="khero" style="padding:72px 0 56px"><div class="blob b1"></div><div class="blob b2"></div><div class="grid-bg"></div>'
      '<div class="w"><div class="kpill"><b></b>Guide · con le fonti ufficiali</div><h1>Guide per chi vola con i droni</h1><p class="lead">Le cose da sapere prima di volare e per lavorare in regola, spiegate in breve. Ogni guida ha la risposta in cima e i link alle fonti ufficiali.</p></div></section>'
      '<section class="gd"><div class="w" style="max-width:1080px"><div class="cta" style="margin-top:0">'
      + ''.join(f'<div><b>{g["breve_nome"]}</b><p>{g["lead"]}</p><a class="kbtn kbp" href="/guide/{g["slug"]}/">{g.get("anchor", g["breve_nome"])}</a></div>' for g in guide)
      + '</div></div></section></div></main>')
    i = h.index('<main>'); j = h.index('</main>') + 7
    return h[:i] + main + h[j:]

def carica_tutte():
    out = []
    for f in sorted(os.listdir(QUI)):
        if f.startswith('g_') and f.endswith('.py'):
            spec = importlib.util.spec_from_file_location(f[:-3], os.path.join(QUI, f)); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); out.append(mod.G)
    return out

def menu_guide(h):
    """Voce «Guide» nel menu del sito (computer e telefono)."""
    if 'href="/guide/"' in h: return h
    h = re.sub(r'(<a class="mn-a" href="/?#domande">Domande</a>)', r'<a class="mn-a" href="/guide/">Guide</a>\1', h, count=1)
    h = h.replace('<a href="/#domande">Domande</a>', '<a href="/guide/">Guide</a><a href="/#domande">Domande</a>', 1)
    return h

if __name__ == '__main__':
    guide = carica_tutte()
    solo = sys.argv[2:]
    for g in guide:
        if solo and g['slug'] not in solo: continue
        os.makedirs(f'{S}/guide/{g["slug"]}', exist_ok=True)
        t = menu_guide(pagina(g)); open(f'{S}/guide/{g["slug"]}/index.html', 'w').write(t); print('fatta', g['slug'])
    if not solo:
        t = menu_guide(indice(guide)); open(f'{S}/guide/index.html', 'w').write(t); print('fatto indice')
        for root, _, files in os.walk(S):
            for f in files:
                if f == 'index.html':
                    p2 = os.path.join(root, f); t = open(p2).read(); t2 = menu_guide(t)
                    if t2 != t: open(p2, 'w').write(t2)
