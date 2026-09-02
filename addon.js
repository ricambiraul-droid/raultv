const { addonBuilder } = require("stremio-addon-sdk");
const fs=require("fs"), path=require("path");
const PORT=Number(process.env.PORT||7000);
const PUBLIC_URL=(process.env.PUBLIC_URL||`http://127.0.0.1:${PORT}`).replace(/\/$/,"");

// Cate servere maxim per canal afisate in Stremio.
const MAX_SERVERE=Number(process.env.MAX_SERVERE||20);
// Pe TV derulezi cu telecomanda. O lista de 40 de servere e inutilizabila.
// MAX_STREAMURI limiteaza cate intrari vede utilizatorul in total.
// PE_REZOLUTIE limiteaza cate servere se arata pentru aceeasi calitate.
const MAX_STREAMURI=Number(process.env.MAX_STREAMURI||15);
const PE_REZOLUTIE=Number(process.env.PE_REZOLUTIE||3);
// Cate canale trimitem intr-o pagina. Fara asta, Stremio primea toata lista
// dintr-o data si incerca sa incarce sute de logouri simultan.
const PAGINA=Number(process.env.PAGINA||100);
// MOD=simplu (implicit): linkul merge DIRECT la playerul Stremio, ca la Kodi.
//   Fara sondarea masterelor, fara proxy. Canalul porneste instant.
// MOD=proxy: trece prin serverul local. Da rezolutii separate, failover si
//   subtitrari pastrate, dar e mult mai greu si poate bloca pe net slab.
const MOD=String(process.env.MOD||"simplu").toLowerCase();
// Scanare in FUNDAL la pornire: deschide fiecare flux o singura data si retine ce
// rezolutii are inauntru. Asa poti alege manual calitatea, fara sa astepti nimic
// la deschiderea canalului. Ordinea de scanare urmeaza audienta din rating.json.
// Reincarcare periodica a listelor. Fara ea, un link care moare ramane mort
// pana repornesti serverul - pe Render, asta putea insemna zile.
const REFRESH_MIN=Number(process.env.REFRESH_MIN||30);
const SCANARE=String(process.env.SCANARE??"1")!=="0";
// REZOLUTII=0 => nu mai desfacem masterul in rezolutii separate; doar linkul
// original, ca playerul sa aleaga singur. Cea mai sigura varianta.
const REZOLUTII=String(process.env.REZOLUTII??"1")!=="0";
// AUTO=0 => ascunde intrarea "Auto" (masterul) cand exista rezolutii fixe.
// Calitatea aleasa de tine ramane fixa, playerul nu mai comuta singur (ABR).
// Masterul se pastreaza totusi cand e singura optiune, ca sa nu ramai fara nimic.
const AUTO=String(process.env.AUTO??"1")!=="0";
// Un link copil cu parametri in URL e aproape sigur semnat cu token care
// expira. Il extragem la scanare, dar cand apesi tu poate fi deja mort.
// Astea NU se expun ca servere separate - doar masterul, care ramane valabil.
const areToken=u=>/[?&](token|hdnts|hdnea|wmsAuthSign|md5|expires|st=|e=)/i.test(String(u))||String(u).includes("?");
const SCAN_PARALEL=Number(process.env.SCAN_PARALEL||6);
const rezolutiiCache=new Map();   // url flux -> [{h,url}] rezolutii reale
// Lista filtrata+sortata, tinuta minte intre paginile aceleiasi cereri.
const catalogCache=new Map();

