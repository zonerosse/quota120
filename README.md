# Quota 120 (prova)

Gestionale per operatori di droni in Italia: controllo prima del volo, registro voli, droni e batterie, piloti e attestati,
autorizzazioni ENAC, D-Flight, clienti e preventivi, manutenzioni, inventario, campi e trattamenti, documenti.
I dati di esempio sono inventati.

- `public/index.html` – l'app (Admin e operatori), installabile sul telefono dalla schermata Home.
- `src/index.js` – Worker: serve i file di `public` e le API `/api/*`; i dati e i documenti stanno in un Durable Object (SQLite), niente database da creare.
- `wrangler.jsonc` – configurazione: Cloudflare la usa da sola con «npx wrangler deploy» a ogni push.

## Spazi degli operatori (prova gratuita)
- `/` è l'ingresso: chi non ha Quota 120 tocca «Crea il tuo spazio gratis», scrive nome dell'operatore, codice D-Flight (se c'è),
  nome e email, e conferma con un codice di 6 cifre via email. Nasce lo spazio `/<nome-operatore>` (es. `/rossi-droni`), vuoto.
- Ogni spazio ha i suoi dati in un Durable Object separato (`op:<nome>`); il registro delle iscrizioni sta in `registro`.
  Lo smistatore mette l'intestazione `x-q120-op` solo lui: un telefono di uno spazio non può leggere un altro spazio.
- L'Admin di uno spazio entra con la sua email (codice di 6 cifre, vale 15 minuti). Il telefono resta riconosciuto; se non
  lo usa per 15 giorni, rifà il codice. I piloti entrano dall'indirizzo dello spazio con nome e matricola, come prima.
- La versione di prova sta su `prova.quota120.com` (separata dall'app vera): ogni visitatore ha la sua (contenitore
  `demo:<id>`, id casuale nel cookie `q120p`), con i dati di esempio e il codice Admin 1234. Si cancella da sola dopo 6 ore
  senza usarla o 24 ore dalla nascita (allarme del contenitore); al massimo 20 prove nuove al giorno da ogni rete.
  I vecchi indirizzi (`app.quota120.com/prova`, `/q/prova/...`) portano lì.
- `/privacy` e `/condizioni`: informativa e condizioni d'uso, da accettare all'iscrizione.
- Gli avvisi programmati partono per ogni spazio (nella prova le email sono spente).

## Accessi (versione di prova)
Un solo indirizzo. Si sceglie «Admin» (codice di 4 cifre, nella prova 1234) oppure «Pilota»: il pilota scrive nome e cognome
e la sua matricola aziendale (maiuscole, spazi e accenti non contano; 5 tentativi sbagliati = 15 minuti di attesa).
L'elenco dei piloti non si vede mai. Il primo ingresso (Admin o pilota) prepara i dati di esempio (matricole di prova 0412, 0587, 0633).
Nella prova il telefono del pilota entra subito (non c'è un Admin vero che approva). Negli spazi veri resta «In attesa dell'Admin»
con un codice: l'Admin lo approva una volta sola (anche «Approva tutti») e da lì il pilota resta dentro. I piloti non hanno «Esci»: per fermarne uno l'Admin usa Blocca in Utenti e permessi.

## Aspetto
Ognuno sceglie la sua pagina iniziale col tasto Aspetto: Cabina (scura), Plancia (di base) o Flotta. La scelta resta
sulla persona, anche cambiando telefono. La modalità sole (contrasto massimo) resta sul singolo telefono.

## Permessi
L'Admin vede e cambia tutto e decide, pilota per pilota, cosa può vedere ogni operatore (scheda del pilota → Accesso e permessi).
Il server manda a ogni operatore solo quello che gli è concesso (`vista`) e, quando salva, prende solo i suoi voli e le sue
verifiche delle zone (`unisci`). I documenti di un operatore possono andare solo nella sua scheda.

## Documenti
PDF e foto fino a 10 MB, salvati a pezzi da 1 MB nel Durable Object. Con il segreto `ANTHROPIC_API_KEY` il server li fa leggere
a Claude (Sonnet) e propone tipo, dati e scheda di destinazione; senza la chiave si completano a mano.

## Prossimi passi
- Lettura automatica dei registri DJI (serve la chiave sviluppatore DJI, gratuita).
- PDF compilati per la domanda ENAC, etichette QR dell'inventario, documenti via email.

## Posizionamento dei siti (02/11/2026, anteprime 35-36 approvate)
- Archivio D1 a parte «posizionamento», binding **POS** nel gestionale DPD e nei pannelli di Verba Manent (/privato/posizionamento),
  Kennel Manager (/admin → Posizionamento), Quota 120 (/admin/pannello → Posizionamento), Punto Web Ferrara (/admin/posizionamento).
- Lo riempie solo il gestionale DPD (`functions/_pos.js`, `giro()` a pezzi): ogni lunedì `.github/workflows/posizionamento.yml` chiama
  `/api/public/pos-aggiorna` finché `finito:true`. Search Console con il collegamento Google del gestionale (vede tutte le proprietà
  di Paolo), DataForSEO SERP live fino alla 100ª posizione (tetto `POS_CAP` controlli al mese, predefinito 200), volumi delle parole nuove.
- Pannelli: `_pos-comune.js` / `pos-comune.js` = copia della parte «leggi/parola» di `_pos.js`; `pos-ui.js` = la scheda, uguale in tutti
  i repository: se cambia, copiarla in tutti. Senza POS il pannello dice «non ancora collegato».

## Sicurezza e dati (05/11/2026, anteprima 141 approvata)
Azienda › «Sicurezza e dati» (solo Admin), con sei righe (con «Impronta o viso», anteprima 143); in Home › «Da sistemare» una riga finché l'accordo non è accettato e una finché
la doppia verifica è spenta (non nella prova). Ogni parte ha la sua guida (parte solo se la avvii, o toccando la riga) e una lezione nello Studio.
- **Doppia verifica** (TOTP, RFC 6238: HMAC-SHA1, 6 cifre, 30 s, si accetta ±1 passo): QR `otpauth://` e chiave da scrivere a mano; un codice
  già usato non vale di nuovo (si tiene l'ultimo passo usato). 10 codici di riserva `XXXX-XXXX`, una volta sola, salvati come impronta SHA-256 con sale.
  Il segreto non torna mai al browser dopo l'attivazione; se c'è il segreto di Cloudflare **`SICUREZZA_CHIAVE`** (facoltativo) è salvato cifrato
  (AES-GCM). Attenzione: se poi si cambia o si toglie quella chiave, le doppie verifiche già attive non si leggono più (restano i codici di riserva).
  5 codici sbagliati per telefono = 15 minuti di attesa (al massimo 30 per spazio ogni 15 minuti).
  La chiede: all'ingresso da un telefono nuovo (il codice via email crea il telefono nello stato `2fa`, che entra solo con `/api/sic/entra`),
  prima di spegnerla, di rifare i codici di riserva e di scaricare tutti i dati. A ogni ingresso nuovo dell'Admin parte un'email di avviso.
- **«Ho perso telefono e codici»**: dalla pagina della doppia verifica, `/api/sic/perso` crea la richiesta (`sic:rip`): resta ferma 3 giorni,
  all'email dell'Admin arriva l'avviso con il tasto per bloccarla (`/api/sic/annulla`, pagina con un tasto: i controlli automatici delle email
  non la bloccano da soli). L'assistenza controlla visura camerale e documento (arrivano per email ad assistenza@quota120.com) e la chiude dal
  Pannello del titolare (quota120.com/admin › Operatori › scheda › Sicurezza), non prima dei 3 giorni.
- **Telefoni e computer dell'Admin**: esci da uno, da tutti gli altri (`/api/sic/esci-tutti`) o da questo.
- **Scarica tutti i dati** (`/api/sic/scarico`, solo Admin, con la doppia verifica se è attiva): zip con LEGGIMI.txt, un .xlsx (un foglio per
  elenco), `tabelle/*.csv` (UTF-8, punto e virgola), `tutto.json` e `documenti/<cartella>/`. Le tabelle si preparano subito, i documenti si
  aggiungono mentre si scarica (zip senza compressione, a pezzi). Link valido 24 ore (`/api/sic/scarico/file?op=…&t=…`), email con il link,
  ogni scarico nel registro (`sic:scar`).
- **Accordo sul trattamento dei dati (art. 28)**: versione nel codice (`ACC_VER` in src/index.js; il testo è in public/index.html, `SIC_ART`):
  se cambia il testo, alzare `ACC_VER` (e `SIC_ACC_DATA`/`SIC_ACC_CAMBI`) e l'Admin lo riaccetta. «Più tardi» = riquadro giallo.
- **Sicurezza in breve**: PDF di una pagina con lo stato vero; «Manda per email» passa da `/api/doc/invia` (stessi limiti).

### Impronta o viso: passkey dell'Admin (anteprima 143)
- Azienda › Sicurezza e dati › «Impronta o viso» (solo Admin, non va in «Da sistemare»). Aggiungere: con la doppia verifica se è attiva
  (`/api/sic/pk/nuova`), poi `navigator.credentials.create` (residentKey e userVerification «required», attestation «none», ES256 e RS256,
  excludeCredentials), poi `/api/sic/pk/salva`; il nome si cambia con `/api/sic/pk/nome`; togliere con `/api/sic/pk/togli` (doppia verifica se attiva).
  Al massimo 10 (`PK_MAX`); a ogni passkey aggiunta un'email di avviso all'Admin.
- Nello spazio: `pk:list` (ID della credenziale, chiave pubblica JWK, contatore, rpId, date), `pk:uid`, `pk:nuova` (sfida di 5 minuti).
  Nel registro: indice `pkc:<id>` → spazio (si aggiorna quando si aggiunge o si toglie) e le sfide d'ingresso `pks:<sfida>` (5 minuti, una volta sola).
- Ingresso senza email (discoverable credential): `/api/registro/pk-sfida`, poi `navigator.credentials.get`, poi `/api/registro/pk-entra`: il registro consuma la sfida e trova
  lo spazio; lo spazio (`/interno/pk-entra`) controlla origine (app.quota120.com, prova.quota120.com, localhost solo in locale), rpIdHash, UP, UV, firma
  (ECDSA P-256 con firma DER → raw, RSASSA-PKCS1-v1_5 SHA-256) e contatore, tutto con crypto.subtle e un CBOR minimo scritto qui.
  Poi è come dopo email + doppia verifica: stessa chiave di telefono, stesse regole dei 15 giorni, email di avviso. 5 errori per rete = 15 minuti.
  Nella prova si entra dal proprio contenitore (`/api/pk/sfida`, `/api/pk/entra`).
- «Esci da tutti» non tocca le passkey; il recupero «ho perso telefono e codici», chiuso dall'assistenza, le toglie tutte. Pannello del titolare ›
  Operatori › scheda › Sicurezza: quante sono e «Togli tutte le passkey». Il ripristino di una copia lascia le passkey di adesso.

### Dati nell'Unione europea (anteprima 142)
- Tutti i contenitori (`main`, `registro`, `op:<spazio>`, `copie:<spazio>`, `demo:<id>`) vivono nella zona **eu** di Cloudflare
  (`env.STATO.jurisdiction("eu")`, funzione `sto()` in src/index.js). Ogni chiamata nuova deve passare da `sto(env, nome)`.
- Trasloco (una volta sola, dal cron): `trasloco()` mette in attesa i nuovi, gira la strada (`eu:via` nel vecchio registro), chiude ogni vecchio
  contenitore, copia tutte le chiavi a pezzi e apre il nuovo. Durante il passaggio lo spazio risponde 503 «riprova tra un minuto».
  Se si ferma a metà, il cron dopo riprende da dove era. I vecchi contenitori si svuotano da soli dopo 7 giorni (`trasPulisci`);
  il vecchio registro tiene solo `eu:*` (serve a `euInit` per sapere che la strada è girata).
- In locale workerd non conosce le zone: con POSTA_FINTA la zona europea si imita con i nomi `eu|…`; `/interno/eu-confronta?n=<nome>`
  confronta vecchio e nuovo chiave per chiave.
- L'accordo sui dati è passato alla versione 2 (archivio e copie nell'Unione europea): gli Admin lo riaccettano.

### Copie di sicurezza
- Lo spazio è un Durable Object con archivio **SQLite** (`new_sqlite_classes` in wrangler.jsonc): la piattaforma permette il ripristino a un
  momento qualsiasi degli ultimi 30 giorni (Point-in-time recovery dei Durable Objects SQLite). In Quota 120 non c'è ancora un comando che lo usa.
- In più, **ogni giorno** (dal cron, una volta al giorno) ogni spazio fa una copia di tutti i suoi dati in un altro Durable Object, `copie:<spazio>`
  (stessa classe, nessuna configurazione da aggiungere): `cg:<giorno>` informazioni, `cv:<giorno>:<chiave>` i dati, `cd:`/`cdp:` i documenti
  salvati una volta sola. Si tengono 30 giorni: le copie più vecchie e i documenti che nessuna copia usa più si cancellano da soli.
  R2 non si usa: avrebbe chiesto di creare un bucket a mano in Cloudflare.
- Ripristino: Pannello del titolare › scheda dello spazio › «Ripristina questa copia». Prima si fa una copia di adesso
  («…-prima-del-ripristino-…»); telefoni, doppia verifica, accordo e registro degli scarichi restano quelli di adesso.
