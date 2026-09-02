// Pentru gazduire fara server propriu (Vercel, Netlify Functions etc).
// FUNCTIONEAZA DOAR IN MOD=simplu. In MOD=proxy addonul are nevoie de rutele
// /play si /hls, care exista doar in server.js, si toate streamurile ar da 404.
const fs=require("fs"), path=require("path");
const { getRouter } = require("stremio-addon-sdk");
const createAddon = require("./addon");

if(String(process.env.MOD||"simplu").toLowerCase()==="proxy"){
  console.warn("[ATENTIE] MOD=proxy nu merge pe gazduire serverless. Foloseste server.js sau lasa MOD=simplu.");
}

let routerPromise;
module.exports = async function(req,res){
  // Logoul din manifest, servit si de aici.
  if(req.url && req.url.startsWith("/static/logo.svg")){
    try{
      const svg=fs.readFileSync(path.join(__dirname,"static","logo.svg"));
      res.setHeader("Content-Type","image/svg+xml");
      res.setHeader("Cache-Control","public, max-age=86400");
      return res.end(svg);
    }catch{ res.statusCode=404; return res.end(); }
  }
  if(!routerPromise) routerPromise=createAddon().then(i=>getRouter(i));
  const router=await routerPromise;
  return router(req,res,()=>{res.statusCode=404;res.end();});
};
