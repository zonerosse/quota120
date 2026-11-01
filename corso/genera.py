"""Fa i video dei videocorsi: per ogni scena un'immagine (Chromium) e la voce (Piper, voce italiana «paola»),
poi ffmpeg li unisce in un mp4 per lezione. Legge l'elenco da fare (file JSON: [{file, titolo, scene}]),
fa solo i video che mancano e toglie quelli vecchi. Gira su GitHub Actions."""
import json, os, re, subprocess, sys, html, wave
OUT = 'public/corso/video'; TMP = '/tmp/corso'; VOCE = os.environ.get('VOCE', '/tmp/voce/it_IT-paola-medium.onnx')
os.makedirs(OUT, exist_ok=True); os.makedirs(TMP, exist_ok=True)
CSS = """*{box-sizing:border-box}body{margin:0;width:1280px;height:720px;background:#0F2230;color:#fff;font-family:'Barlow',Arial,sans-serif;overflow:hidden;position:relative}
.g{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:56px 56px}
.b1{position:absolute;width:620px;height:620px;border-radius:50%;background:#1E6B6F;filter:blur(110px);opacity:.55;left:-180px;top:-200px}
.b2{position:absolute;width:520px;height:520px;border-radius:50%;background:#1C4A5C;filter:blur(110px);opacity:.6;right:-160px;bottom:-200px}
.c{position:absolute;inset:0;padding:70px 90px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.k{font-weight:700;letter-spacing:.12em;color:#E8C15A;font-size:24px}
.t{font-family:'Barlow Semi Condensed',Arial Narrow,Arial,sans-serif;font-weight:700;font-size:78px;line-height:1.02}
.n{font-family:'Barlow Semi Condensed',Arial Narrow,Arial,sans-serif;font-weight:700;font-size:190px;line-height:.9;color:#E8C15A}
ul{margin:0;padding:0;list-style:none;display:grid;gap:14px}li{font-size:36px;line-height:1.25;padding-left:40px;position:relative}
li:before{content:'';position:absolute;left:0;top:14px;width:16px;height:16px;border-radius:4px;background:#E8C15A}
table{border-collapse:collapse;font-size:34px}td{padding:12px 22px 12px 0;border-bottom:1px solid rgba(255,255,255,.18)}td:first-child{font-weight:700;color:#E8C15A;white-space:nowrap;padding-right:40px}
.marca{position:absolute;right:80px;bottom:50px;font-size:20px;color:rgba(255,255,255,.55);font-weight:600}"""
FONT = "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Barlow:wght@500;600;700&family=Barlow+Semi+Condensed:wght@700&display=swap'>"
def scena_html(s, lez):
    e = html.escape; c = ''
    if s.get('k'): c += f"<div class='k'>{e(s['k'])}</div>"
    if s.get('n'): c += f"<div class='n'>{e(s['n'])}</div>"
    if s.get('t'): c += f"<div class='t'>{e(s['t'])}</div>"
    if s.get('p'): c += '<ul>' + ''.join(f'<li>{e(x)}</li>' for x in s['p']) + '</ul>'
    if s.get('l'): c += '<table>' + ''.join(f'<tr><td>{e(a)}</td><td>{e(b)}</td></tr>' for a, b in s['l']) + '</table>'
    return f"<!doctype html><html><head><meta charset='utf-8'>{FONT}<style>{CSS}</style></head><body><div class='b1'></div><div class='b2'></div><div class='g'></div><div class='c'>{c}</div><div class='marca'>{e(lez)}</div></body></html>"
def frasi(t):
    return [x.strip() for x in re.findall(r'[^.!?]+[.!?]*', t) if x.strip()] or [t]
def ts(x):
    h, r = divmod(x, 3600); m, s = divmod(r, 60); return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"
def durata(p):
    with wave.open(p) as w: return w.getnframes() / w.getframerate()
OK = re.compile(r'^[A-Za-z0-9-]{3,80}$')
MAX_MB = 20                      # un video oltre i 20 MB non si pubblica
VOCE_LEZ, VOCE_AZ = 6000, 60000  # caratteri della voce: per lezione e per tutti i corsi di un'azienda
def voce(x): return sum(len(str(s.get('v') or s.get('t') or '')) for s in x.get('scene') or [])
elenco, per_az = [], {}
for x in json.load(open(sys.argv[1])):
    if not OK.match(x.get('file', '')): continue
    # corsi delle aziende (az-): solo quelli che il titolare ha approvato, e dentro i tetti della voce
    if x['file'].startswith('az-'):
        if not x.get('approvato'): print('salto (corso aziendale non approvato):', x['file'], x.get('op', '')); continue
        n = voce(x); per_az[x.get('op', '')] = per_az.get(x.get('op', ''), 0) + n
        if n > VOCE_LEZ or per_az[x.get('op', '')] > VOCE_AZ: print('salto (testo della voce troppo lungo):', x['file'], n); continue
    if x.get('scene'): elenco.append(x)
