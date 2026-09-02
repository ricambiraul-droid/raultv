RAULTV BEE DOOM — v14.0

Addon Stremio pentru posturi TV din Romania si Italia, construit din
liste publice gratuite (iptv-org, Free-TV, hmlendea).

Documentul asta descrie starea REALA a versiunii curente.
Pentru cum a ajuns aici, vezi ISTORIC.txt.

===========================================================
PORNIRE RAPIDA
===========================================================
  1. Dezarhiveaza (nu rula BAT-ul din interiorul arhivei)
  2. PORNESTE-RAULTV.bat
  3. In Stremio: Addons -> lipesti adresa scrisa in fereastra neagra

Detalii complete: INSTALARE.txt

===========================================================
CE FACE
===========================================================
- Sapte randuri in catalog: România, Italia, Știri, Sport, Filme, Muzică, Regional
- Filtrare pe gen: Stiri, Sport, Filme, Documentare, Muzica etc.
- Canalele ordonate dupa AUDIENTA pe tara, cele mai vizionate primele
- Mai multe servere per canal, cand sursele au linkuri distincte
- Marcheaza serverele geo-restrictionate, ca sa stii ce sa nu incerci
- Poti adauga serverele tale, care nu se pierd la actualizare

===========================================================
DOUA MODURI DE FUNCTIONARE
===========================================================
MOD=simplu   (IMPLICIT, recomandat)
  Linkul merge direct la playerul Stremio, ca la addonurile de Kodi.
  Zero cereri de retea la deschiderea canalului. Playerul se ocupa de
  HLS si alege singur calitatea.
  Rapid. Subtitrarile si pistele audio ajung intacte la player.

MOD=proxy    (optional, in .env)
  Tot traficul trece prin serverul local. Iti da in plus:
    - fiecare rezolutie ca server separat (1080p / 720p / 480p)
    - failover automat cand un server e mort
    - reincercarea segmentelor la intreruperi scurte
  Dar e sensibil mai greu si poate bloca pe internet slab.
  Nu poate fi gazduit public - are nevoie de serverul tau.

Comuti intre ele doar repornind serverul.

===========================================================
FISIERE PE CARE LE POTI EDITA
===========================================================
canale.m3u    Serverele tale proprii. Au prioritate fata de sursele
              publice. Daca folosesti acelasi tvg-id ca ele, linkul tau
              se adauga la canalul existent in loc sa creeze unul nou.

rating.json   Ordinea canalelor in lista. Cifrele sunt audiente Kantar
              Media, iulie 2026. Poti pune si valori proprii - conteaza
              doar ordinea relativa.

.env          Toate setarile. Copiaza .env.example si redenumeste in .env.

Toate trei sunt salvate automat inainte de o actualizare, ca .salvat.

===========================================================
UNELTE DIN PACHET
===========================================================
PORNESTE-RAULTV.bat      pornire normala
PORNESTE-PENTRU-TV.bat   pornire vizibila in reteaua locala (TV, telefon)
TESTEAZA-LINKURI.bat     testeaza linkurile din canale.m3u si zice care traiesc
SCANEAZA-CALITATE.bat    citeste rezolutia REALA a tuturor canalelor, gaseste HD-ul
PUBLICA-ADDON.bat        publica addonul in Community Addons (cere gazduire)
PORNESTE-DIAGNOSTIC.bat  pornire cu informatii suplimentare

===========================================================
GHIDURI
===========================================================
INSTALARE.txt   instalare pas cu pas, si ce sa faci cand ceva nu merge
GAZDUIRE.txt    cum sa mearga pe TV, si cum sa-l poata folosi altii
PUBLICARE.txt   cum ajunge in lista oficiala de Community Addons
URCARE-GITHUB.txt  cum il urci pe GitHub si Render, pas cu pas
ISTORIC.txt     ce s-a schimbat de la o versiune la alta

===========================================================
LIMITE REALE, SPUSE DIRECT
===========================================================
GEOBLOCARE. Majoritatea posturilor romanesti mari sunt restrictionate la
teritoriul Romaniei. Din alta tara vezi lista dar multe canale nu pornesc.
Addonul le marcheaza, dar nu le poate ocoli.

CANALE CU ABONAMENT. Discovery, History, Digi World, Digi Life si altele
NU sunt si nu vor fi disponibile. Sursele publice le exclud prin politica
proprie, fiindca se difuzeaza doar prin abonament.

LINKURI CARE MOR. Listele publice imbatranesc. Un canal care mergea
saptamana trecuta poate fi mort azi. De-aia exista TESTEAZA-LINKURI.bat
si canale.m3u.

LINKURI YOUTUBE. Unele posturi s-au mutat pe YouTube. Stremio nu le poate
reda prin addonul asta. Sunt marcate in lista.

CALCULATORUL TREBUIE SA FIE PORNIT, daca il rulezi acasa. Vezi GAZDUIRE.txt
pentru varianta care merge non-stop.

===========================================================
INCA NEREPARATE
===========================================================
- Nu exista health check automat la pornire. Testerul e manual
  (SCANEAZA-CALITATE.bat si TESTEAZA-LINKURI.bat).
