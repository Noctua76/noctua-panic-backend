const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express'),morgan=require('morgan');
const {sensitiveResponseCache,SAFE_ACCESS_LOG_FORMAT}=require('../security/sensitive-response-cache');
test('actual HTTP sensitive responses prohibit caches and access logs omit query, identity and token canaries',async()=>{
 const logs=[],app=express();app.use(sensitiveResponseCache);app.use(morgan(SAFE_ACCESS_LOG_FORMAT,{stream:{write:value=>logs.push(value)}}));
 app.get('/private',(_req,res)=>res.json({value:'SYNTHETIC_BODY_CANARY'}));
 app.get('/guard/data',(_req,res)=>res.json({value:'SYNTHETIC_BODY_CANARY'}));app.get('/health',(_req,res)=>res.json({status:'ok'}));
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const [url,headers] of [['/guard/data?secret=SYNTHETIC_URL_CANARY',{}],['/private?token=SYNTHETIC_TOKEN_CANARY',{Authorization:'Bearer SYNTHETIC_AUTH_CANARY'}]]){
   const response=await fetch(base+url,{headers});assert.match(response.headers.get('cache-control'),/private, no-store/);assert.equal(response.headers.get('pragma'),'no-cache');assert.equal(response.headers.get('expires'),'0');assert.match(response.headers.get('vary'),/Authorization/);await response.text();
  }
  const health=await fetch(base+'/health');assert.equal(health.headers.get('cache-control'),null);await health.text();
  assert.ok(logs.length>=3);assert.ok(!JSON.stringify(logs).includes('SYNTHETIC_'));assert.ok(logs.every(line=>/^GET \d{3} [\d.]+ ms\n$/.test(line)));
 }finally{await new Promise(resolve=>server.close(resolve));}
});


test('malformed JSON and oversized request failures never echo or log request canaries',async()=>{
 const {createSafeRequestError}=require('../security/sensitive-response-cache');const diagnostics=[],app=express();app.use(sensitiveResponseCache);app.use(express.json({limit:'1kb'}));app.post('/guard/draft',(_req,res)=>res.json({status:'ok'}));app.use(createSafeRequestError((...args)=>diagnostics.push(args)));
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port+'/guard/draft';
 try{for(const [body,status,code] of [['{"secret":"SYNTHETIC_PARSE_CANARY",',400,'INVALID_JSON_REQUEST'],[JSON.stringify({secret:'SYNTHETIC_SIZE_CANARY'.repeat(100)}),413,'PAYLOAD_TOO_LARGE']]){
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body});const json=await response.json();assert.equal(response.status,status);assert.equal(json.code,code);assert.match(response.headers.get('cache-control'),/no-store/);assert.ok(!JSON.stringify(json).includes('SYNTHETIC_'));
 }assert.ok(!JSON.stringify(diagnostics).includes('SYNTHETIC_'));assert.equal(diagnostics.length,2);}finally{await new Promise(resolve=>server.close(resolve));}
});
