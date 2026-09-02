const http=require("http");
const os=require("os");
const https=require("https");
const {URL}=require("url");
const {getRouter}=require("stremio-addon-sdk");
const express=require("express");
const path=require("path");
const main=require("./addon");

const PORT=Number(process.env.PORT||7000);
// 0.0.0.0 = ascultam si in reteaua locala, ca sa mearga de pe TV si telefon.
const HOST=process.env.HOST||"0.0.0.0";

// IP-ul din reteaua locala, ca sa stim ce adresa sa dam la TV.
function ipLocal(){
 for(const list of Object.values(os.networkInterfaces()||{}))
  for(const n of list||[])
   if(n.family==="IPv4" && !n.internal) return n.address;
 return null;
}
const IP=ipLocal();
// Daca ascultam in retea si nu ni s-a spus altceva, folosim IP-ul local.
// Altfel logoul si (in MOD=proxy) linkurile ar arata spre 127.0.0.1 si ar
// fi inaccesibile de pe TV.
const PUBLIC_URL=process.env.PUBLIC_URL||((HOST==="0.0.0.0"&&IP)?`http://${IP}:${PORT}`:`http://127.0.0.1:${PORT}`);
// Cat asteptam un server sa raspunda. Era 12s fix; prea putin pentru CDN-uri lente.
const TIMEOUT=Number(process.env.UPSTREAM_TIMEOUT||20000);
// Cate incercari primeste serverul PE CARE L-AI ALES tu, inainte de orice rezerva.
const INCERCARI=Number(process.env.INCERCARI||3);
// FAILOVER=0 => nu se comuta niciodata singur pe alt server.
const FAILOVER=String(process.env.FAILOVER??"1")!=="0";

function fetchBuffer(url,headers={},redirects=0,timeout=TIMEOUT){
 return new Promise((resolve,reject)=>{
  if(redirects>5)return reject(new Error("prea multe redirecturi"));
  const u=new URL(url); const mod=u.protocol==="https:"?https:http;
  const req=mod.get(u,{headers:{...headers,"Accept":"*/*","Connection":"keep-alive"}},res=>{
   if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
    res.resume(); return resolve(fetchBuffer(new URL(res.headers.location,u).href,headers,redirects+1,timeout));
   }
   const chunks=[]; res.on("data",d=>chunks.push(d));
   res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),finalUrl:u.href}));
  });
  req.setTimeout(timeout,()=>req.destroy(new Error(`nu a raspuns in ${Math.round(timeout/1000)}s`)));
  req.on("error",reject);
 });
}

const MAX_FALLBACK=Number(process.env.MAX_FALLBACK||6);

// Ordinea de incercare: intai serverul cerut, apoi restul, ca rezerve.
function ordineVariante(c,idx){
 if(!FAILOVER)return [idx];           // ramanem strict pe serverul ales
 const rest=[];
 for(let i=0;i<c.variants.length;i++) if(i!==idx) rest.push(i);
 return [idx,...rest].slice(0,MAX_FALLBACK);
}
// Serverul ales de tine primeste rabdare (mai multe incercari, timp intreg).
// Rezervele primesc o singura incercare rapida - nu are rost sa astepti dupa ele.
function rabdare(k,idx){
 return k===idx ? {n:INCERCARI,t:TIMEOUT} : {n:1,t:Math.min(TIMEOUT,8000)};
}

// Reincearca de cateva ori. Multe caderi la fluxurile live sunt tranzitorii.
async function fetchCuReincercari(url,headers,n=3,timeout=TIMEOUT){
 let last;
 for(let i=0;i<n;i++){
  try{
   const r=await fetchBuffer(url,headers,0,timeout);
   if(r.status>=200&&r.status<400)return r;
   last=new Error(`HTTP ${r.status}`);
   if(r.status===404||r.status===410)break; // expirat definitiv, reincercarea nu ajuta
  }catch(e){last=e}
  if(i<n-1)await new Promise(res=>setTimeout(res,500*(i+1)));
 }
 throw last||new Error("esec necunoscut");
}

// Extrage rezolutiile dintr-un master playlist.

// Construieste un master cu O SINGURA varianta video, dar pastrand liniile
// #EXT-X-MEDIA (subtitrari, audio alternativ) care altfel s-ar pierde.
function masterRedus(txt,pickIndex){
 const lines=txt.split(/\r?\n/);
 const head=[], varianta=[];
 let n=-1, subt=0;
 for(let i=0;i<lines.length;i++){
  const t=lines[i].trim();
  if(!t)continue;
  if(t.startsWith("#EXT-X-STREAM-INF")){
   n++;
   let url="",j=i+1;
   for(;j<lines.length;j++){const q=lines[j].trim(); if(q&&!q.startsWith("#")){url=q;break;}}
   if(n===pickIndex&&url){varianta.push(t,url);}
   i=j; continue;
  }
  if(t.startsWith("#EXT-X-I-FRAME-STREAM-INF"))continue; // inutil aici
  if(t.startsWith("#EXT-X-MEDIA")){
   if(/TYPE=SUBTITLES/i.test(t))subt++;
   head.push(t); continue;
  }
  if(t==="#EXTM3U")continue;
  if(t.startsWith("#"))head.push(t);
 }
 if(!varianta.length)return null;
 return {text:["#EXTM3U",...head,...varianta].join("\n"),subtitrari:subt};
}

