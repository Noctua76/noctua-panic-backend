const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
test('incident geocoding preserves results without logging sensitive address or upstream error contents',async()=>{
 const start=source.indexOf('async function reverseGeocode('),end=source.indexOf('app.post("/guard/location"',start);assert.ok(start>0&&end>start);
 const secret='SYNTHETIC_PRIVATE_ADDRESS',logs=[];let fail=false;
 const ctx={console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},fetch:async()=>{if(fail)throw new Error(secret);return {ok:true,json:async()=>({address:{road:secret,house_number:'1',city:'Synthetic'},display_name:secret})};}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 assert.equal(await ctx.reverseGeocode(1,2),secret+' 1, Synthetic');fail=true;assert.equal(await ctx.reverseGeocode(1,2),null);
 assert.ok(!JSON.stringify(logs).includes(secret));assert.ok(logs.some(row=>row[0]==='REVERSE_GEOCODING_FAILED'));
});
