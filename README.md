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
- `/prova` è la versione di prova con i dati di esempio e il codice Admin 1234 (era la pagina principale).
- `/privacy` e `/condizioni`: informativa e condizioni d'uso, da accettare all'iscrizione.
- Gli avvisi programmati partono per la prova e per ogni spazio.

## Accessi (versione di prova)
Un solo indirizzo. Si sceglie «Admin» (codice di 4 cifre, nella prova 1234) oppure «Pilota»: il pilota scrive nome e cognome
e la sua matricola aziendale (maiuscole, spazi e accenti non contano; 5 tentativi sbagliati = 15 minuti di attesa).
L'elenco dei piloti non si vede mai. Il primo ingresso dell'Admin prepara i dati di esempio (matricole di prova 0412, 0587, 0633).
Il telefono del pilota resta «In attesa dell'Admin» con un codice: l'Admin lo approva una volta sola (anche «Approva tutti»)
e da lì il pilota resta dentro. I piloti non hanno «Esci»: per fermarne uno l'Admin usa Blocca in Utenti e permessi.

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
