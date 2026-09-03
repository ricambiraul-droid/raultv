# RaulTV România — addon Stremio v3.0

**201 televiziuni românești** în **13 rubrici**, cu postere generate pe server, gândite
pentru afișare pe Smart TV. Server HTTP fără nicio dependență externă — doar Node.js.

```
npm test     # 17 teste
npm start    # http://localhost:7000/manifest.json
```

## Ce e nou față de v2.1

### 1. Catalog complet: 201 posturi

| Rubrică | Canale |
|---|---|
| Generaliste | 22 |
| Știri | 14 |
| Sport | 16 |
| Filme | 8 |
| Divertisment | 5 |
| Documentare | 7 |
| Lifestyle | 4 |
| Muzică | 22 |
| Copii | 4 |
| Cultură | 2 |
| Religioase | 7 |
| Tematice | 7 |
| Regionale | 83 |

Lista trăiește în `channels.js`, separat de logica serverului. Ca să adaugi un post,
adaugi un rând — nu atingi nimic altceva.

### 2. Grafică pentru Smart TV: postere PNG generate pe server

**Problema din v2.1:** posterele erau SVG. Stremio pe Android TV și pe majoritatea
televizoarelor folosește biblioteci de imagini care **nu randează SVG** — pe TV grila
apărea goală, deși în browser arăta bine.

**Soluția:** un generator PNG scris de la zero, fără dependențe (`lib/`):

- `lib/font.js` — font vectorial geometric cu majuscule, cifre și diacriticele
  românești (Ă Â Î Ș Ț), cu conturile curbe netezite prin spline Catmull-Rom.
- `lib/canvas.js` — desen cu anti-aliasing prin acoperire: degradeuri, colțuri
  rotunjite, cercuri, linii groase cu capete rotunde.
- `lib/png.js` — encoder PNG (RGB, filtru Sub, deflate din `zlib`).
- `lib/poster.js` — designul propriu-zis.

Fiecare poster are: degrade pe culoarea rubricii, textură diagonală discretă, ramă de
accent, insignă **LIVE**, numele pe 1–3 rânduri echilibrate automat și eticheta rubricii.
Fiecare dintre cele 13 rubrici are propria paletă, ca grila să fie ușor de scanat vizual.

Rute de imagine:

| Rută | Dimensiune | Folosită pentru |
|---|---|---|
| `/poster/<id>.png` | 512×512 | grila din Stremio |
| `/background/<id>.png` | 1024×576 | fundalul paginii de canal |
| `/logo.png` | 512×512 | sigla addonului |

**Performanță.** Fundalul unui poster depinde doar de rubrică, nu de canal, așa că se
desenează o singură dată per rubrică și apoi se copiază: ~33 ms per poster în loc de
~350 ms. Filtrarea PNG adaptivă (205 ms) a fost înlocuită cu filtrul Sub (6 ms), care dă
practic aceeași compresie pe degradeuri. Posterele se memorează într-un cache LRU și se
pregătesc în fundal la pornire, în pași de 40 ms, ca să nu blocheze primele cereri.

### 3. Rubrici pe genuri funcționale

- Câte un catalog dedicat per rubrică: `/catalog/tv/raultv-sport.json` etc.
- Catalogul principal declară `genres` + `extra: genre`, deci Stremio afișează
  **selectorul de gen** direct în interfață.
- Căutare care ignoră diacriticele în ambele sensuri: `brasov` găsește „Brașov TV”,
  `romania` găsește „România TV”.
- Paginare prin `skip`, câte 100 pe pagină.
- Ordonare: canalele cu flux configurat apar primele, restul alfabetic după reguli
  românești (`Intl.Collator('ro')`).

## Rute

| Rută | Descriere |
|---|---|
| `/manifest.json` | Manifestul addonului |
| `/catalog/tv/raultv-toate.json` | Toate canalele |
| `/catalog/tv/raultv-toate/genre=Sport.json` | Filtru pe rubrică |
| `/catalog/tv/raultv-toate/search=digi.json` | Căutare |
| `/catalog/tv/raultv-toate/skip=100.json` | Pagina următoare |
| `/catalog/tv/raultv-<rubrica>.json` | Catalog dedicat unei rubrici |
| `/meta/tv/<id>.json` | Detalii canal |
| `/stream/tv/<id>.json` | Flux live sau link oficial |
| `/poster/<id>.png`, `/background/<id>.png`, `/logo.png` | Grafică |
| `/health` | Stare, număr de canale, postere în cache |
| `/` | Pagină de instalare cu lista rubricilor |

## Configurarea fluxurilor

Implicit au flux: **Prima TV, Look Sport, TVR 1, TVR 2**. Restul deschid pagina oficială
până când configurezi un URL.

În Render → **Environment**:

```
RAULTV_<SLUG>_URL = https://…/playlist.m3u8
```

Slugul e id-ul canalului fără prefixul `raultv-`, cu majuscule și `_` în loc de `-`:

| Canal | Variabilă |
|---|---|
| PRO TV | `RAULTV_PRO_TV_URL` |
| Antena 1 | `RAULTV_ANTENA_1_URL` |
| Digi Sport 1 | `RAULTV_DIGI_SPORT_1_URL` |
| Prima TV (suprascrie implicitul) | `RAULTV_PRIMA_TV_URL` |

Numele vechi pentru canalele DIGI (`DIGI_24_URL`, `DIGI_SPORT_1_URL`, …) funcționează în
continuare, ca să nu pierzi setările din v2.

`/health` îți spune oricând câte canale au flux configurat.

> Folosește **numai** URL-uri HLS pe care ai dreptul să le folosești și să le distribui.
> Datele de autentificare nu se pun niciodată în cod sau pe GitHub.

## Publicare pe Render

1. Încarcă folderul într-un repository GitHub.
2. Render: **New + → Blueprint**, alege repository-ul. `render.yaml` e citit automat.
3. Instalează în Stremio adresa HTTPS terminată cu `/manifest.json`.

Pe televizor: instalează addonul întâi în același cont Stremio de pe telefon sau PC, apoi
sincronizează addonurile în aplicația de pe TV.

> Planul **free** de Render adoarme serviciul după ~15 minute de inactivitate. Prima
> deschidere poate dura 30–60 de secunde, timp în care se pregătesc și posterele.
> Dacă vrei generare mai rapidă, pune `RAULTV_POSTER_SIZE=384`.

## Structura

```
server.js        rutare HTTP, manifest, cataloage, meta, stream
channels.js      lista celor 201 posturi + paleta și ordinea rubricilor
lib/font.js      font vectorial cu diacritice românești
lib/canvas.js    desen cu anti-aliasing
lib/png.js       encoder PNG
lib/poster.js    designul posterelor, cu cache pe rubrică
test.js          17 teste
```

## Notă

Fluxurile live externe se pot modifica, opri sau limita geografic. Disponibilitatea celor
patru fluxuri implicite nu a putut fi verificată din mediul de dezvoltare (fără acces la
rețeaua publică) — verifică-le după publicare, în Stremio.
