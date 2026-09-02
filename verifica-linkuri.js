// Testeaza fiecare link din canale.m3u si spune care traieste.
const fs=require("fs"), path=require("path");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const file=path.join(__dirname,"canale.m3u");
if(!fs.existsSync(file)){console.log("Nu exista canale.m3u");process.exit(0);}
const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
const items=[];
for(let i=0;i<lines.length;i++){
 const l=lines[i].trim();
 if(!l.startsWith("#EXTINF"))continue;
 const nume=l.substring(l.lastIndexOf(",")+1).trim();
 for(let j=i+1;j<lines.length;j++){
  const n=lines[j].trim();
  if(n&&!n.startsWith("#")){items.push({nume,url:n});break;}
 }
}
if(!items.length){console.log("Niciun link activ in canale.m3u (toate sunt comentate).");process.exit(0);}
console.log(`\nTestez ${items.length} linkuri din canale.m3u...\n`);
(async()=>{
 let vii=0;
 for(const it of items){
  process.stdout.write(`  ${it.nume}\n    ${it.url}\n    `);
  try{
   const opt={headers:{"User-Agent":UA}};
   if(AbortSignal.timeout)opt.signal=AbortSignal.timeout(10000);
   const r=await fetch(it.url,opt);
   if(!r.ok){console.log(`MORT - HTTP ${r.status}\n`);continue;}
   const t=await r.text();
   if(!t.includes("#EXTM3U")){console.log("MORT - raspunde, dar nu e HLS\n");continue;}
   vii++;
   const rez=[...t.matchAll(/RESOLUTION=(\d+x\d+)/gi)].map(m=>m[1]);
   if(rez.length) console.log(`VIU - master cu ${rez.length} rezolutii: ${rez.join(", ")}\n`);
   else if(t.includes("#EXTINF")) console.log("VIU - flux direct (o singura calitate)\n");
   else console.log("VIU - playlist HLS\n");
  }catch(e){console.log(`MORT - ${e.message}\n`);}
 }
 console.log(`Rezultat: ${vii} din ${items.length} linkuri traiesc.`);
 if(!vii)console.log("Niciunul nu merge. Comenteaza-le sau inlocuieste-le.");
})();
