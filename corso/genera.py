"""Fa i video del corso A1-A3: per ogni scena un'immagine (Chromium) e la voce (Piper, voce italiana «paola»),
poi ffmpeg li unisce in un mp4 per lezione. Gira su GitHub Actions (serve internet per la voce)."""
import json, os, subprocess, sys, html, wave
sys.path.insert(0, os.path.dirname(__file__))
from corso_lezioni import L
from playwright.sync_api import sync_playwright
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
    return f"<!doctype html><html><head><meta charset='utf-8'>{FONT}<style>{CSS}</style></head><body><div class='b1'></div><div class='b2'></div><div class='g'></div><div class='c'>{c}</div><div class='marca'>Corso A1-A3 · {e(lez)}</div></body></html>"
def durata(p):
    with wave.open(p) as w: return w.getnframes() / w.getframerate()
solo = sys.argv[1:]
with sync_playwright() as pw:
    br = pw.chromium.launch(); pg = br.new_page(viewport={'width': 1280, 'height': 720})
    for lez in L:
        if solo and lez['slug'] not in solo: continue
        parti = []
        for i, s in enumerate(lez['scene']):
            img, wav, mp4 = f"{TMP}/{lez['slug']}-{i}.png", f"{TMP}/{lez['slug']}-{i}.wav", f"{TMP}/{lez['slug']}-{i}.mp4"
            pg.set_content(scena_html(s, lez['titolo'])); pg.wait_for_timeout(600); pg.screenshot(path=img)
            subprocess.run(['piper', '--model', VOCE, '--output_file', wav, '--length_scale', '1.05', '--sentence_silence', '0.35'], input=s['v'].encode(), check=True)
            d = durata(wav) + 0.9
            # leggero avvicinamento dell'immagine mentre parla la voce
            vf = f"scale=1600:-1,zoompan=z='min(zoom+0.0005,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(d*25)}:s=1280x720:fps=25,fade=t=in:st=0:d=0.35,fade=t=out:st={d-0.35:.2f}:d=0.35"
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', img, '-i', wav, '-vf', vf, '-af', 'apad', '-t', f'{d:.2f}',
                            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', mp4], check=True)
            parti.append(mp4)
        lista = f"{TMP}/{lez['slug']}.txt"; open(lista, 'w').write(''.join(f"file '{p}'\n" for p in parti))
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', '-movflags', '+faststart', f"{OUT}/{lez['slug']}.mp4"], check=True)
        # copertina = prima scena
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f"{TMP}/{lez['slug']}-0.png", '-vf', 'scale=960:-1', '-q:v', '4', f"{OUT}/{lez['slug']}.jpg"], check=True)
        print('fatto', lez['slug'])
    br.close()
