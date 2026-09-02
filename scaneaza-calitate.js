// Scaneaza TOATE canalele si citeste rezolutia REALA din fiecare flux.
// Nu se bazeaza pe ce scrie in nume - deschide playlistul si se uita inauntru.
//
// Rulezi:  node scaneaza-calitate.js
// Sau dublu-click pe SCANEAZA-CALITATE.bat
//
// Produce doua fisiere:
//   raport-calitate.txt  - ce rezolutie are fiecare canal, si din ce sursa
//   canale-hd.m3u        - doar fluxurile >= pragul ales, gata de folosit

const fs=require("fs"), path=require("path");
const { URL }=require("url");

const PRAG=Number(process.env.PRAG||720);        // inaltimea minima acceptata
const PARALEL=Number(process.env.PARALEL||8);    // cate verificari deodata
const TIMEOUT=Number(process.env.TIMEOUT||8000);
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function abs(base,u){ try{ return new URL(u,base).href }catch{ return u } }

async function ia(url,headers){
 const opt={headers:{"User-Agent":UA,...(headers||{})}};
 if(AbortSignal.timeout) opt.signal=AbortSignal.timeout(TIMEOUT);
 const r=await fetch(url,opt);
 if(!r.ok) throw new Error(`HTTP ${r.status}`);
 return await r.text();
}

// Intoarce lista de {h, url} pentru un link. Daca e master, desface variantele.
async function rezolutii(url,headers){
 const t=await ia(url,headers);
 if(!t.includes("#EXTM3U")) throw new Error("nu e HLS");
 if(!t.includes("#EXT-X-STREAM-INF")) return [{h:0,url,master:false}]; // flux direct
 const lines=t.split(/\r?\n/), out=[];
 for(let i=0;i<lines.length;i++){
  if(!lines[i].trim().startsWith("#EXT-X-STREAM-INF")) continue;
  const m=lines[i].match(/RESOLUTION=(\d+)x(\d+)/i);
  for(let j=i+1;j<lines.length;j++){
   const n=lines[j].trim();
   if(n&&!n.startsWith("#")){ out.push({h:Number(m?m[2]:0), url:abs(url,n), master:true}); break; }
  }
 }
 return out.length?out:[{h:0,url,master:false}];
}

function eticheta(h){
 if(h>=2160)return "4K";
 if(h>=1440)return "1440p";
 if(h>=1080)return "1080p";
 if(h>=720) return "720p";
 if(h>=576) return "576p";
 if(h>=480) return "480p";
 if(h>0)    return h+"p";
 return "necunoscut";
}

