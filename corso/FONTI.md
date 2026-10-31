# Fonti dei videocorsi Quota 120

Questo file dice **da dove vengono** i dati scritti nei corsi (`src/corso_seed.json`) e **quando sono stati verificati**.
Lo usa il controllo settimanale automatico: rilegge le fonti, confronta con la tabella e, se qualcosa è cambiato,
prepara le correzioni su un ramo a parte e avvisa Paolo. Niente va su `main` senza il suo ok.

Come si aggiorna un corso: si cambiano lezioni/domande nel seme, si alza `rev` del corso (data AAAA-MM-GG).
Il programma sostituisce da solo il corso salvato con quello del seme quando `rev` è più nuovo; i video delle
lezioni cambiate li rifà GitHub la notte (o subito, facendo partire a mano «Video dei videocorsi»).

## Fonti

| # | Fonte | Indirizzo |
|---|---|---|
| F1 | ENAC, Come si diventa pilota UAS Open A1-A3 | https://www.enac.gov.it/sicurezza-aerea/droni/piloti-uas/ (pagina A1-A3) |
| F2 | ENAC, Come si diventa pilota UAS Open A2 | https://www.enac.gov.it/sicurezza-aerea/droni/piloti-uas/come-si-diventa-pilota-uas-drone-open-a2/ |
| F3 | ENAC, Scenari standard EASA | https://www.enac.gov.it/sicurezza-aerea/droni/categoria-specifica-specific-category/scenari-standard-easa/ |
| F4 | ENAC, Entità Riconosciute | https://www.enac.gov.it/sicurezza-aerea/droni/piloti-uas/entita-riconosciute/ |
| F5 | EASA, Easy Access Rules for UAS (Reg. UE 2019/947, Appendice 1: UAS.STS-01 / STS-02) | https://www.easa.europa.eu/en/document-library/easy-access-rules/online-publications/easy-access-rules-unmanned-aircraft-systems |
| F6 | ENAC, LG 2023/005-UAS (esami ed Entità Riconosciute) | https://www.enac.gov.it/sites/default/files/allegati/2023-Nov/LG%202023_005_uas_eD1_231103.pdf |
| F7 | D-Flight, novità e dichiarazioni | https://www.d-flight.it/ |

## Dati usati nei corsi (verificati il 31/10/2026)

