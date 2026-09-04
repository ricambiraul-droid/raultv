const http = require('http');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const axios = require('axios');
const port = Number(process.env.PORT || 7000);
const router = getRouter(addonInterface);

function cfg(){ return {base:(process.env.TIVIONE_XTREAM_SERVER||'').replace(/\/+$/,''), username:process.env.TIVIONE_XTREAM_USERNAME||'', password:process.env.TIVIONE_XTREAM_PASSWORD||''}; }
async function api(action){ const c=cfg(); if(!c.base||!c.username||!c.password) throw new Error('TiviOne nu este configurat in Environment'); return (await axios.get(c.base+'/player_api.php',{params:{username:c.username,password:c.password,...(action?{action}:{})},timeout:12000,headers:{'User-Agent':'RaulTV/15.6'}})).data; }
async function diagnostics(){
 const account=await api(); const u=account?.user_info||{};
 const [lc,vc,sc]=await Promise.all([api('get_live_categories'),api('get_vod_categories'),api('get_series_categories')]);
 return {version:'15.6.0',configured:true,auth:String(u.auth)==='1',status:u.status||null,expiration:u.exp_date||null,active_connections:u.active_cons||null,max_connections:u.max_connections||null,live_categories:Array.isArray(lc)?lc.length:0,vod_categories:Array.isArray(vc)?vc.length:0,series_categories:Array.isArray(sc)?sc.length:0,note:'Diagnostic metadata only; no video stream is opened.'};
}
const server=http.createServer(async(req,res)=>{
 if(req.url==='/tivione-status'){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store');
  try{res.end(JSON.stringify(await diagnostics(),null,2));}catch(e){res.statusCode=503;res.end(JSON.stringify({version:'15.6.0',configured:!!(cfg().base&&cfg().username&&cfg().password),error:e.message},null,2));} return;
 }
 router(req,res,()=>{res.statusCode=404;res.end('Not found');});
});
server.listen(port,()=>{console.log(`[RaulTV] v15.6 FULL diagnostic pornit pe portul ${port}`);console.log('[RaulTV] manifest: /manifest.json');console.log('[RaulTV] diagnostic: /tivione-status');});
