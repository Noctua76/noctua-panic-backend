'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
test('Voice callbacks preserve NCCO and delivery-event facts while excluding payloads from diagnostics',async()=>{
 const logs=[],writes=[];const console={log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)};
 const sandbox={console,process:{env:{ALERT_AUDIO_URL:'https://synthetic.invalid/audio'}},pool:{query:async(sql,params)=>{if(sql.includes('SELECT'))return {rows:[{company_id:1,mode:'incident',incident_id:2,site_id:3,guard_id:4,recipient_phone:'SYNTHETIC_PHONE_CANARY'}]};writes.push({sql,params});return {rows:[]};}},ensureAlertEventsTable:async()=>{}};
 vm.createContext(sandbox);vm.runInContext(section('function answerNcco(',"app.get('/webhooks/answer'")+section('async function eventHook(',"app.get('/webhooks/event'"),sandbox);
 const req={method:'POST',query:{token:'SYNTHETIC_TOKEN_CANARY'},body:{status:'completed',uuid:'SYNTHETIC_UUID_CANARY',detail:'SYNTHETIC_PRIVATE_PROVIDER_DETAIL',timestamp:'2026-11-25T00:00:00Z'}};
 const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;},send(body){this.body=body;return this;}};
 sandbox.answerNcco(req,res);assert.equal(res.body[0].action,'stream');assert.equal(res.body[0].streamUrl[0],'https://synthetic.invalid/audio');
 await sandbox.eventHook(req,res);assert.equal(res.code,200);assert.equal(res.body,'ok');assert.equal(writes.length,1);assert.equal(writes[0].params[12],'SYNTHETIC_UUID_CANARY');assert.equal(JSON.parse(writes[0].params[13]).error,'SYNTHETIC_PRIVATE_PROVIDER_DETAIL');
 const output=JSON.stringify(logs);for(const canary of ['SYNTHETIC_UUID_CANARY','SYNTHETIC_TOKEN_CANARY','SYNTHETIC_PHONE_CANARY','SYNTHETIC_PRIVATE_PROVIDER_DETAIL'])assert.ok(!output.includes(canary));
});
test('affected 5xx response excludes driver details but records bounded SQLSTATE',async()=>{
 let handler;const logs=[];const sandbox={app:{get:(_route,_auth,fn)=>handler=fn},requireAuth(){},getEffectiveAlertRecipients:async()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE_DRIVER_DETAIL'),{code:'23505'});},console:{error:(...args)=>logs.push(args)}};
 vm.runInNewContext(section('app.get("/settings/alert-recipients"','app.post("/settings/alert-recipients"'),sandbox);
 const response={status(n){this.code=n;return this;},json(value){this.body=value;return this;}};
 await handler({auth:{effective_company_id:1}},response);assert.equal(response.code,500);assert.ok(!JSON.stringify(response.body).includes('SYNTHETIC_PRIVATE_DRIVER_DETAIL'));assert.ok(!JSON.stringify(logs).includes('SYNTHETIC_PRIVATE_DRIVER_DETAIL'));assert.ok(JSON.stringify(logs).includes('23505'));
});