| Corso | Dato | Valore nei corsi | Fonte |
|---|---|---|---|
| A1-A3 | Esame | 40 domande, 60 minuti, +2 giusta / 0 vuota / −1 sbagliata, si passa con 60/80 | F1 |
| A1-A3 | Costo e tentativi | 31 €, fino a 4 tentativi | F1 |
| A1-A3 | Validità | 5 anni | F1 |
| A2 | Requisiti | attestato A1-A3 da almeno 15 giorni, autoaddestramento dichiarato, esame | F2 |
| A2 | Esame | 30 domande, 60 minuti, +2 giusta / 0 sbagliata o vuota, si passa con 45/60 (75%) | F2 |
| A2 | Dove | presso un'Entità Riconosciuta, sorvegliato e videoregistrato | F2 |
| A2 | Costo e tentativi | 31 €, 5 tentativi; poi 15 giorni di attesa e nuovo pagamento | F2 |
| A2 | Validità | 5 anni | F2 |
| A2 | Regole di volo | C2 fino a 4 kg; 30 m dalle persone non coinvolte, 5 m in modalità bassa velocità (3 m/s); mai sopra | Reg. UE 2019/947 |
| STS | Applicabilità | STS-01 e STS-02 dal 1° gennaio 2024 | F3 |
| STS | Dichiarazione operativa | su D-Flight, vale 2 anni, 114 € (tariffa R66-1) | F3 |
| STS | Esame teorico | almeno 40 domande su 8 materie (30 su 5 per chi ha l'A2), si passa con il 75%, presso Entità Riconosciuta | F5, F6 |
| STS | Tempo dell'esame | **non indicato dalle fonti**: nella simulazione 60 minuti come allenamento | — |
| STS | Validità | certificato teorico 5 anni; accreditamento pratico senza scadenza | F6 |
| STS-01 | Condizioni | VLOS; area di terra controllata; contingenza ≥ 10 m; velocità al suolo < 5 m/s; 120 m; volume ≤ 30 m sopra; C5 con Remote ID; niente merci pericolose | F5 |
| STS-01 | Buffer minimo | 30 m: 10/20 m · 60 m: 15/30 m · 90 m: 20/45 m · 120 m: 25/60 m (fino a 10 kg / oltre 10 kg) | F5 |
| STS-02 | Condizioni | BVLOS; zona scarsamente popolata; visibilità > 5 km; 1 km senza osservatori (traiettoria preprogrammata), 2 km con osservatori (≤ 1 km dal più vicino, ognuno ≤ 1 km dal pilota); decollo e atterraggio a vista; C6 con sistema anti-uscita e Remote ID | F5 |

## Guide del sito (quota120.com/guide/)

Le guide si scrivono in `strumenti/guide/g_*.py` (una per file) e si rigenerano con
`python3 strumenti/guide/genera_guide.py public/sito`. Quando cambia un dato, si corregge il file della guida,
si aggiornano `data` (AAAA-MM-GG) e `data_it` («31 ottobre 2026») e si rigenera.

| Guida | Dato | Valore scritto | Fonte |
|---|---|---|---|
| d-flight | Tariffe 2026 | Base 7 €/anno, PRO 28 €/anno, QR drone Base 7 €, QR PRO 112 € (IVA compresa; 5,74 / 22,95 / 5,74 / 91,80 + IVA) | D-Flight, Condizioni generali ed. 4.0.0 del 15/01/2026 |
| d-flight | Chi si registra | drone ≥ 250 g, o < 250 g con fotocamera (non giocattolo); specifica con PRO | Reg. UE 2019/947 art. 14; condizioni D-Flight |
| mappa-d-flight | Zone e quote | rosso da 0 m (niente OPEN); ostacoli 50 m / +5 m (rosse 10 m / 3 m); bozza nuovo regolamento: 0/40/60/80 m | ENAC zone geografiche (agg. 05/02/2026); modifica §6.4 ATM-09A; bozza ENAC 24/06/2026 |
| notam-droni | Dove e costi | servizio pre-volo ENAV; NOTAM con diritti ENAC per le riserve | ENAC riserva di spazio aereo (agg. 15/11/2022) |
| atm-09 | Anticipo | 35 giorni (ENAV/civile), 60 giorni (Aeronautica Militare), copia a DT ENAC | ENAC riserva di spazio aereo |
| assicurazione-drone | Obbligo | art. 27 UAS-IT ed. 1/2021; massimale tabella Reg. CE 785/2004 (~800.000 € mezzi leggeri) | ENAC normativa droni; testo art. 27 citato da Regione Piemonte (BUR 49/2025) |
| patentino-drone | Esami | A1-A3 40 domande/60 min/60 su 80/31 €/4 tentativi; A2 30/60 min/45 su 60/31 €/5 tentativi; STS 40 (30 con A2), 75% | ENAC pagine A1-A3 e A2 (agg. 15/05/2024); scenari standard (agg. 17/12/2025) |
| quaderno-di-campagna-digitale | Scadenza | formato elettronico entro 31/12/2026; conservazione 3 anni | Reg. UE 2023/564, 2025/2203; D.M. 30/12/2025 (GU 23/04/2026) |
| drone-agricolo | Irrorazione | vietata salvo prove autorizzate; sperimentazione L. 182/2025 art. 13-bis in attesa del decreto attuativo | Min. Salute (05/12/2025); **controllare se esce il decreto** |
| codice-operatore-uas | Remote ID | obbligatorio dal 1/1/2024 per C1-C3 e in specifica; codice 16 + 3 segreti | ENAC FAQ (16/05/2024); EASA |
| segnalazione-incidenti-drone | Termini | 72 ore su ECCAIRS 2; ANSV entro 60 minuti; Reg. UE 2026/1821 dal 17/08/2026 | ENAC SPL-21 Rev. 1 (settembre 2026) |

## Regole del «Nuovo lavoro» nel programma (public/index.html, tabelle `VD` e `VP`)

Le regole che il programma mostra all'Admin e al pilota (passi «Dove si vola?» e «Perché si vola?»). Se cambiano, si correggono `VD`/`VP` e questa tabella.

| Dato | Valore nel programma | Fonte |
|---|---|---|
| A1 | C0 e senza classe sotto 250 g: anche sopra estranei, mai sopra la folla; nessun attestato (solo registrazione operatore se ha la fotocamera). C1: non sopra estranei; attestato A1-A3 | EASA Open category (node 119320); ENAC requisiti categoria aperta |
| A2 | C2: 30 m dagli estranei, 5 m in velocità lenta; attestato A2 | EASA Open category |
| A3 | C2, C3, C4, senza classe fino a 25 kg: 150 m da aree residenziali, commerciali, industriali, ricreative; nessun estraneo; attestato A1-A3 | EASA Open category |
| Generale | 120 m da terra; sempre a vista; senza classe ammessi solo se comprati entro il 31/12/2023 | EASA; ENAC |
| STS-01 / STS-02 | C5 in area chiusa al pubblico (anche zona abitata), a vista / C6 oltre la vista in zona poco abitata; esame STS e pratica; dichiarazione su D-Flight | F3, F5 |
| Semina e concime | categoria specifica con autorizzazione ENAC (percorso semplificato droni agricoli, AltMoC IT-UAS-2026-002) | ENAC 14/08/2026 |
| Trattamenti fitosanitari | solo sperimentazioni autorizzate; decreto L. 182/2025 non ancora uscito (agosto 2026): **controllare se esce** | Commissione Agricoltura Senato 04/08/2026 |
