'use strict';

// Sursele de flux, pe canal.
// ---------------------------------------------------------------------------
// Cheia este slugul canalului (id-ul fără prefixul "raultv-").
// Fiecare canal poate avea mai multe surse; ele apar în Stremio ca
// „Server 1", „Server 2" și așa mai departe, în ordinea de aici.
//
// Câmpuri:
//   url       obligatoriu — adresa fluxului HLS (.m3u8)
//   eticheta  opțional  — cum apare în lista Stremio (implicit „Server N")
//   referer   opțional  — dacă CDN-ul cere antetul Referer. Când e setat,
//                         serverul retransmite fluxul în loc să redirecteze,
//                         fiindcă un redirect nu poate impune un antet.
//   nota      opțional  — comentariu pentru tine, nu ajunge la utilizator
//
// Poți adăuga o sursă și fără să atingi fișierul acesta, din Render →
// Environment: RAULTV_<SLUG>_URL. Sursa din variabila de mediu are prioritate.
//
// Canalele care NU apar aici nu rămân goale: la apăsarea pe play, serverul
// caută fluxul public pe pagina oficială a postului. Vezi lib/resolver.js.
//
// Folosește numai fluxuri pe care ai dreptul să le folosești și să le distribui.
// ---------------------------------------------------------------------------

const SURSE = {
  // Confirmate pe 3 septembrie 2026, găsite pe paginile oficiale ale posturilor.
  'aleph-news': [
    { url: 'https://streamb.m.ro/Aleph/Alephnew2.stream/playlist.m3u8' }
  ],
  'nasul-tv': [
    { url: 'https://live.nasul.tv/live/stream.m3u8' }
  ],
  'atomic-tv': [
    { url: 'https://atomic.streamnet.ro/atomictv.m3u8' }
  ]

  // Fluxurile moștenite din v2 au fost scoase pentru că nu mai răspund:
  //   prima-tv    stream1.1616.ro/prima    HTTP 404
  //   look-sport  stream1.1616.ro/look     HTTP 403
  //   tvr-1, tvr-2  mn-nl.mncdn.com        gazda nu răspunde
  // Fără ele, canalele intră pe rezolvarea automată din pagina oficială.
  // Dacă găsești adrese noi care merg, adaugă-le aici sau în canale.m3u.
};

module.exports = { SURSE };
