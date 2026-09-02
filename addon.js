const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const PLAYLISTS = [
  { name:"HMLendea RO", url:"https://raw.githubusercontent.com/hmlendea/iptv-playlist/master/ro.m3u", priority:20 },
  { name:"IPTV-org RO", url:"https://iptv-org.github.io/iptv/countries/ro.m3u", priority:10 }
];

const CACHE_MS = Number(process.env.CACHE_MS || 10 * 60 * 1000);
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT || 7000);
const PROBE_TIMEOUT = Number(process.env.PROBE_TIMEOUT || 3500);
const PROBE_CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 12);

const manifest = {
  id:"ro.raultv.tv.v14",
  version:"14.0.0",
  name:"RaulTV",
  description:"RaulTV v14 • Live TV România • surse publice • fallback • verificare HLS • categorii",
  resources:["catalog","meta","stream"],
  types:["tv"],
  catalogs:[
    {type:"tv",id:"all",name:"RaulTV • Toate",extra:[{name:"search",isRequired:false}]},
    {type:"tv",id:"news",name:"RaulTV • Știri"},
    {type:"tv",id:"sport",name:"RaulTV • Sport"},
    {type:"tv",id:"documentary",name:"RaulTV • Documentare"},
    {type:"tv",id:"kids",name:"RaulTV • Copii"},
    {type:"tv",id:"music",name:"RaulTV • Muzică"},
    {type:"tv",id:"local",name:"RaulTV • Locale"},
    {type:"tv",id:"general",name:"RaulTV • General"}
  ],
  idPrefixes:["raultv:"]
};

const builder = new addonBuilder(manifest);
let cache={ at:0, channels:[] };
let loading=null;

