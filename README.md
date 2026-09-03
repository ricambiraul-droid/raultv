# RaulTV România — addon Stremio v3.5

**201 televiziuni românești** în **13 rubrici**, cu postere generate pe server, gândite
pentru afișare pe Smart TV. Server HTTP fără nicio dependență externă — doar Node.js.

```
npm test     # 28 teste
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

## Fluxuri: mai multe servere și mai multe rezoluții

### Cum ajunge fluxul la tine

Implicit, modul e **direct**: în listă apare adresa reală a sursei, iar playerul o
deschide fără niciun hop prin addon. E cel mai robust cu playerele de pe
televizor, care nu tratează toate redirectul la fel.

```
RAULTV_MOD_FLUX = direct   (implicit)
RAULTV_MOD_FLUX = server
```

În modul **server**, fiecare canal primește o adresă pe serverul tău:

```
https://raultv.onrender.com/live/raultv-pro-tv.m3u8?sursa=0
```

Serverul rezolvă și **redirectează** (302) către sursă. Util când vrei să schimbi
o sursă fără să reinstalezi addonul; video-ul tot curge direct de la CDN.

Serverul nu retransmite niciodată fluxul, în niciun mod. Dacă ar face-o:

- cererea ar pleca din Frankfurt, unde e găzduit Render, nu din România — și
  posturile restricționate geografic ar începe să pice exact invers decât vrei;
- planul free ar ceda la primul flux HD, care înseamnă 3–5 Mbit/s continuu.

Singura excepție: sursele care declară un `referer` în `surse.js`. Un redirect nu
poate impune un antet, deci pentru ele se folosește `behaviorHints.proxyHeaders`,
care spune playerului Stremio ce antete să trimită.

### Servere numerotate

Fiecare sursă a unui canal apare ca `Server 1`, `Server 2`, `Server 3`, în ordinea
din `surse.js`. Dacă unul e mort, alegi altul din listă fără să ieși din canal.

### Rezoluții separate în listă

La deschiderea unui canal, serverul citește playlistul master al sursei și scoate
fiecare calitate ca opțiune de sine stătătoare:

```
Prima TV • Prin server • Auto      ← playerul alege singur
Prima TV • Prin server • 1080p HD
Prima TV • Prin server • 720p
Prima TV • Prin server • 480p
Prima TV • Deschide pagina oficială
```

Rezultatul e memorat cinci minute, deci nu se cere playlistul la fiecare
deschidere. Dacă sursa nu răspunde în 3,5 secunde, rămâne doar varianta Auto —
lista nu se blochează niciodată.

### Mai multe surse pentru același post

Un canal poate avea oricâte surse. Prima e cea principală, restul apar ca
`Sursă 2`, `Sursă 3` și așa mai departe. Le pui în `surse.js`:

```js
'pro-tv': [
  { url: 'https://...principal.m3u8' },
  { url: 'https://...rezerva.m3u8', eticheta: 'Sursă de rezervă' },
  { url: 'https://...cu-referer.m3u8', referer: 'https://www.protv.ro/' }
]
```

sau, fără să atingi codul, în Render → Environment (mai multe, separate prin virgulă):

```
RAULTV_PRO_TV_URL = https://a.m3u8, https://b.m3u8
```

### Canalele fără sursă

Rămân exact cum erau: o singură opțiune, **live link către pagina oficială**.
Nimic nu se strică și nu apare niciun flux mort în listă.

## Playlisturi

Implicit, serverul încarcă la pornire indexul public **iptv-org**, proiectul
open-source care adună fluxurile TV accesibile liber:

```

https://iptv-org.github.io/iptv/countries/ro.m3u
https://iptv-org.github.io/iptv/languages/ron.m3u
```

Cele trei se descarcă în paralel, se combină, se scot duplicatele și se
potrivesc cu cele 201 posturi din catalog. Lista se reîmprospătează din oră în oră.

Schimbi sursele din Render → Environment:

```
RAULTV_M3U_URL = https://furnizorul-tau/playlist.m3u          o singură adresă
RAULTV_M3U_URL = https://a/p.m3u, https://b/p.m3u             mai multe
RAULTV_M3U_URL = off                                          doar canale.m3u local
```

Un fișier `canale.m3u` pus lângă `server.js` e citit întotdeauna, chiar și pe `off`.
E lista ta, scrisă de mână, și are prioritate față de playlisturile publice.

### Cum se face potrivirea

Trei încercări, în ordine:

1. **`tvg-id`** — identificatorul standardizat, cel mai sigur. `TVR1.ro@SD` se
   desface în „TVR 1", `AtomicTV.ro` în „Atomic TV", `RealitateaPlus.ro` în
   „Realitatea Plus".
2. **Numele afișat**, cu diacriticele și sufixele de calitate ignorate.
3. **Numele fără spații**, ca „A7TV" să prindă „A7 TV".

Posturile care nu există în catalog sunt ignorate, nu creează canale noi.

### Două capcane rezolvate

Liniile `#EXTINF` din iptv-org conțin un `http-user-agent` cu virgule în el —
`(KHTML, like Gecko)`. Numele se ia după **ultima** virgulă, nu prima; altfel
jumătate din catalog se numește „like Gecko) Chrome/130...".

Unele fluxuri cer antete `http-referrer` și `http-user-agent`, date fie ca
atribute pe linia `#EXTINF`, fie pe linii `#EXTVLCOPT` dedesubt. Ambele forme
sunt citite, iar antetele ajung la player prin `behaviorHints.proxyHeaders`.

Calitatea scrisă în nume — `Atomic TV (360p)` — devine eticheta serverului.
Starea importului o vezi la `/health`.

## Verificarea fluxurilor

Deschide `/verifica` și apasă butonul. Pagina testează fiecare sursă **din
browserul tău**, nu de pe server, și arată pentru fiecare canal dacă merge și ce
rezoluții oferă.

De ce din browser: serverul e în Frankfurt. Un test făcut de el ar spune „nu
merge" pentru posturi care de fapt merg perfect de pe conexiunea ta din România.

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
| `/live/<id>.m3u8` | Fluxul, prin server (302 către sursă) |
| `/live/<id>.m3u8?sursa=1` | A doua sursă a canalului |
| `/live/<id>.m3u8?rez=0` | O rezoluție anume |
| `/verifica` | Testează fluxurile din browserul tău |
| `/surse.json` | Lista surselor configurate |
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
server.js        rutare HTTP, manifest, cataloage, meta, stream, fluxuri
channels.js      lista celor 201 posturi + paleta și ordinea rubricilor
surse.js         sursele de flux, pe canal — aici adaugi linkuri
lib/live.js      rezolvarea surselor, rezoluțiile, retransmisia HLS
lib/m3u.js       importul playlistului și potrivirea după nume
lib/font.js      font vectorial cu diacritice românești
lib/canvas.js    desen cu anti-aliasing
lib/png.js       encoder PNG
lib/poster.js    designul posterelor, cu cache pe rubrică
test.js          28 teste
```

## Notă

Fluxurile live externe se pot modifica, opri sau limita geografic. Disponibilitatea celor
patru fluxuri implicite nu a putut fi verificată din mediul de dezvoltare (fără acces la
rețeaua publică) — verifică-le după publicare, în Stremio.
