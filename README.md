# RaulTV v14 — Stremio TV

Îmbunătățiri față de v13:
- verifică URL-urile înainte ca un canal să fie afișat;
- canalele fără niciun server online sunt ascunse;
- citește HLS master playlist și detectează rezoluția, FPS și bitrate;
- pentru master HLS selectează varianta cu cea mai bună calitate declarată;
- ordonează serverele după rezoluție > FPS > bitrate > prioritatea sursei;
- fallback Server 1 / Server 2 / ...;
- folosește `group-title` și `#EXTGRP`, apoi reguli locale pentru categorii;
- categorii: Toate, Știri, Sport, Documentare, Copii, Muzică, Locale, General;
- căutare în catalogul „Toate”;
- eliminare duplicate;
- cache 10 minute;
- verificări concurente pentru a reduce timpul de încărcare.

Sursele incluse sunt playlist-uri publice:
- hmlendea/iptv-playlist `ro.m3u`
- iptv-org România

Nu sunt incluse tokenuri, DRM, autentificări sau mecanisme de ocolire.

## Pornire
1. Instalează Node.js 18+.
2. Deschide terminalul în folder.
3. `npm install`
4. `npm start`
5. Adaugă în Stremio: `http://127.0.0.1:7000/manifest.json`

Pentru Stremio pe Smart TV, găzduiește addon-ul la o adresă HTTPS accesibilă televizorului.
