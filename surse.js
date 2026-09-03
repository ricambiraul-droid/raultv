'use strict';

// Sursele de flux, pe canal.
// ---------------------------------------------------------------------------
// Cheia este slugul canalului (id-ul fără prefixul "raultv-").
// Fiecare canal poate avea mai multe surse; serverul o folosește pe prima și
// le oferă pe celelalte ca variante de rezervă în lista din Stremio.
//
// Câmpuri:
//   url       obligatoriu — adresa fluxului HLS (.m3u8)
//   eticheta  opțional  — cum apare în lista Stremio (implicit "Prin server")
//   referer   opțional  — dacă CDN-ul cere antetul Referer. Când e setat,
//                         serverul retransmite fluxul în loc să redirecteze,
//                         fiindcă un redirect nu poate impune un antet.
//   nota      opțional  — comentariu pentru tine, nu ajunge la utilizator
//
// Poți adăuga o sursă și fără să atingi fișierul acesta, din Render →
// Environment: RAULTV_<SLUG>_URL. Sursa din variabila de mediu are prioritate.
//
// Folosește numai fluxuri pe care ai dreptul să le folosești și să le distribui.
// ---------------------------------------------------------------------------

const SURSE = {
  'prima-tv': [
    { url: 'https://stream1.1616.ro:1945/prima/livestream/playlist.m3u8' }
  ],
  'look-sport': [
    { url: 'https://stream1.1616.ro:1945/look/livestream/playlist.m3u8' }
  ],
  'tvr-1': [
    { url: 'https://mn-nl.mncdn.com/tvr1_test/smil:tvr1_test.smil/playlist.m3u8' }
  ],
  'tvr-2': [
    { url: 'https://mn-nl.mncdn.com/tvr2_test/smil:tvr2_test.smil/playlist.m3u8' }
  ]
};

module.exports = { SURSE };