(async()=>{
 console.log("\nIncarc canalele...\n");
 const main=require("./addon.js");
 const iface=await main();

 // adun toate canalele din ambele randuri, paginat
 const canale=[];
 for(const rand of ["raultv_country_ro","raultv_country_it"]){
  for(let skip=0;;skip+=100){
   const r=await iface.catalog({id:rand,extra:{skip}});
   if(!r.metas.length) break;
   for(const m of r.metas){
    const c=iface._raultvGetChannel(m.id);
    if(c) canale.push(c);
   }
   if(r.metas.length<100) break;
  }
 }

 const total=canale.reduce((n,c)=>n+c.variants.length,0);
 console.log(`${canale.length} canale, ${total} fluxuri de verificat.`);
 console.log(`Prag: ${PRAG}p. Dureaza cateva minute, ai rabdare.\n`);

 const rezultate=[];
 let gata=0;
 const coada=[];
 for(const c of canale) for(const v of c.variants) coada.push({c,v});

 async function lucrator(){
  while(coada.length){
   const {c,v}=coada.shift();
   try{
    const list=await rezolutii(v.url,v.headers);
    for(const r of list) rezultate.push({canal:c.name, tara:c.country, sursa:v.source, h:r.h, url:r.url, geo:!!v.geo});
   }catch(e){
    rezultate.push({canal:c.name, tara:c.country, sursa:v.source, h:-1, url:v.url, eroare:e.message, geo:!!v.geo});
   }
   gata++;
   if(gata%25===0) process.stdout.write(`  ${gata}/${total}\r`);
  }
 }
 await Promise.all(Array.from({length:PARALEL},lucrator));
 console.log(`  ${gata}/${total}  gata.        \n`);

 // cel mai bun flux per canal
 const peCanal=new Map();
 for(const r of rezultate){
  if(r.h<0) continue;
  const cur=peCanal.get(r.canal);
  if(!cur||r.h>cur.h) peCanal.set(r.canal,r);
 }

 // statistici
 const cat={"4K":0,"1440p":0,"1080p":0,"720p":0,"576p":0,"480p":0,"necunoscut":0,"mort":0};
 for(const c of canale){
  const b=peCanal.get(c.name);
  if(!b){ cat.mort++; continue; }
  cat[eticheta(b.h)]=(cat[eticheta(b.h)]||0)+1;
 }

 console.log("REZOLUTIA REALA, cel mai bun flux per canal:");
 for(const [k,v] of Object.entries(cat)) if(v) console.log(`   ${String(k).padEnd(12)} ${v} canale`);

 // ce surse dau HD
 const surse=new Map();
 for(const r of rezultate){
  if(r.h<PRAG) continue;
  surse.set(r.sursa,(surse.get(r.sursa)||0)+1);
 }
 console.log(`\nDE UNDE VINE CALITATEA (fluxuri >= ${PRAG}p):`);
 [...surse.entries()].sort((a,b)=>b[1]-a[1]).forEach(([s,n])=>console.log(`   ${String(n).padStart(4)}  ${s}`));

 // raport
 const linii=["RAPORT CALITATE REALA — citita din playlist, nu din nume","="
  .repeat(60),""];
 [...peCanal.values()].sort((a,b)=>b.h-a.h||a.canal.localeCompare(b.canal,"ro")).forEach(r=>{
  linii.push(`${eticheta(r.h).padEnd(10)} ${r.canal.padEnd(34)} ${r.geo?"[geo] ":"      "}${r.sursa}`);
 });
 const morti=canale.filter(c=>!peCanal.has(c.name)).map(c=>c.name);
 if(morti.length){ linii.push("","CANALE FARA NICIUN FLUX VIU:",...morti.map(n=>"   "+n)); }
 fs.writeFileSync(path.join(__dirname,"raport-calitate.txt"),linii.join("\n"),"utf8");

 // canale-hd.m3u: cel mai bun flux per canal, daca trece pragul
 const m3u=["#EXTM3U","# Generat de scaneaza-calitate.js — rezolutii REALE, citite din playlist.",
   `# Prag: ${PRAG}p. Redenumeste in canale.m3u ca sa le folosesti ca servere prioritare.`,""];
 let n=0;
 for(const c of canale){
  const b=peCanal.get(c.name);
  if(!b||b.h<PRAG) continue;
  // scot eticheta veche din nume ("Pro TV (4K)") ca sa nu se dubleze cu cea reala
  const curat=c.name.replace(/\s*\((?:4K|UHD|FHD|HD|SD|\d+[ip])\)\s*$/i,"").trim();
  m3u.push(`#EXTINF:-1 tvg-id="${c.tvgId||""}" tvg-logo="${c.logo||""}",${curat} (${eticheta(b.h)})`);
  m3u.push(b.url); n++;
 }
 fs.writeFileSync(path.join(__dirname,"canale-hd.m3u"),m3u.join("\n"),"utf8");

 console.log(`\nScris raport-calitate.txt  (toate canalele, sortate dupa calitate)`);
 console.log(`Scris canale-hd.m3u        (${n} canale >= ${PRAG}p)\n`);
 console.log("Ca sa folosesti fluxurile HD ca servere prioritare:");
 console.log("   redenumeste canale-hd.m3u in canale.m3u si reporneste.\n");
})().catch(e=>{ console.error("EROARE:",e.message); process.exit(1); });