function rezolutiiDinMaster(txt){
 const lines=txt.split(/\r?\n/), out=[];
 for(let i=0;i<lines.length;i++){
  if(!lines[i].trim().startsWith("#EXT-X-STREAM-INF"))continue;
  const info=lines[i];
  for(let j=i+1;j<lines.length;j++){
   const n=lines[j].trim();
   if(n&&!n.startsWith("#")){
    const m=info.match(/RESOLUTION=(\d+)x(\d+)/i);
    out.push({h:Number(m?m[2]:0),url:n,info});break;
   }
  }
 }
 return out;
}

function upstreamHeaders(v){
 return {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36",...(v.headers||{})};
}
function abs(base,x){try{return new URL(x,base).href}catch{return x}}
function encodeU(s){return Buffer.from(s).toString("base64url")}
function decodeU(s){return Buffer.from(s,"base64url").toString()}

function rewriteM3U8(text,base,channelId,idx){
 return text.split(/\r?\n/).map(line=>{
  if(!line||line.startsWith("#")){
   // URI="..." inside HLS tags (keys/maps/media)
   return line.replace(/URI="([^"]+)"/g,(m,u)=>`URI="${PUBLIC_URL}/hls/${encodeURIComponent(channelId)}/${idx}/${encodeU(abs(base,u))}"`);
  }
  const u=abs(base,line.trim());
  return `${PUBLIC_URL}/hls/${encodeURIComponent(channelId)}/${idx}/${encodeU(u)}`;
 }).join("\n");
}

