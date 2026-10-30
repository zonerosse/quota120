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
