# RaulTV v14.1 — Stremio Smart TV

Corecții:
- catalogul NU mai este golit dacă verificarea unui stream dă timeout;
- toate canalele găsite cu cel puțin un URL în playlist rămân în catalog;
- sursele duplicate sunt grupate ca Server 1 / Server 2 / ...;
- categorii și căutare;
- cache 10 minute;
- pregătit pentru deployment HTTPS pe Render sau alt host Node.js.

## Test PC
npm install
npm start

Manifest:
http://127.0.0.1:7000/manifest.json

## Smart TV
`127.0.0.1` NU trebuie folosit pe televizor. Publică proiectul pe un host HTTPS și instalează:
https://NUMELE-SERVICIULUI/manifest.json

Surse publice configurate:
- hmlendea/iptv-playlist
- iptv-org România
