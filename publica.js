// Publica addonul in lista de Community Addons din Stremio.
// Rulezi: node publica.js
// Precondtie: addonul trebuie sa fie DEJA gazduit public si accesibil.

const URL = process.env.PUBLIC_URL;
const ID  = process.env.ADDON_ID || "org.raultv.iptv.v104";

function opreste(mesaj){ console.error("\n  OPRIT: "+mesaj+"\n"); process.exit(1); }

console.log("\n=== Publicare RaulTV in Community Addons ===\n");

if(!URL) opreste(
 "PUBLIC_URL nu e setat.\n"+
 "  Addonul trebuie sa fie gazduit public inainte de publicare.\n"+
 "  Exemplu: set PUBLIC_URL=https://raultv-xxxx.onrender.com");

if(/127\.0\.0\.1|localhost|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./.test(URL)) opreste(
 `PUBLIC_URL este o adresa locala: ${URL}\n`+
 "  Serverul Stremio nu o poate accesa. Ai nevoie de gazduire publica.\n"+
 "  Vezi GAZDUIRE.txt, nivelul 3.");

if(!URL.startsWith("https://")) opreste(
 `PUBLIC_URL nu e https: ${URL}\n`+
 "  Publicarea cere https. Aproape toate serviciile de gazduire il ofera gratuit.");

if(/\.v\d+$|\d\d$/.test(ID)) opreste(
 `ID-ul contine un numar de versiune: ${ID}\n`+
 "  ID-ul e identitatea PERMANENTA a addonului. Daca il schimbi dupa\n"+
 "  publicare, Stremio il vede ca pe un addon complet nou si toti\n"+
 "  utilizatorii il pierd.\n\n"+
 "  Seteaza unul curat, fara versiune, INAINTE de publicare:\n"+
 "     set ADDON_ID=org.raultv.iptv\n\n"+
 "  Atentie: schimbarea ID-ului iti cere si tie sa reinstalezi addonul.");

// SDK-ul se incarca abia acum, dupa verificari, ca sa vezi mesajele clare
// chiar daca dependintele nu sunt instalate.
let publishToCentral;
try{ ({ publishToCentral } = require("stremio-addon-sdk")); }
catch(e){ opreste("stremio-addon-sdk nu e instalat. Ruleaza intai: npm install"); }

const manifestUrl = `${URL.replace(/\/$/,"")}/manifest.json`;
console.log("  ID:       "+ID);
console.log("  Manifest: "+manifestUrl);
console.log("\n  Trimit catre serverul central Stremio...\n");

publishToCentral(manifestUrl)
 .then(()=>{
   console.log("  Trimis cu succes.\n");
   console.log("  Verifica peste cateva minute in:");
   console.log("     https://api.strem.io/addonscollection.json");
   console.log("  Apoi in Stremio: Addons -> Community Addons.\n");
   console.log("  Daca nu apare, vezi PUBLICARE.txt, sectiunea cu problemele cunoscute.\n");
 })
 .catch(e=>{
   console.error("  Esuat: "+(e&&e.message||e));
   console.error("\n  Cauze frecvente:");
   console.error("   - adresa nu e accesibila din exterior (testeaz-o dintr-un browser pe telefon, pe date mobile)");
   console.error("   - serviciul de gazduire dormea si nu a raspuns la timp; mai incearca");
   console.error("   - 'too many addons published' - limitare a serverului central, reincearca mai tarziu\n");
   process.exit(1);
 });