// Surse publice/gratuite. Lista proprie poate fi adaugata prin M3U_URL.
// `streams/*.m3u` sunt listele BRUTE de la iptv-org: acolo un canal poate avea
// mai multe linkuri (mai multe servere). `countries/*.m3u` e lista curatata,
// cu un singur link per canal. Le folosim pe amandoua ca sa avem cat mai multe servere.
const SOURCES=[
 {name:"IPTV-org RO (brut, multi-server)",url:"https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ro.m3u",filter:"all",forceCountry:"ro"},
 {name:"IPTV-org România",url:"https://iptv-org.github.io/iptv/countries/ro.m3u",filter:"all",forceCountry:"ro"},
 {name:"IPTV-org limba română",url:"https://iptv-org.github.io/iptv/languages/ron.m3u",filter:"roOnly"},
 {name:"Free-TV România",url:"https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_romania.m3u8",filter:"all",forceCountry:"ro"},
 {name:"hmlendea România",url:"https://raw.githubusercontent.com/hmlendea/iptv-playlist/master/ro.m3u",filter:"all",forceCountry:"ro"},
 {name:"IPTV-org global",url:"https://iptv-org.github.io/iptv/index.m3u",filter:"roItOnly",grea:true},
 {name:"IPTV-org IT (brut, multi-server)",url:"https://raw.githubusercontent.com/iptv-org/iptv/master/streams/it.m3u",filter:"all",forceCountry:"it"},
 {name:"IPTV-org Italia",url:"https://iptv-org.github.io/iptv/countries/it.m3u",filter:"all",forceCountry:"it"},
 {name:"Free-TV Italia",url:"https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_italy.m3u8",filter:"all",forceCountry:"it"},
 {name:"IPTV-org limba italiană",url:"https://iptv-org.github.io/iptv/languages/ita.m3u",filter:"itOnly"},
 // Republica Moldova: canale in limba romana. Intra in randul România, nu separat.
 // Filtrul mdRomanian scoate posturile rusofone (RTR, NTV, CTC, TNT, REN etc).
 {name:"IPTV-org MD (brut, multi-server)",url:"https://raw.githubusercontent.com/iptv-org/iptv/master/streams/md.m3u",filter:"mdRomanian",forceCountry:"ro"},
 {name:"IPTV-org Moldova",url:"https://iptv-org.github.io/iptv/countries/md.m3u",filter:"mdRomanian",forceCountry:"ro"},
 {name:"Free-TV Moldova",url:"https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_moldova.m3u8",filter:"mdRomanian",forceCountry:"ro"}
]
let channels=[];
let loadPromise=null;
let lastLoadError=null;
function attr(line,n){const m=line.match(new RegExp(n+'="([^"]*)"',"i"));return m?m[1]:"";}
function cleanId(s){return String(s||"canal").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");}
// Sursele marcheaza restrictiile in nume: iptv-org cu [Geo-blocked],
// Free-TV cu simbolul Ⓖ. baseName() le sterge, asa ca le citim inainte.
function esteGeo(n){return /\[Geo-?blocked\]/i.test(String(n))||/Ⓖ/.test(String(n));}
function esteYoutube(u){return /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)\//i.test(String(u));}
function baseName(n){return String(n||"").replace(/\s*\((2160p|1440p|1080p|1080i|720p|576[pi]?|480[pi]?|360p)\)\s*/ig," ").replace(/\s*\[(Not 24\/7|Geo-blocked)\]\s*/ig," ").replace(/[ⒼⓎⓈ]/g,"").replace(/\s+/g," ").trim();}
function quality(n){
 n=String(n||"").toLowerCase();
 if(/\b(2160p|4k|uhd)\b/.test(n))return 600;
 if(/\b1440p\b/.test(n))return 550;
 if(/\b(1080p|fhd|full[ ._-]?hd)\b/.test(n))return 500;
 if(/\b1080i\b/.test(n))return 480;
 if(/\bhd\b/.test(n))return 420;
 if(/\b720p\b/.test(n))return 400;
 if(/\b576[pi]?\b/.test(n))return 300;
 if(/\b480[pi]?\b/.test(n))return 250;
 if(/\b360p\b/.test(n))return 150;
 return 200;
}
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PROBE_TTL=Number(process.env.PROBE_TTL_MIN||30)*60000;
const probeCache=new Map();

// Un link .m3u8 poate fi un MASTER care contine mai multe rezolutii inauntru.
// Le extragem ca sa le putem afisa separat in lista de servere din Stremio.
function parseMaster(text){
 const out=[], lines=text.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  if(!lines[i].trim().startsWith("#EXT-X-STREAM-INF"))continue;
  let url="";
  for(let j=i+1;j<lines.length;j++){const n=lines[j].trim(); if(n&&!n.startsWith("#")){url=n;break;}}
  if(!url)continue;
  const m=lines[i].match(/RESOLUTION=(\d+)x(\d+)/i);
  out.push({height:Number(m?m[2]:0),bandwidth:Number((lines[i].match(/BANDWIDTH=(\d+)/i)||[])[1]||0),url});
 }
 return out;
}
// Ca probeMaster, dar intoarce URL-uri ABSOLUTE, gata de dat playerului.
async function rezolutiiAbsolute(url,headers){
 const r=await probeMaster(url,headers);
 return r.map(x=>{ let u=x.url; try{ u=new URL(x.url,url).href }catch{} return {h:x.height||0,bw:x.bandwidth||0,url:u}; })
         .filter(x=>x.h>0).sort((a,b)=>b.h-a.h);
}

// Ruleaza dupa incarcare, fara sa blocheze nimic. Canalele merg din prima secunda;
// pe masura ce scanarea avanseaza, apar si rezolutiile separate.
async function scanFundal(){
 if(!SCANARE||MOD==="proxy")return;
 const ord=[...channels].sort((a,b)=>ratingOf(b)-ratingOf(a));
 const lista=[];
 for(const c of ord) for(const v of c.variants.slice(0,MAX_SERVERE)) lista.push(v);
 console.log(`Scanez in fundal ${lista.length} fluxuri (intai cele mai vizionate)...`);
 let i=0, cuVariante=0, moarte=0;
 async function lucrator(){
  while(i<lista.length){
   const v=lista[i++];
   if(rezolutiiCache.has(v.url))continue;
   try{
    const r=await rezolutiiAbsolute(v.url,v.headers);
    rezolutiiCache.set(v.url,r);
    if(r.length>1)cuVariante++;
   }catch(e){ rezolutiiCache.set(v.url,[]); moarte++; }
  }
 }
 await Promise.all(Array.from({length:SCAN_PARALEL},lucrator));
 console.log(`Scanare gata: ${cuVariante} fluxuri au mai multe rezolutii, ${moarte} nu au raspuns.`);
}

async function probeMaster(url,headers){
 const hit=probeCache.get(url);
 if(hit && Date.now()-hit.t<PROBE_TTL) return hit.r;
 let r=[];
 try{
  const opt={headers:{"User-Agent":UA,...(headers||{})}};
  if(typeof AbortSignal!=="undefined"&&AbortSignal.timeout)opt.signal=AbortSignal.timeout(6000);
  const res=await fetch(url,opt);
  if(res.ok){const t=await res.text(); if(t.includes("#EXT-X-STREAM-INF"))r=parseMaster(t);}
 }catch(e){}
 probeCache.set(url,{t:Date.now(),r});
 return r;
}

