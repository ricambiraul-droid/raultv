const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const port = Number(process.env.PORT || 7000);
serveHTTP(addonInterface,{port});
console.log(`RaulTV v14.1 pornit pe portul ${port}`);
