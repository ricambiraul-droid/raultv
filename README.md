# RaulTV v15.6 FULL TiviOne

Stremio addon cu 3 zone separate:
- 📺 Live TV (RaulTV public + TiviOne RO/IT)
- 🎬 TiviOne Filme / VOD
- 📺 TiviOne Seriale

## Render Environment
Setează numai în Render, NU în GitHub:
- `TIVIONE_XTREAM_SERVER`
- `TIVIONE_XTREAM_USERNAME`
- `TIVIONE_XTREAM_PASSWORD`
- `TIVIONE_COUNTRIES=ro,it`

## SAFE single-playback
Catalogul citește doar metadate Xtream. Nu face probe HEAD/GET pe video și nu pornește streamuri în fundal. URL-ul video este furnizat către Stremio doar când utilizatorul pornește un canal, film sau episod.

## Cataloage Stremio
- RaulTV • Toate
- RaulTV • România
- RaulTV • Italia
- TiviOne • Filme
- TiviOne • Seriale

Filmele și serialele au paginare prin `skip` (100 elemente/pagină) și căutare.

Manifest: `/manifest.json`
Diagnostic: `/tivione-status`
