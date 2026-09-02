const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const port = Number(process.env.PORT || 7000);
serveHTTP(addonInterface,{port});
console.log(`RaulTV v14: http://127.0.0.1:${port}/manifest.json`);