if not elenco: sys.exit('elenco vuoto: non tocco niente')
voluti = {x['file'] for x in elenco}
# via i video vecchi (scene cambiate o lezione tolta)
for f in os.listdir(OUT):
    b, ext = os.path.splitext(f)
    if ext in ('.mp4', '.jpg', '.vtt', '.m4a') and b not in voluti: os.remove(os.path.join(OUT, f)); print('tolto', f)
mancano = [x for x in elenco if not (os.path.exists(f"{OUT}/{x['file']}.mp4") and os.path.exists(f"{OUT}/{x['file']}.vtt"))]
senza_voce = lambda: [x for x in elenco if os.path.exists(f"{OUT}/{x['file']}.mp4") and not os.path.exists(f"{OUT}/{x['file']}.m4a")]
if '--conta' in sys.argv: print(len(mancano) + len(senza_voce())); sys.exit(0)
def solo_voce():
    # la sola voce della lezione, per ascoltarla in auto: si copia l'audio del video, senza ricodificarlo
    for x in senza_voce():
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f"{OUT}/{x['file']}.mp4", '-vn', '-c:a', 'copy', '-movflags', '+faststart', f"{OUT}/{x['file']}.m4a"], check=True)
        print('voce', x['file'])
if not mancano: solo_voce(); print('video: niente da fare'); sys.exit(0)
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    br = pw.chromium.launch(); pg = br.new_page(viewport={'width': 1280, 'height': 720})
    for lez in mancano:
        nome, parti, sub, t0 = lez['file'], [], ['WEBVTT', ''], 0.0
        for i, s in enumerate(lez['scene']):
            img, wav, mp4 = f"{TMP}/{nome}-{i}.png", f"{TMP}/{nome}-{i}.wav", f"{TMP}/{nome}-{i}.mp4"
            pg.set_content(scena_html(s, lez.get('titolo', ''))); pg.wait_for_timeout(600); pg.screenshot(path=img)
            testo = (s.get('v') or s.get('t') or ' ').strip() or ' '
            subprocess.run(['piper', '--model', VOCE, '--output_file', wav, '--length_scale', '1.05', '--sentence_silence', '0.35'], input=testo.encode(), check=True)
            parla = durata(wav); d = parla + 0.9
            # sottotitoli: le frasi della voce, con il tempo diviso in base alla lunghezza
            ff = frasi(testo); tot = sum(len(f) for f in ff) or 1; a = t0 + 0.1
            for f in ff:
                b = a + parla * len(f) / tot
                sub += [ts(a) + ' --> ' + ts(b), f, '']; a = b
            t0 += d
            vf = f"scale=1600:-1,zoompan=z='min(zoom+0.0005,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(d*25)}:s=1280x720:fps=25,fade=t=in:st=0:d=0.35,fade=t=out:st={d-0.35:.2f}:d=0.35"
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', img, '-i', wav, '-vf', vf, '-af', 'apad', '-t', f'{d:.2f}',
                            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', mp4], check=True)
            parti.append(mp4)
        lista = f"{TMP}/{nome}.txt"; open(lista, 'w').write(''.join(f"file '{p}'\n" for p in parti))
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', '-movflags', '+faststart', f"{OUT}/{nome}.mp4"], check=True)
        # troppo pesante: si rifà più leggero (960x540, qualità più bassa); se è ancora oltre i 20 MB non si pubblica
        if os.path.getsize(f"{OUT}/{nome}.mp4") > MAX_MB * 1024 * 1024:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f"{OUT}/{nome}.mp4", '-vf', 'scale=960:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', f"{TMP}/{nome}-leggero.mp4"], check=True)
            os.replace(f"{TMP}/{nome}-leggero.mp4", f"{OUT}/{nome}.mp4")
        if os.path.getsize(f"{OUT}/{nome}.mp4") > MAX_MB * 1024 * 1024:
            os.remove(f"{OUT}/{nome}.mp4"); print('salto (video oltre i', MAX_MB, 'MB):', nome); continue
        open(f"{OUT}/{nome}.vtt", 'w', encoding='utf-8').write('\n'.join(sub))
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f"{TMP}/{nome}-0.png", '-vf', 'scale=960:-1', '-q:v', '4', f"{OUT}/{nome}.jpg"], check=True)
        print('fatto', nome)
    br.close()
solo_voce()