function normalizeName(s=""){
  return s.replace(/^RO:\s*/i,"").replace(/\s+/g," ").trim();
}
function canonical(s=""){
  return normalizeName(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\b(uhd|fhd|hd|sd|4k|2160p?|1080p?|720p?|576p?|480p?)\b/g," ")
    .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function slug(s=""){
  return canonical(s).replace(/\s+/g,"-") || "channel";
}
function parseAttrs(s=""){
  const o={};
  for(const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) o[m[1]]=m[2];
  return o;
}
function category(name, declared=""){
  const t=(name+" "+declared).toLowerCase();
  if(/documentar|documentary|history|discovery|nature|natura|travel|animal/.test(t)) return "documentary";
  if(/copii|kids|junior|cartoon|desene|nick|minimax/.test(t)) return "kids";
  if(/sport|fotbal|football/.test(t)) return "sport";
  if(/digi24|realitatea|romania tv|românia tv|euronews|news|stiri|știri|aleph/.test(t)) return "news";
  if(/music|muzic|kiss|magic|rock|atomic|mooz|dance|trace|manele/.test(t)) return "music";
  if(/local|regional|arad|cluj|iasi|iași|buzau|buzău|craiova|timisoara|timișoara|mures|mureș|suceava|constanta|constanța|arges|argeș/.test(t)) return "local";
  return "general";
}
function parseM3U(text, source){
  const out=[]; let current=null, extgrp="";
  for(const raw of String(text).split(/\r?\n/)){
    const line=raw.trim();
    if(line.startsWith("#EXTGRP:")) { extgrp=line.slice(8).trim(); continue; }
    if(line.startsWith("#EXTINF")){
      const comma=line.indexOf(",");
      const attrs=parseAttrs(line);
      current={
        name:normalizeName(comma>=0?line.slice(comma+1):attrs["tvg-name"]||"Canal"),
        logo:attrs["tvg-logo"]||"",
        declaredGroup:attrs["group-title"]||extgrp||""
      };
      extgrp="";
      continue;
    }
    if(current && /^https?:\/\//i.test(line)){
      out.push({
        key:canonical(current.name), id:slug(current.name), name:current.name,
        logo:current.logo, group:category(current.name,current.declaredGroup),
        declaredGroup:current.declaredGroup, url:line, source:source.name,
        sourcePriority:source.priority
      });
      current=null;
    }
  }
  return out;
}
function qualityRank(h,fps,bw){
  return (h||0)*100000000 + (fps||0)*1000000 + (bw||0);
}
async function inspectStream(s){
  if(!/^https?:\/\//i.test(s.url)) return {...s,healthy:false};
  try{
    const r=await axios.get(s.url,{
      timeout:PROBE_TIMEOUT,
      responseType:"text",
      maxRedirects:5,
      headers:{"User-Agent":"Mozilla/5.0 RaulTV/14","Accept":"application/vnd.apple.mpegurl,application/x-mpegURL,*/*"},
      validateStatus:x=>x>=200&&x<400
    });
    const body=String(r.data||"");
    if(!/\.m3u8(?:\?|$)/i.test(s.url) && !body.includes("#EXTM3U"))
      return {...s,healthy:true,height:0,fps:0,bandwidth:0,label:"AUTO",playUrl:s.url};

    let best={height:0,fps:0,bandwidth:0,url:s.url};
    const lines=body.split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      if(!lines[i].includes("#EXT-X-STREAM-INF")) continue;
      const inf=lines[i];
      const rm=inf.match(/RESOLUTION=\d+x(\d+)/i);
      const fm=inf.match(/FRAME-RATE=([\d.]+)/i);
      const bm=inf.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
      const candidate={
        height:rm?Number(rm[1]):0,
        fps:fm?Number(fm[1]):0,
        bandwidth:bm?Number(bm[1]):0,
        url:s.url
      };
      let j=i+1;
      while(j<lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
      if(j<lines.length){
        try { candidate.url=new URL(lines[j].trim(),s.url).href; } catch {}
      }
      if(qualityRank(candidate.height,candidate.fps,candidate.bandwidth)>qualityRank(best.height,best.fps,best.bandwidth)) best=candidate;
    }
    const label=best.height ? `${best.height}p${best.fps>=45?Math.round(best.fps):""}` : "HLS";
    return {...s,healthy:true,...best,label,playUrl:best.url||s.url};
  } catch {
    return {...s,healthy:false,height:0,fps:0,bandwidth:0,label:"OFFLINE",playUrl:s.url};
  }
}
async function mapLimit(items,limit,fn){
  const result=new Array(items.length); let next=0;
  async function worker(){
    while(true){
      const i=next++; if(i>=items.length) return;
      result[i]=await fn(items[i]);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return result;
}
async function refresh(){
  const raw=[];
  await Promise.all(PLAYLISTS.map(async src=>{
    try{
      const r=await axios.get(src.url,{timeout:FETCH_TIMEOUT,responseType:"text",
        headers:{"User-Agent":"Mozilla/5.0 RaulTV/14"}});
      raw.push(...parseM3U(r.data,src));
    }catch(e){ console.error(`[RaulTV] playlist indisponibil: ${src.name}: ${e.message}`); }
  }));
  const grouped=new Map();
  for(const x of raw){
    if(!x.key) continue;
    if(!grouped.has(x.key)) grouped.set(x.key,{
      id:x.id,name:x.name,logo:x.logo,group:x.group,declaredGroup:x.declaredGroup,servers:[]
    });
    const c=grouped.get(x.key);
    if(!c.logo && x.logo) c.logo=x.logo;
    if(!c.declaredGroup && x.declaredGroup) { c.declaredGroup=x.declaredGroup; c.group=category(c.name,x.declaredGroup); }
    if(!c.servers.some(v=>v.url===x.url)) c.servers.push(x);
  }
  const allServers=[...grouped.values()].flatMap(c=>c.servers);
  const checked=await mapLimit(allServers,PROBE_CONCURRENCY,inspectStream);
  const byUrl=new Map(checked.map(s=>[s.url,s]));
  const channels=[];
  for(const c of grouped.values()){
    c.servers=c.servers.map(s=>byUrl.get(s.url)).filter(s=>s&&s.healthy);
    c.servers.sort((a,b)=>
      qualityRank(b.height,b.fps,b.bandwidth)-qualityRank(a.height,a.fps,a.bandwidth) ||
      b.sourcePriority-a.sourcePriority
    );
    if(c.servers.length) channels.push(c);
  }
  channels.sort((a,b)=>a.name.localeCompare(b.name,"ro"));
  cache={at:Date.now(),channels};
  console.log(`[RaulTV] ${channels.length} canale online / ${allServers.length} URL-uri verificate`);
  return channels;
}
async function load(){
  if(cache.channels.length && Date.now()-cache.at<CACHE_MS) return cache.channels;
  if(!loading) loading=refresh().finally(()=>loading=null);
  try { return await loading; }
  catch(e) { console.error("[RaulTV] refresh error",e.message); return cache.channels; }
}
function meta(c){
  return {
    id:"raultv:"+c.id,type:"tv",name:c.name,poster:c.logo||undefined,posterShape:"square",
    description:`${c.servers.length} server(e) online • ${c.declaredGroup||c.group}`
  };
}
builder.defineCatalogHandler(async args=>{
  let channels=await load();
  if(args.id!=="all") channels=channels.filter(c=>c.group===args.id);
  const q=(args.extra&&args.extra.search||"").toLowerCase().trim();
  if(q) channels=channels.filter(c=>c.name.toLowerCase().includes(q));
  return {metas:channels.map(meta)};
});
builder.defineMetaHandler(async ({id})=>{
  const c=(await load()).find(x=>"raultv:"+x.id===id);
  return {meta:c?meta(c):null};
});
builder.defineStreamHandler(async ({id})=>{
  const c=(await load()).find(x=>"raultv:"+x.id===id);
  if(!c) return {streams:[]};
  return {streams:c.servers.map((s,i)=>({
    name:`RaulTV • ${s.label} • S${i+1}`,
    title:`${c.name} • ${s.source}${s.bandwidth?` • ${(s.bandwidth/1000000).toFixed(1)} Mbps`:""}`,
    url:s.playUrl||s.url,
    behaviorHints:{notWebReady:false}
  }))};
});
module.exports=builder.getInterface();