(async()=>{
 const iface=await main();
 const app=express();
 app.use("/static",express.static(path.join(__dirname,"static")));
 app.use("/static",express.static(path.join(__dirname,"public")));
 app.use(getRouter(iface));
 app.get("/health",(req,res)=>res.json({ok:true,version:"14.0.0",manifest:`${PUBLIC_URL}/manifest.json`}));


  // Punct de intrare stabil. Daca serverul cerut e mort, comuta singur pe altul.
 app.get("/play/:id/:idx/master.m3u8",async(req,res)=>{
  const c=iface._raultvGetChannel(req.params.id); const idx=Number(req.params.idx);
  if(!c||!c.variants[idx])return res.status(404).send("stream not found");
  for(const k of ordineVariante(c,idx)){
   const v=c.variants[k];
   try{
    const p=rabdare(k,idx);
    if(k===idx)console.log(`[PLAY] ${c.name} server ${k+1}: astept pana la ${Math.round(p.t/1000)}s, ${p.n} incercari`);
    const r=await fetchCuReincercari(v.url,upstreamHeaders(v),p.n,p.t);
    const txt=r.body.toString("utf8");
    if(!txt.includes("#EXTM3U")){console.warn(`[FAILOVER] ${c.name} server ${k+1}: raspunde dar nu e HLS`);continue;}
    if(k!==idx)console.log(`[FAILOVER] ${c.name}: server ${idx+1} mort -> comutat automat pe server ${k+1}`);
    const rez=[...txt.matchAll(/RESOLUTION=(\d+x\d+)/gi)].map(m=>m[1]);
    console.log(`[DOOM HLS] ${c.name} server ${k+1} | HTTP ${r.status} | ${rez.join(", ")||"flux direct"} | ${nsub?nsub+" piste de subtitrare":"fara subtitrari"}`);
    res.set("Content-Type","application/vnd.apple.mpegurl");
    res.set("Cache-Control","no-store");
    return res.send(rewriteM3U8(txt,r.finalUrl,c.id,k));
   }catch(e){console.warn(`[FAILOVER] ${c.name} server ${k+1}: ${e.message}`);}
  }
  if(FAILOVER)console.error(`[FAILOVER] ${c.name}: toate serverele incercate au picat`);
  else console.error(`[PLAY] ${c.name} server ${idx+1} nu raspunde (failover oprit din .env)`);
  res.status(502).send(FAILOVER?"toate serverele au picat":"serverul ales nu raspunde");
 });

  // Serveste O REZOLUTIE anume dintr-un master. La comutare pe alt server,
 // alege rezolutia cea mai apropiata de cea ceruta (h = inaltimea tinta).
 async function serveRezolutie(req,res,h){
  const c=iface._raultvGetChannel(req.params.id);
  const idx=Number(req.params.idx), rid=Number(req.params.rid);
  if(!c||!c.variants[idx])return res.status(404).send("stream not found");
  for(const k of ordineVariante(c,idx)){
   const v=c.variants[k];
   try{
    const p=rabdare(k,idx);
    const r=await fetchCuReincercari(v.url,upstreamHeaders(v),p.n,p.t);
    const txt=r.body.toString("utf8");
    if(!txt.includes("#EXTM3U")){console.warn(`[FAILOVER] ${c.name} server ${k+1}: nu e HLS`);continue;}
    const rends=rezolutiiDinMaster(txt);
    let pick;
    if(!rends.length){
     // Serverul de rezerva e flux direct, fara variante. Il servim ca atare.
     if(k!==idx)console.log(`[FAILOVER] ${c.name}: server ${idx+1} mort -> server ${k+1} (flux direct)`);
     res.set("Content-Type","application/vnd.apple.mpegurl");
     res.set("Cache-Control","no-store");
     return res.send(rewriteM3U8(txt,r.finalUrl,c.id,k));
    }
    if(k===idx && rends[rid]) pick=rends[rid];
    else { // alt server: cea mai apropiata inaltime
     const tinta=h>0?h:(rends[rid]?rends[rid].h:0);
     pick=rends.reduce((a,b)=>Math.abs(b.h-tinta)<Math.abs(a.h-tinta)?b:a);
     console.log(`[FAILOVER] ${c.name}: server ${idx+1} mort -> server ${k+1}, ${tinta}p cerut, servesc ${pick.h}p`);
    }
    // Servim un master redus la varianta aleasa, ca sa NU pierdem subtitrarile.
    const idxPick=rends.indexOf(pick);
    const red=masterRedus(txt,idxPick);
    if(red){
     console.log(`[DOOM HLS] ${c.name} server ${k+1} | ${pick.h}p | ${red.subtitrari?red.subtitrari+" piste de subtitrare":"fara subtitrari"}`);
     res.set("Content-Type","application/vnd.apple.mpegurl");
     res.set("Cache-Control","no-store");
     return res.send(rewriteM3U8(red.text,r.finalUrl,c.id,k));
    }
    // Rezerva: daca nu am putut reconstrui masterul, servim copilul direct.
    const r2=await fetchCuReincercari(abs(r.finalUrl,pick.url),upstreamHeaders(v),2);
    console.log(`[DOOM HLS] ${c.name} server ${k+1} | ${pick.h}p | copil direct, fara subtitrari`);
    res.set("Content-Type","application/vnd.apple.mpegurl");
    res.set("Cache-Control","no-store");
    return res.send(rewriteM3U8(r2.body.toString("utf8"),r2.finalUrl,c.id,k));
   }catch(e){console.warn(`[FAILOVER] ${c.name} server ${k+1}: ${e.message}`);}
  }
  res.status(502).send("toate serverele au picat");
 }
 app.get("/play/:id/:idx/r/:rid/:h/master.m3u8",(rq,rs)=>serveRezolutie(rq,rs,Number(rq.params.h)||0));
 app.get("/play/:id/:idx/r/:rid/master.m3u8",(rq,rs)=>serveRezolutie(rq,rs,0)); // ruta veche, compatibilitate

 // Proxy child playlists, segments, encryption keys and maps.
 app.get("/hls/:id/:idx/:u",async(req,res)=>{
  const c=iface._raultvGetChannel(req.params.id); const idx=Number(req.params.idx);
  const v=c&&c.variants[idx]; if(!v)return res.status(404).end();
  let target; try{target=decodeU(req.params.u)}catch{return res.status(400).end()}
  try{
   const r=await fetchCuReincercari(target,upstreamHeaders(v),3);
   const ct=(r.headers["content-type"]||"").toLowerCase();
   const isM3u8=ct.includes("mpegurl")||target.toLowerCase().includes(".m3u8")||r.body.slice(0,20).toString().includes("#EXTM3U");
   if(isM3u8){
    res.set("Content-Type","application/vnd.apple.mpegurl");
    return res.send(rewriteM3U8(r.body.toString("utf8"),r.finalUrl,c.id,idx));
   }
   if(r.headers["content-type"])res.set("Content-Type",r.headers["content-type"]);
   if(r.headers["content-length"])res.set("Content-Length",r.headers["content-length"]);
   res.set("Cache-Control","no-store");
   res.send(r.body);
  }catch(e){console.error("[PROXY media]",e.message);res.status(502).end()}
 });

 app.listen(PORT,HOST,()=>{
  console.log("");
  console.log("  RaulTV pornit.");
  console.log("");
  console.log("  Pe calculatorul asta:");
  console.log(`     http://127.0.0.1:${PORT}/manifest.json`);
  if(HOST==="0.0.0.0"&&IP){
   console.log("");
   console.log("  De pe TV, telefon sau tableta (aceeasi retea Wi-Fi):");
   console.log(`     http://${IP}:${PORT}/manifest.json`);
   console.log("");
   console.log("  Daca nu merge de pe TV, e aproape sigur firewall-ul Windows.");
   console.log("  La prima pornire apare o fereastra - apasa 'Permite accesul'.");
  }else if(HOST!=="0.0.0.0"){
   console.log("");
   console.log("  Asculta DOAR local (HOST="+HOST+"). De pe TV nu se poate conecta.");
  }else{
   console.log("");
   console.log("  Nu am gasit un IP de retea locala. Esti conectat la Wi-Fi sau cablu?");
  }
  console.log("");
 });
})().catch(e=>{console.error(e);process.exit(1)});
