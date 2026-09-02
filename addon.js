const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const SOURCES = [
  {name:"HMLendea RO", url:"https://raw.githubusercontent.com/hmlendea/iptv-playlist/master/ro.m3u", priority:20},
  {name:"IPTV-org RO", url:"https://iptv-org.github.io/iptv/countries/ro.m3u", priority:10}
];
const CACHE_MS = Number(process.env.CACHE_MS || 10*60*1000);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT || 8000);

const manifest = {
  id:"ro.raultv.tv.v14_1", version:"14.1.0", name:"RaulTV",
  description:"RaulTV v14.1 • Live TV România • catalog tolerant la timeout • servere fallback",
  resources:["catalog","meta","stream"], types:["tv"], idPrefixes:["raultv:"],
  catalogs:[
    {type:"tv",id:"all",name:"RaulTV • Toate",extra:[{name:"search",isRequired:false}]},
    {type:"tv",id:"news",name:"RaulTV • Știri"},
    {type:"tv",id:"sport",name:"RaulTV • Sport"},
    {type:"tv",id:"documentary",name:"RaulTV • Documentare"},
    {type:"tv",id:"kids",name:"RaulTV • Copii"},
    {type:"tv",id:"music",name:"RaulTV • Muzică"},
    {type:"tv",id:"local",name:"RaulTV • Locale"},
    {type:"tv",id:"general",name:"RaulTV • General"}
  ]
};
const builder = new addonBuilder(manifest);
let cache={at:0,channels:[]}, loading=null;

const clean=s=>(s||"").replace(/^RO:\s*/i,"").replace(/\s+/g," ").trim();
const canonical=s=>clean(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
 .replace(/\b(uhd|fhd|hd|sd|4k|2160p?|1080p?|720p?|576p?|480p?)\b/g," ")
 .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
const slug=s=>canonical(s).replace(/\s+/g,"-")||"channel";
function attrs(s){const o={};for(const m of s.matchAll(/([\w-]+)="([^"]*)"/g))o[m[1]]=m[2];return o}
function cat(name,declared=""){
 const t=(name+" "+declared).toLowerCase();
 if(/documentar|history|discovery|nature|natura|travel|animal/.test(t))return"documentary";
 if(/copii|kids|junior|cartoon|desene|nick|minimax/.test(t))return"kids";
 if(/sport|fotbal|football/.test(t))return"sport";
 if(/digi24|realitatea|romania tv|românia tv|euronews|news|stiri|știri|aleph/.test(t))return"news";
 if(/music|muzic|kiss|magic|rock|atomic|mooz|dance|trace|manele/.test(t))return"music";
 if(/local|regional|arad|cluj|iasi|iași|buzau|buzău|craiova|timisoara|timișoara|mures|mureș|suceava|constanta|constanța|arges|argeș/.test(t))return"local";
 return"general";
}
function parse(text,src){
 const out=[];let info=null,extgrp="";
 for(const raw of String(text).split(/\r?\n/)){
  const line=raw.trim();
  if(line.startsWith("#EXTGRP:")){extgrp=line.slice(8).trim();continue}
  if(line.startsWith("#EXTINF")){
   const a=attrs(line), comma=line.indexOf(",");
   info={name:clean(comma>=0?line.slice(comma+1):a["tvg-name"]||"Canal"),logo:a["tvg-logo"]||"",group:a["group-title"]||extgrp||""};
   extgrp=""; continue;
  }
  if(info && /^https?:\/\//i.test(line)){
   out.push({id:slug(info.name),key:canonical(info.name),name:info.name,logo:info.logo,
    group:cat(info.name,info.group),declaredGroup:info.group,url:line,source:src.name,priority:src.priority});
   info=null;
  }
 }
 return out;
}
async function fetchSource(src){
 try{
  const r=await axios.get(src.url,{timeout:TIMEOUT,responseType:"text",maxRedirects:5,
   headers:{"User-Agent":"Mozilla/5.0 RaulTV/14.1"}});
  return parse(r.data,src);
 }catch(e){console.error(`[RaulTV] ${src.name}: ${e.message}`);return[]}
}
async function refresh(){
 const rows=(await Promise.all(SOURCES.map(fetchSource))).flat();
 const map=new Map();
 for(const x of rows){
  if(!x.key)continue;
  if(!map.has(x.key))map.set(x.key,{id:x.id,name:x.name,logo:x.logo,group:x.group,declaredGroup:x.declaredGroup,servers:[]});
  const c=map.get(x.key);
  if(!c.logo&&x.logo)c.logo=x.logo;
  if(!c.servers.some(s=>s.url===x.url))c.servers.push(x);
 }
 // v14.1: NU eliminăm canalul pentru că un probe/timeout a eșuat.
 const channels=[...map.values()].filter(c=>c.servers.length).sort((a,b)=>a.name.localeCompare(b.name,"ro"));
 if(channels.length) cache={at:Date.now(),channels};
 console.log(`[RaulTV] catalog: ${channels.length} canale`);
 return channels.length?channels:cache.channels;
}
async function load(){
 if(cache.channels.length && Date.now()-cache.at<CACHE_MS)return cache.channels;
 if(!loading)loading=refresh().finally(()=>loading=null);
 return await loading;
}
function meta(c){return{id:"raultv:"+c.id,type:"tv",name:c.name,poster:c.logo||undefined,posterShape:"square",
 description:`${c.servers.length} server(e) • ${c.declaredGroup||c.group}`}}
builder.defineCatalogHandler(async args=>{
 let c=await load(); if(args.id!=="all")c=c.filter(x=>x.group===args.id);
 const q=(args.extra?.search||"").toLowerCase().trim(); if(q)c=c.filter(x=>x.name.toLowerCase().includes(q));
 return{metas:c.map(meta)};
});
builder.defineMetaHandler(async({id})=>{const c=(await load()).find(x=>"raultv:"+x.id===id);return{meta:c?meta(c):null}});
builder.defineStreamHandler(async({id})=>{
 const c=(await load()).find(x=>"raultv:"+x.id===id); if(!c)return{streams:[]};
 const servers=[...c.servers].sort((a,b)=>b.priority-a.priority);
 return{streams:servers.map((s,i)=>({name:`RaulTV • Server ${i+1}`,title:`${c.name} • ${s.source}`,url:s.url,
  behaviorHints:{notWebReady:false}}))};
});
module.exports=builder.getInterface();
