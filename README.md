# Quota 120 (prova)

Gestionale per operatori di droni in Italia: controllo prima del volo, registro voli, droni e batterie, piloti e attestati,
autorizzazioni ENAC, D-Flight, clienti e preventivi, manutenzioni, inventario, campi e trattamenti, documenti.
I dati di esempio sono inventati.

- `public/index.html` – l'app (Admin e operatori), installabile sul telefono dalla schermata Home.
- `src/index.js` – Worker: serve i file di `public` e le API `/api/*`; i dati e i documenti stanno in un Durable Object (SQLite), niente database da creare.
- `wrangler.jsonc` – configurazione: Cloudflare la usa da sola con «npx wrangler deploy» a ogni push.

## Accessi
Un solo indirizzo. Si sceglie «Admin» (codice di 4 cifre, nella prova 1234) oppure «Operatore» con il proprio nome.
Il primo ingresso dell'Admin prepara i dati di esempio. Il telefono di un operatore resta «In attesa dell'Admin» con un codice:
l'Admin lo approva in Piloti → Telefoni e computer collegati (o dalla voce in «Da sistemare»).

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