// ---------- GHID DE PROGRAME (XMLTV / EPG) ----------
// Optional. Setezi EPG_URL in .env cu un XMLTV; canalele arata "Acum: <emisiune>".
// Ghiduri gata facute: https://github.com/iptv-org/epg
// Se incarca in FUNDAL - addonul merge si fara el, si nu blocheaza nimic.
const EPG_URL=String(process.env.EPG_URL||"").trim();
let EPG=new Map();   // idCanal -> [{t0,t1,titlu}]

// XMLTV: "20260902180000 +0300". Fusul TREBUIE scazut, altfel ghidul e decalat.
function xmltvTime(s){
 const m=String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
 if(!m)return NaN;
 let t=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
 if(m[7]){
  const semn=m[7][0]==="-"?1:-1;
  t+=semn*((+m[7].slice(1,3))*60+(+m[7].slice(3,5)))*60000;
 }
 return t;
}
// tvg-id difera intre surse ("ProTV.ro" vs "ProTV.ro@SD"). Comparam baza.
const epgKey=id=>String(id||"").toLowerCase().replace(/@.*$/,"").trim();

async function loadEPG(){
 if(!EPG_URL)return;
 const vrem=new Set(channels.map(c=>epgKey(c.tvgId)).filter(Boolean));
 const acum=Date.now(), harta=new Map();
 for(const u of EPG_URL.split(",").map(x=>x.trim()).filter(Boolean)){
  try{
   const r=await fetch(u,{headers:{"User-Agent":UA}});
   if(!r.ok)throw new Error(`HTTP ${r.status}`);
   const xml=await r.text();
   let n=0;
   for(const m of xml.matchAll(/<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g)){
    const ch=(m[1].match(/channel="([^"]*)"/)||[])[1];
    const k=epgKey(ch);
    if(!k||!vrem.has(k))continue;
    const t1=xmltvTime((m[1].match(/stop="([^"]*)"/)||[])[1]);
    if(!(t1>acum))continue;                       // trecut, nu ne trebuie
    const t0=xmltvTime((m[1].match(/start="([^"]*)"/)||[])[1]);
    const titlu=(m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/)||[])[1];
    if(!titlu)continue;
    if(!harta.has(k))harta.set(k,[]);
    harta.get(k).push({t0,t1,titlu:titlu.replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").trim()});
    n++;
   }
   console.log(`EPG ${u}: ${n} emisiuni pentru ${harta.size} canale`);
  }catch(e){console.warn(`EPG ${u}: ${e.message}`);}
 }
 for(const v of harta.values())v.sort((a,b)=>a.t0-b.t0);
 EPG=harta;
}
function acumLa(tvgId){
 const l=EPG.get(epgKey(tvgId)); if(!l||!l.length)return "";
 const t=Date.now();
 const p=l.find(x=>x.t0<=t&&t<x.t1);
 return p?`Acum: ${p.titlu}`:"";
}

function hLabel(h){
 if(h>=2160)return "4K";
 if(h>=1440)return "1440p";
 if(h>=1080)return "1080p";
 if(h>=720)return "720p";
 if(h>=576)return "576p";
 if(h>=480)return "480p";
 if(h>=360)return "360p";
 return h?`${h}p`:"Auto";
}
function tagOf(q){
 return /4K|2160/i.test(q)?"2160p":/1440/i.test(q)?"1440p":/1080/i.test(q)?"1080p":/720|HD/i.test(q)?"720p":undefined;
}
function qLabel(score){
 if(score>=600)return "4K";
 if(score>=550)return "1440p";
 if(score>=500)return "1080p";
 if(score>=480)return "1080i";
 if(score>=420)return "HD";
 if(score>=400)return "720p";
 if(score>=300)return "576p";
 if(score>=250)return "480p";
 if(score>=200)return "Auto";
 return "360p";
}
function parse(text,source){
 const out=[];let cur=null,headers={};
 for(const raw of text.split(/\r?\n/)){
  const line=raw.trim();
  if(line.startsWith("#EXTINF")) cur={rawName:line.substring(line.lastIndexOf(",")+1).trim()||"Canal TV",group:attr(line,"group-title")||"ROMÂNIA",logo:attr(line,"tvg-logo"),tvgId:attr(line,"tvg-id"),countryRaw:attr(line,"tvg-country")||attr(line,"country"),source};
  else if(line.startsWith("#EXTVLCOPT:http-referrer=")) headers.Referer=line.split("=").slice(1).join("=");
  else if(line.startsWith("#EXTVLCOPT:http-user-agent=")) headers["User-Agent"]=line.split("=").slice(1).join("=");
  else if(line&&!line.startsWith("#")&&cur){cur.url=line;cur.headers={...headers};out.push(cur);cur=null;headers={};}
 }
 return out;
}
const RO_IDS=new Set([
 "protv.ro","antena1.ro","antena3.ro","antenastars.ro","tvr1.ro","tvr2.ro","tvr3.ro","tvrinternational.ro",
 "digi24.ro","digisport1.ro","digisport2.ro","primatv.ro","kanald.ro","b1tv.ro","realitateaplus.ro",
 "romaniatv.ro","trinitastv.ro","favorittv.ro","etnotv.ro","taraftv.ro","agrotv.ro","nasultv.ro"
]);
const RO_NAMES=[
 "tvr","antena","pro tv","protv","pro x","pro arena","pro cinema","digi","prima","kanal d","b1 tv",
 "realitatea","romania tv","românia tv","trinitas","favorit","etno tv","taraf","agro tv","nasul","nașul",
 "metropola","a7tv","atomic tv","look tv","aleph news","national tv","național tv"
];
// Posturi din Republica Moldova care emit in romana.
const MD_NAMES=["jurnal tv","tv8","tv 8","moldova 1","moldova1","tvr moldova","pro tv chisinau",
 "pro tv chișinău","n4","vocea basarabiei","accent tv","realitatea md","publika","prime tv",
 "canal 2","canal 3","cinema 1","tvc21","gagauziya","itv","orizont","exclusiv tv","primul in moldova"];
// Posturi din grila Moldovei care emit in rusa - nu ne intereseaza.
const MD_EXCLUDE=/\b(rtr|ntv|ctc|tnt|ren ?tv|rbk|perv|pervyi|ru ?tv|rossiya|россия|нтв|стс)\b/i;
function esteMoldoveanRomanesc(c){
 const n=normTxt(baseName(c.rawName||c.name||""));
 if(MD_EXCLUDE.test(n))return false;
 if(MD_NAMES.some(x=>n.includes(x)))return true;
 const id=String(c.tvgId||"").toLowerCase();
 if(MD_EXCLUDE.test(id))return false;
 return id.endsWith(".md")||id.endsWith(".ro");
}
function isRomanian(c){
 const id=(c.tvgId||"").toLowerCase(); if(RO_IDS.has(id)||id.endsWith(".ro"))return true;
 const n=baseName(c.rawName).toLowerCase(); return RO_NAMES.some(x=>n.includes(x));
}
async function fetchSource(s){
 const r=await fetch(s.url,{headers:{"User-Agent":"RaulTV/14.3"}});
 if(!r.ok)throw new Error(`${s.name}: HTTP ${r.status}`);
 let a=parse(await r.text(),s.name); if(s.forceCountry)a=a.map(x=>({...x,forcedCountry:s.forceCountry}));
 a=a.filter(x=>matchesFilter(x,s.filter));
 return a;
}
// Filtrele erau declarate in SOURCES dar nu erau aplicate nicaieri.
function matchesFilter(c,f){
 if(!f||f==="all")return true;
 if(f==="romanian")return isRomanian(c);
 if(f==="mdRomanian")return esteMoldoveanRomanesc(c);
 const code=countryOf(c).code;
 if(f==="roOnly")return code==="ro"||isRomanian(c)||(code==="md"&&esteMoldoveanRomanesc(c));
 if(f==="itOnly")return code==="it";
 if(f==="roItOnly")return code==="ro"||code==="it"||isRomanian(c);
 return true;
}

const COUNTRY_NAMES={
 ro:"România",it:"Italia",de:"Germania",fr:"Franța",es:"Spania",gb:"Regatul Unit",uk:"Regatul Unit",
 us:"SUA",nl:"Olanda",be:"Belgia",at:"Austria",ch:"Elveția",pt:"Portugalia",gr:"Grecia",bg:"Bulgaria",
 hu:"Ungaria",pl:"Polonia",md:"Moldova",ua:"Ucraina",tr:"Turcia",cz:"Cehia",sk:"Slovacia",rs:"Serbia",
 hr:"Croația",si:"Slovenia",al:"Albania",ba:"Bosnia și Herțegovina",me:"Muntenegru",mk:"Macedonia de Nord",
 ie:"Irlanda",dk:"Danemarca",se:"Suedia",no:"Norvegia",fi:"Finlanda",is:"Islanda",ee:"Estonia",lv:"Letonia",
 lt:"Lituania",ca:"Canada",mx:"Mexic",br:"Brazilia",ar:"Argentina",cl:"Chile",co:"Columbia",pe:"Peru",
 au:"Australia",nz:"Noua Zeelandă",jp:"Japonia",kr:"Coreea de Sud",cn:"China",in:"India",id:"Indonezia",
 ph:"Filipine",th:"Thailanda",vn:"Vietnam",my:"Malaezia",sg:"Singapore",za:"Africa de Sud",eg:"Egipt",
 ma:"Maroc",dz:"Algeria",tn:"Tunisia",il:"Israel",sa:"Arabia Saudită",ae:"Emiratele Arabe Unite"
};
function countryOf(c){
 // Moldova romanofona intra la România, nu se pierde intr-un rand separat.
 if(String(c.tvgId||"").toLowerCase().endsWith(".md")&&esteMoldoveanRomanesc(c))
  return {code:"ro",name:COUNTRY_NAMES.ro};
 if(c.forcedCountry){const x=c.forcedCountry;return {code:x,name:COUNTRY_NAMES[x]||x.toUpperCase()};}
 let x=String(c.countryRaw||"").trim().toLowerCase().split(/[;, ]/)[0];
 if(!x && c.tvgId){const m=String(c.tvgId).match(/\.([a-z]{2})(?:@.*)?$/i); if(m)x=m[1].toLowerCase();}
 return {code:x||"xx",name:COUNTRY_NAMES[x]||((x||"").toUpperCase()||"Internaționale")};
}

// Lista proprie a utilizatorului: fisierul canale.m3u de langa addon,
// plus orice URL-uri puse in M3U_URL (separate prin virgula).
// Astea au prioritate: apar primele intre serverele de aceeasi rezolutie.
const M3U_LOCAL=path.join(__dirname,"canale.m3u");

// Ordinea canalelor in lista: dupa audienta pe tara. Editabila in rating.json.
const RATING_FILE=path.join(__dirname,"rating.json");
let RATING={};
function loadRating(){
 try{
  if(!fs.existsSync(RATING_FILE))return;
  const j=JSON.parse(fs.readFileSync(RATING_FILE,"utf8"));
  RATING=j.posturi||j;
  console.log(`rating.json: ${Object.keys(RATING).length} posturi cu audienta definita`);
 }catch(e){console.warn("rating.json:",e.message," - se foloseste ordinea alfabetica");}
}
function ratingOf(c){
 const k=canonicalChannelKey(c);
 if(RATING[k]!=null)return Number(RATING[k])||0;
 const n=normTxt(c.name||"").replace(/[^a-z0-9]/g,"");
 return Number(RATING[n])||0;
}
function marcheazaLocal(a,sursa){
 return a.map(x=>({
  ...x, source:sursa, local:true,
  forcedCountry:x.forcedCountry||String(x.countryRaw||"").trim().toLowerCase().slice(0,2)||"ro"
 }));
}
async function loadLocal(){
 const out=[];
 try{
  if(fs.existsSync(M3U_LOCAL)){
   const t=fs.readFileSync(M3U_LOCAL,"utf8");
   if(t.includes("#EXTINF")){
    const a=marcheazaLocal(parse(t,"⭐ Lista mea"),"⭐ Lista mea (canale.m3u)");
    out.push(...a);
    console.log(`⭐ Lista mea (canale.m3u): ${a.length}`);
   }
  }
 }catch(e){console.warn("canale.m3u:",e.message);}
 for(const u of String(process.env.M3U_URL||"").split(",").map(s=>s.trim()).filter(Boolean)){
  try{
   const r=await fetch(u,{headers:{"User-Agent":UA}});
   if(!r.ok)throw new Error(`HTTP ${r.status}`);
   const a=marcheazaLocal(parse(await r.text(),"⭐ Lista mea"),"⭐ Lista mea (M3U_URL)");
   out.push(...a);
   console.log(`⭐ Lista mea (${u}): ${a.length}`);
  }catch(e){console.warn(`M3U_URL ${u}: ${e.message}`);}
 }
 return out;
}

async function loadChannels(){
 let all=await loadLocal();
 // Sursa globala are zeci de mii de canale si e cea mai lenta la pornire.
 // Implicit e SARITA. Porneste-o cu SURSA_GLOBALA=1 in .env daca chiar o vrei.
 const globalaPornita=String(process.env.SURSA_GLOBALA||"0")==="1";
 for(const s of SOURCES){
  if(s.grea && !globalaPornita){console.log(`${s.name}: sarita (SURSA_GLOBALA=1 ca s-o pornesti)`);continue;}
  try{const a=await fetchSource(s);console.log(`${s.name}: ${a.length}`);all.push(...a);}catch(e){console.warn(e.message);}
 }
 // Group multiple quality/backups under one channel.
 const groups=new Map();
 for(const c of all){
  const name=baseName(c.rawName);
  // tvg-id difera intre surse: "ProTV.ro" vs "ProTV.ro@SD". Fara normalizare
  // ajungeau doua canale separate, fiecare cu jumatate din servere.
  const key=canonicalChannelKey({...c,name})||cleanId(name);
  if(!groups.has(key)){const co=countryOf(c);groups.set(key,{name,tvgId:c.tvgId,group:c.group||"General",logo:c.logo,countryCode:co.code,country:co.name,local:false,variants:[]});}
  const g=groups.get(key); if(!g.logo&&c.logo)g.logo=c.logo; if(c.local)g.local=true;
  const co=countryOf(c); if(g.countryCode==="xx"&&co.code!=="xx"){g.countryCode=co.code;g.country=co.name;}
  const score=quality(c.rawName)-(/\[Not 24\/7\]/i.test(c.rawName)?80:0)+(c.local?5:0);
  if(!g.variants.some(v=>String(v.url).trim()===String(c.url).trim()))g.variants.push({...c,score,geo:esteGeo(c.rawName),yt:esteYoutube(c.url),label:(c.label||qLabel(score))});
 }
 const noi=[...groups.values()].filter(g=>g.local||g.countryCode==="ro"||g.countryCode==="it")
 .map((g,i)=>({...g,id:`raultv_${cleanId(g.name)}_${i}`,variants:g.variants.sort((a,b)=>b.score-a.score)}))
 .sort((a,b)=>a.name.localeCompare(b.name,"ro"));

 // Daca toate sursele au picat dar aveam deja canale, NU le stergem.
 // O lista invechita e infinit mai buna decat una goala.
 if(!noi.length && channels.length){
  throw new Error(`toate sursele au esuat; pastrez cele ${channels.length} posturi existente`);
 }
 catalogCache.clear();
 channels=noi;
 console.log(`RaulTV v14.3: ${channels.length} posturi, ${channels.reduce((n,c)=>n+c.variants.length,0)} streamuri`);
}
function streamObjects(c){
 const valid=c.variants.filter(v=>/^https?:\/\//i.test(v.url||"")).slice(0,12);
 return valid.map((v,i)=>{
   const o={
     name:`RaulTV ${v.label}${i===0?" • BEST":""}`,
     title:`${c.name} — ${v.label} — ${v.source}`,
     url:v.url,
     behaviorHints:{notWebReady:true}
   };
   if(v.headers && Object.keys(v.headers).length){
     o.behaviorHints.proxyHeaders={request:v.headers};
   }
   return o;
 });
}
function meta(c){
 const f=`${PUBLIC_URL}/static/logo.svg`;
 return {
   id:c.id,
   type:"tv",
   name:c.name,
   poster:c.logo||f,
   logo:c.logo||f,
   posterShape:"square",
   genres:[categoryOf(c)],
   description:(()=>{
     const v=c.variants.slice(0,MAX_SERVERE);
     const libere=v.filter(x=>!x.geo&&!x.yt).length;
     const nyt=v.filter(x=>x.yt).length, ngeo=v.filter(x=>x.geo&&!x.yt).length;
     let nota="";
     if(!libere&&nyt&&!ngeo)      nota=" · ⚠ doar link YouTube, nu merge in Stremio";
     else if(!libere&&ngeo)       nota=` · ⚠ doar din ${c.country}`;
     else if(libere<v.length)     nota=` · ${libere} din ${v.length} servere merg din afara ${c.country}`;
     const prog=acumLa(c.tvgId);
     return [prog,`${c.name} · LIVE · ${v.length} servere · calități: ${[...new Set(v.map(x=>x.label))].join(", ")||"Auto"}${nota}`].filter(Boolean).join(" · ");
   })()
 };
}

function variantCard(c,v,i){
 const q=v.label||"Auto";
 const vid=`${c.id}__srv_${i}`;
 const f=`${PUBLIC_URL}/static/logo.svg`;
 return {
   id:vid,type:"tv",
   name:`${c.name} • SERVER ${i+1} • ${q}`,
   poster:c.logo||f,logo:c.logo||f,posterShape:"square",
   genres:[categoryOf(c)],
   description:`${c.name} · SERVER ${i+1} · ${q} · ${v.source}`
 };
}
function parseVariantId(id){
 const m=String(id||"").match(/^(raultv_.+)__srv_(\d+)$/);
 if(!m)return null;
 const c=channels.find(x=>x.id===m[1]), i=Number(m[2]);
 if(!c||!c.variants[i])return null;
 return {c,i,v:c.variants[i]};
}

function isRomanianEntry(x){
 const z=`${x.name||""} ${x.tvgId||""} ${x.group||""}`.toLowerCase();
 return /\.ro\b|romania|românia|romanian|română|romana|tvr|antena|pro tv|protv|digi|prima tv|realitatea|b1 tv|b1tv|euronews rom|agro tv|a7tv|metropola|nasul|nașul|trinitas|favorit tv|etno tv|taraf tv|atomic tv/.test(z);
}

function normTxt(x){
 return String(x||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
}

function canonicalChannelKey(c){
  const id=String(c.tvgId||"").toLowerCase()
    .replace(/\.[a-z]{2}(?:@.*)?$/i,"").replace(/@.*$/,"")
    .replace(/[^a-z0-9]/g,"");
  let n=normTxt(c.name||c.rawName||"")
    .replace(/\b(4k|uhd|fhd|full hd|hd|sd|1080p|1080i|720p|576p|480p|romania|italia)\b/g,"")
    .replace(/[^a-z0-9]/g,"");
  if(["protv","protvhd","protvromania"].includes(id)||["protv","protvhd","protvromania"].includes(n)) return "protv";
  return id||n;
}
function categoryOf(c){
 const g=normTxt(c.group||"");
 const n=normTxt(c.name||"");
 const t=`${g} ${n}`;
 if(/sport|sports|calcio|football|fotbal|tennis|tenis|golf|racing|motor|eurosport|digi sport|prima sport|rai sport|sportitalia/.test(t)) return "Sport";
 if(/news|stiri|notizie|tg\d|telegiorn|euronews|digi24|antena 3|romania tv|realitatea/.test(t)) return "Știri";
 if(/movie|movies|film|cinema|serie|series|fiction|cinemax/.test(t)) return "Filme";
 if(/document|discovery|history|science|natura|nature|national geographic|nat geo|earth/.test(t)) return "Documentare";
 if(/kids|copii|cartoon|anime|junior|bambini|children|nickelodeon|boomerang|babyfirst/.test(t)) return "Desene animate";
 if(/music|muzica|musica|radio|mtv|hits|folclor/.test(t)) return "Muzică";
 if(/relig|crestin|church|chiesa|catholic|ortodox|trinitas/.test(t)) return "Religie";
 if(/lifestyle|travel|food|cooking|fashion|home|salute/.test(t)) return "Lifestyle";
 if(/local|regional|regionale|tvr cluj|tvr craiova|tvr iasi|tvr timisoara/.test(t)) return "Regional";
 return "General";
}
async function main(){
 // v9.2: serverul trebuie să poată porni chiar dacă internetul / playlisturile întârzie.
 loadRating();
 loadPromise=loadChannels().then(r=>{ setTimeout(()=>{scanFundal().catch(e=>console.warn("scanare:",e.message));loadEPG().catch(e=>console.warn("EPG:",e.message));},1500); return r; }).catch(e=>{lastLoadError=e;console.error("[LOAD ERROR]",e&&e.stack||e);});

 // Reimprospatare periodica, in fundal. Daca reincarcarea esueaza, PASTRAM
 // canalele vechi - mai bine o lista invechita decat una goala.
 if(REFRESH_MIN>0){
  const t=setInterval(async()=>{
   const inainte=channels.length;
   try{
    await loadChannels();
    rezolutiiCache.clear();
    console.log(`[REFRESH] reincarcat: ${inainte} -> ${channels.length} posturi`);
    scanFundal().catch(e=>console.warn("scanare:",e.message));
    loadEPG().catch(e=>console.warn("EPG:",e.message));
   }catch(e){
    console.warn(`[REFRESH] esuat (${e.message}); pastrez cele ${inainte} posturi existente`);
   }
  },REFRESH_MIN*60000);
  if(t.unref)t.unref();
  console.log(`Reimprospatare automata la fiecare ${REFRESH_MIN} minute.`);
 }
 // Nu blocăm inițializarea addonului pe fetch-urile externe.
  const countryRows=[["ro","România"],["it","Italia"]];
 // Logica BEE: categoriile ca RANDURI separate pe ecranul principal, nu doar
 // ca filtru. Pe telecomanda, un rand se parcurge mult mai repede decat un meniu.
 const genRows=["Știri","Sport","Filme","Muzică","Regional"];
 const defaultCats=["TOATE CATEGORIILE","General","Știri","Sport","Filme","Documentare","Desene animate","Muzică","Religie","Lifestyle","Regional"];
 const catalogs=[
  ...countryRows.map(([code,name])=>({type:"tv",id:`raultv_country_${code}`,name:`RaulTV • ${name}`,extra:[
   {name:"search",isRequired:false},{name:"genre",options:defaultCats,isRequired:false},{name:"skip",isRequired:false}
  ]})),
  ...genRows.map(g=>({type:"tv",id:`raultv_gen_${cleanId(g)}`,name:`RaulTV • ${g}`,extra:[
   {name:"search",isRequired:false},{name:"skip",isRequired:false}
  ]}))
 ];
 const manifest={id:process.env.ADDON_ID||"org.raultv.iptv.v104",version:"14.3.0",name:"RaulTV BEE DOOM",description:"RaulTV BEE DOOM v14.3 · ghid de programe",
  behaviorHints:{configurable:false,p2p:false,adult:false},
  logo:`${PUBLIC_URL}/static/logo.svg`,resources:["catalog","meta","stream"],types:["tv"],idPrefixes:["raultv_"],catalogs};
 const b=new addonBuilder(manifest);
 b.defineCatalogHandler(async ({id,extra})=>{
   if(loadPromise){await Promise.race([loadPromise,new Promise(r=>setTimeout(r,8000))]);}
   const sid=String(id||"");
   const mTara=sid.match(/^raultv_country_(.+)$/);
   const mGen=sid.match(/^raultv_gen_(.+)$/);
   if(!mTara&&!mGen)return {metas:[]};
   // Randul pe categorie: numele lui e cheia; il gasim inapoi din slug.
   const genRand=mGen?["Știri","Sport","Filme","Muzică","Regional"].find(g=>cleanId(g)===mGen[1]):null;
   const gen=extra?.genre||"", cauta=extra?.search||"";
   const cheie=`${id}|${gen}|${cauta}`;
   let a=catalogCache.get(cheie);
   if(!a){
    a=mTara ? channels.filter(c=>c.countryCode===mTara[1])
            : channels.filter(c=>categoryOf(c)===genRand);
    if(gen && gen!=="TOATE CATEGORIILE")a=a.filter(c=>categoryOf(c)===gen);
    if(cauta){const q=cauta.toLowerCase();a=a.filter(c=>c.name.toLowerCase().includes(q));}
    // Cele mai vizionate primele; cele fara audienta cunoscuta la final, alfabetic.
    a=a.slice().sort((x,y)=>ratingOf(y)-ratingOf(x)||x.name.localeCompare(y.name,"ro"));
    catalogCache.set(cheie,a);
   }
   const skip=Math.max(0,Number(extra?.skip)||0);
   const pagina=a.slice(skip,skip+PAGINA);
   console.log(`[CATALOG] ${id} -> ${a.length} canale, trimit ${pagina.length} (de la ${skip})`);
   // Un singur card per canal. Serverele apar in dreapta, la deschiderea canalului.
   return {metas:pagina.map(c=>meta(c))};
 });
 b.defineMetaHandler(async ({type,id})=>{
   if(type!=="tv") return {meta:null};
   if(loadPromise){await Promise.race([loadPromise,new Promise(r=>setTimeout(r,8000))]);}
   const x=parseVariantId(id);
   if(x){
     const m=variantCard(x.c,x.v,x.i);
     // `tv` is a one-video live type in Stremio: meta ID == stream/video ID.
     m.behaviorHints={defaultVideoId:m.id};
     return {meta:m};
   }
   const c=channels.find(x=>x.id===id);
   if(!c)return {meta:null};
   const m=meta(c);
   m.behaviorHints={defaultVideoId:m.id};
   return {meta:m};
 });
 b.defineStreamHandler(async ({type,id})=>{
  if(loadPromise){await Promise.race([loadPromise,new Promise(r=>setTimeout(r,8000))]);}
  console.log(`[STREAM] request type=${type} id=${id}`);
  if(type!=="tv") return Promise.resolve({streams:[]});
  const selected=parseVariantId(id);
  if(selected){
    const {c,v,i}=selected;
    const quality=v.label||"Auto";
    const tag=/4K|2160/i.test(quality)?"2160p":/1080|FHD/i.test(quality)?"1080p":/720|HD/i.test(quality)?"720p":undefined;
    return Promise.resolve({streams:[{
      name:`RaulTV • SERVER ${i+1} • ${quality}`,
      title:`${c.name} • ${quality} • ${v.source}`,
      ...(tag?{tag:[tag]}:{}),
      url:`${PUBLIC_URL}/play/${encodeURIComponent(c.id)}/${i}/master.m3u8`,
      behaviorHints:{notWebReady:true}
    }]});
  }
  const c=channels.find(x=>x.id===id);
  if(!c)return Promise.resolve({streams:[]});
  const base=c.variants.slice(0,MAX_SERVERE);

  if(MOD!=="proxy"){
   // MOD SIMPLU: dam linkul direct playerului, ca la Kodi. Zero cereri de retea
   // aici, deci lista de servere apare instantaneu. Playerul alege singur
   // calitatea din master (ABR) si se ocupa el de HLS.
   const out=[];
   base.forEach(v=>{
    const rends=rezolutiiCache.get(v.url);
    if(REZOLUTII&&rends&&rends.length>1&&!rends.some(r=>areToken(r.url))){
     // MASTERUL PRIMUL: e cel mai sigur, nu expira, si playerul face ABR.
     if(AUTO)out.push({h:9999,q:"Auto",url:v.url,v});
     // Apoi rezolutiile fixe, pentru cine vrea sa forteze o calitate.
     rends.forEach(r=>out.push({h:r.h,q:hLabel(r.h),url:r.url,v}));
    }else{
     if(rends&&rends.length>1)console.log(`[SKIP] ${c.name}: rezolutii cu token, servesc masterul`);
     // Inca nescanat sau flux fara variante: linkul asa cum e.
     const q=v.label||"Auto";
     out.push({h:/4K/i.test(q)?2160:/1440/.test(q)?1440:/1080/.test(q)?1080:/720|HD/i.test(q)?720:/576/.test(q)?576:/480/.test(q)?480:0,
               q,url:v.url,v});
    }
   });
   out.sort((a,b)=>b.h-a.h||(b.v.local?1:0)-(a.v.local?1:0));
   // Pastram cel mult PE_REZOLUTIE servere pentru aceeasi calitate, ca lista sa
   // ramana navigabila cu telecomanda, dar sa ai totusi rezerve daca unul pica.
   const nrPe=new Map(), filtrat=[];
   for(const s of out){
    const k=s.h===9999?`auto`:s.q;
    const n=(nrPe.get(k)||0);
    if(n>=PE_REZOLUTIE)continue;
    nrPe.set(k,n+1); filtrat.push(s);
    if(filtrat.length>=MAX_STREAMURI)break;
   }
   const simple=filtrat.map((s,i)=>{
    const avert=s.v.yt?" • YouTube, nu merge in Stremio":(s.v.geo?` • doar din ${c.country}`:"");
    const et=s.h===9999?"Auto (recomandat)":s.q;
    const st={
      name:`RaulTV\n${et}`,
      title:`SERVER ${i+1}${i===0?" ⭐ BEST":""} • ${et}${avert}\n${s.v.source}`,
      url:s.url,
      behaviorHints:{notWebReady:true,bingeGroup:`raultv-${c.id}`}
    };
    if(s.h!==9999&&tagOf(s.q))st.tag=[tagOf(s.q)];
    if(s.v.headers&&Object.keys(s.v.headers).length)st.behaviorHints.proxyHeaders={request:s.v.headers};
    return st;
   });
   const scanate=base.filter(v=>rezolutiiCache.has(v.url)).length;
   console.log(`[STREAM] ${c.name}: ${simple.length} servere afisate din ${out.length} gasite, ${base.length} linkuri (${scanate}/${base.length} scanate)`);
   return Promise.resolve({streams:simple});
  }

  // Deschidem fiecare link ca sa vedem daca e master cu mai multe rezolutii inauntru.
  const probed=await Promise.all(base.map(v=>probeMaster(v.url,v.headers)));
  const out=[];
  base.forEach((v,i)=>{
   const rends=probed[i];
   if(rends.length>1){
    rends.forEach((r,ri)=>out.push({
      h:r.height||0, bw:r.bandwidth, q:hLabel(r.height), src:v.source, local:!!v.local,
      url:`${PUBLIC_URL}/play/${encodeURIComponent(c.id)}/${i}/r/${ri}/${r.height||0}/master.m3u8`
    }));
    // Fallback: masterul intreg, lasa playerul sa aleaga singur.
    out.push({h:-1,bw:0,q:"Auto",src:v.source,local:!!v.local,
      url:`${PUBLIC_URL}/play/${encodeURIComponent(c.id)}/${i}/master.m3u8`});
   }else{
    const q=v.label||"Auto";
    out.push({h:/4K/i.test(q)?2160:/1440/.test(q)?1440:/1080/.test(q)?1080:/720|HD/i.test(q)?720:/576/.test(q)?576:/480/.test(q)?480:0,
      bw:0,q,src:v.source,local:!!v.local,
      url:`${PUBLIC_URL}/play/${encodeURIComponent(c.id)}/${i}/master.m3u8`});
   }
  });
  out.sort((a,b)=>b.h-a.h||(b.local?1:0)-(a.local?1:0)||b.bw-a.bw);
  const streams=out.map((s,i)=>({
    name:`RaulTV\n${s.q}`,
    title:`SERVER ${i+1}${i===0?" ⭐ BEST":""} • ${s.q}\n${s.src}`,
    ...(tagOf(s.q)?{tag:[tagOf(s.q)]}:{}),
    url:s.url,
    behaviorHints:{notWebReady:true,bingeGroup:`raultv-${c.id}`}
  }));
  console.log(`[STREAM] ${c.name}: ${base.length} linkuri -> ${streams.length} servere (${out.map(s=>s.q).join(", ")})`);
  return Promise.resolve({streams});
 });
 const iface=b.getInterface(); iface._raultvGetChannel=(id)=>channels.find(x=>x.id===id); return iface;
}
module.exports = main;
