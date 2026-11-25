const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),c=require('node:crypto');
const {Pool}=require('pg'),express=require('express'),puppeteer=require('puppeteer');
const {QuestionnaireService}=require('../questionnaire/service'),{Keyring}=require('../questionnaire/crypto'),{registerQuestionnaireRoutes}=require('../questionnaire/routes');
const guardRoot=process.env.AEGIS_GUARD_SOURCE||path.resolve(__dirname,'../../guard-webapp');
test('actual mobile Chromium PWA and PostgreSQL: consecutive panics, receipts, encrypted restart and session isolation',{timeout:100000},async()=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url&&['127.0.0.1','localhost'].includes(new URL(url).hostname));
 const admin=new Pool({connectionString:url}),schema='iq_browser_'+process.pid+'_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:url,max:4,options:`-c search_path=${schema} -c aegis.questionnaire_development=synthetic-only`});
 let browser,server,worker,workerPool,workerHold,legacyUnavailable=false,lostReceipt=false,submissionAttempts=0;const dispatches=[],consoleCanaries=[],outbound=[];
 try{
  await pool.query(`CREATE TABLE companies(id integer PRIMARY KEY,timezone text);CREATE TABLE sites(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),name text,location text,status text DEFAULT 'active');CREATE TABLE guards(id integer PRIMARY KEY,full_name text,username text);CREATE TABLE guard_sessions(id integer PRIMARY KEY,guard_id integer REFERENCES guards(id),site_id integer REFERENCES sites(id),login_time timestamp,logout_time timestamp,status text DEFAULT 'online');CREATE TABLE incidents(id bigserial PRIMARY KEY,incident_ref text,company_id integer,site_id integer REFERENCES sites(id),guard_ref integer,status text,priority text,trigger_time timestamp,resolved_time timestamp,auto_reset_time timestamp,ai_summary text,needs_support boolean,incident_latitude numeric,incident_longitude numeric,incident_accuracy integer,incident_battery_level integer,incident_address text,incident_location_timestamp timestamp,created_at timestamp);INSERT INTO companies VALUES(1,'Europe/Athens'),(2,'Europe/Athens');INSERT INTO sites(id,company_id,name,location) VALUES(1,1,'Synthetic A','Synthetic location'),(2,2,'Synthetic B','Synthetic location');INSERT INTO guards VALUES(1,'Synthetic A','synthetic-a'),(2,'Synthetic B','synthetic-b'),(3,'Synthetic Preview','synthetic-preview');INSERT INTO guard_sessions(id,guard_id,site_id,login_time) VALUES(10,1,1,NOW() AT TIME ZONE 'Europe/Athens'),(20,2,2,NOW() AT TIME ZONE 'Europe/Athens'),(30,3,2,NOW() AT TIME ZONE 'Europe/Athens');`);
  await pool.query(fs.readFileSync(path.resolve(__dirname,'../questionnaire/development-schema.sql'),'utf8'));
  const pair=c.generateKeyPairSync('rsa',{modulusLength:3072}),key={id:'synthetic-browser-key',publicKey:pair.publicKey.export({type:'spki',format:'pem'}),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),integrityKey:c.randomBytes(32).toString('base64')};
  const service=new QuestionnaireService({pool,keys:new Keyring([key],key.id)});await service.initializeSynthetic();
  const actors={'Bearer synthetic-A':{company_id:1,site_id:1,guard_id:1,session_id:10,access_mode:'standard'},'Bearer synthetic-B':{company_id:2,site_id:2,guard_id:2,session_id:20,access_mode:'standard'},'Bearer synthetic-P':{company_id:2,site_id:2,guard_id:3,session_id:30,access_mode:'read_only'}};
  function guardAuth(req,res,next){req.guard=actors[req.headers.authorization];if(!req.guard)return res.status(401).json({status:'error'});if(req.guard.access_mode==='read_only'&&!['GET','HEAD'].includes(req.method))return res.status(403).json({status:'error',code:'READ_ONLY_ACCESS'});next();}
  const app=express();app.use(express.json({limit:'100kb'}));
  app.post('/guard/incidents/:incidentId/questionnaire-submission',guardAuth,async(req,res,next)=>{submissionAttempts++;if(!lostReceipt)return next();lostReceipt=false;await service.submit(req.guard,req.params.incidentId,req.body);res.status(503).json({status:"error",code:"SYNTHETIC_RECEIPT_LOST"});});
  const {createQuestionnaireRuntime}=require('../questionnaire/runtime');
  workerPool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:150,options:`-c search_path=${schema} -c aegis.questionnaire_development=synthetic-only`});workerHold=await workerPool.connect();
  const workerDiagnostics=[];worker=createQuestionnaireRuntime({enabled:true,poolFactory:()=>workerPool,keysFactory:()=>new Keyring([key],key.id),log:()=>workerDiagnostics.push('RECOVERABLE')});
  const runtime={enabled:true,captureColumns:', questionnaire_binding, guard_session_id, questionnaire_bound_at',captureValues:', s.incident_questionnaire_route, $12::int, NOW()',enqueue:incidentId=>worker.enqueue(incidentId),service:()=>service};
  const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8'),a=source.indexOf("app.post('/alert'"),b=source.indexOf('// Vonage delivery webhooks',a);
  vm.runInNewContext(source.slice(a,b),{app,pool,requireGuardAuth:guardAuth,questionnaireRuntime:runtime,Date,console:{log(){},error(){}},reverseGeocode:async()=> 'Synthetic address',alertDispatcher:{dispatchAlertNotifications:async args=>{dispatches.push(args);return {notifications:{sms:[{phone:'synthetic',status:'submitted'}],voice:[{phone:'synthetic',status:'submitted'}]}};}}});
  app.put('/guard/incidents/:incidentId/legacy-questionnaire-draft',guardAuth,(_req,res,next)=>legacyUnavailable?res.status(503).json({status:'error',code:'SYNTHETIC_INTERRUPTED_MIGRATION'}):next());
  registerQuestionnaireRoutes({app,requireAuth:(_q,r)=>r.sendStatus(403),requireGuardAuth:guardAuth,runtime});
  for(const route of ['/guard/heartbeat','/guard/location','/guard/logout'])app.post(route,guardAuth,(_req,res)=>res.json({status:'ok'}));
  app.use((req,res,next)=>{if(req.method!=='GET')return res.json({status:'ok'});next();});
  let origin;app.get('/config.js',(_req,res)=>res.type('application/javascript').send(`window.AEGIS_CONFIG={backendBase:${JSON.stringify(origin)}};`));
  app.use((req,res)=>{const pathname=new URL(req.url,'http://synthetic.test').pathname,file=path.resolve(guardRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(guardRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.status(404).end();res.setHeader('Cache-Control','no-store');const ext=path.extname(file);res.type(({'.js':'application/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'})[ext]||'application/octet-stream');let body=fs.readFileSync(file);if(['.html','.js'].includes(ext))body=body.toString().replaceAll('__BUILD_VERSION__','synthetic-browser-v1');res.send(body);});
  server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Synthetic) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36');
  await page.setRequestInterception(true);page.on('request',r=>{if(r.url().startsWith(origin)||/^(data:|about:|blob:)/.test(r.url()))r.continue();else{outbound.push(r.url());r.abort();}});page.on('console',m=>{if(m.text().includes('synthetic-secret'))consoleCanaries.push(m.text());});
  const A={guard:{id:1,site_id:1,full_name:'Synthetic A',access_mode:'standard'},session:{id:10,site_id:1},guard_session_token:'synthetic-A'};
  await page.evaluateOnNewDocument(session=>{localStorage.setItem('aegis_guard_session',JSON.stringify(session));localStorage.setItem('guard_session_token',session.guard_session_token);},A);
  await page.goto(origin,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>typeof handleAlertConfirmed==='function'&&currentGuardSession?.session?.id===10);
  await page.evaluate(async()=>{await handleAlertConfirmed();await handleAlertConfirmed();});
  await page.waitForFunction(()=>document.querySelectorAll('#secure-incident-assistant [data-flow] textarea').length===6,{timeout:25000});
  const ids=await page.evaluate(()=>[...document.querySelectorAll('#secure-incident-assistant [data-flow]')].map(n=>n.dataset.flow));assert.equal(ids.length,2);assert.equal(dispatches.length,2);
  async function fill(key,text){await page.evaluate(({key,text})=>{const card=[...document.querySelectorAll('[data-flow]')].find(n=>n.dataset.flow===key);for(const input of card.querySelectorAll('textarea,input[data-question]')){input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));}},{key,text});await page.waitForFunction(key=>{const f=[...secureQuestionnaireController.flows.values()].find(f=>f.key===key);return f?.state==='SERVER_CHECKPOINTED';},{},key);}
  await fill(ids[0],'synthetic-secret-first');await fill(ids[1],'synthetic-secret-second');
  const first=await page.evaluate(key=>secureQuestionnaireController.flows.get(key).incidentId,ids[0]);lostReceipt=true;
  await page.evaluate(key=>{const f=secureQuestionnaireController.flows.get(key);void secureQuestionnaireController.submit(f).catch(()=>{});},ids[0]);
  await page.waitForFunction(key=>secureQuestionnaireController.flows.get(key)?.state==='RETRY_REQUIRED',{timeout:7000},ids[0]).catch(async error=>{console.log('SYNTHETIC_RECEIPT_DIAGNOSTIC',JSON.stringify({attempts:submissionAttempts,flows:await page.evaluate(()=>[...secureQuestionnaireController.flows.values()].map(f=>({id:f.incidentId,state:f.state,error:f.error,submitting:f.submitting})))}));throw error;});await pool.query("UPDATE incidents SET status='resolved' WHERE id=$1",[first]);
  const quota=await page.evaluate(async key=>{
   const c=secureQuestionnaireController,f=c.flows.get(key),put=c.store.put.bind(c.store);c.store.put=async()=>{throw new DOMException('Synthetic quota','QuotaExceededError');};
   let rejected=false,reloadBlocked=false;
   try{await c.update(f,f.snapshot.questions[0].id,'synthetic-secret-quota');}catch{rejected=true;}
   try{await c.flushLocal();}catch{reloadBlocked=true;}
   const ram=f.answers[f.snapshot.questions[0].id],storage=JSON.stringify(await c.store.list());c.store.put=put;
   await c.update(f,f.snapshot.questions[0].id,'synthetic-secret-second');
   return {rejected,reloadBlocked,ram,plaintext:storage.includes('synthetic-secret-quota')};
  },ids[1]);assert.deepEqual(quota,{rejected:true,reloadBlocked:true,ram:'synthetic-secret-quota',plaintext:false});
  await page.setOfflineMode(true);await page.reload({waitUntil:'domcontentloaded',timeout:8000}).catch(()=>{});
  assert.ok(!(await page.content()).includes('synthetic-secret-second'),'offline restart must not expose recovered plaintext');
  await page.setOfflineMode(false);await page.goto(origin,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>secureQuestionnaireController.flows.size===1&&[...secureQuestionnaireController.flows.values()][0].state==='SERVER_CHECKPOINTED',{timeout:15000});
  assert.ok(!(await page.content()).includes('synthetic-secret-second'),'answers are value properties, never interpolated HTML');
  const restored=await page.evaluate(()=>[...secureQuestionnaireController.flows.values()].map(f=>({id:f.incidentId,answers:f.answers})));assert.equal(restored.length,1);assert.ok(Object.values(restored[0].answers).every(v=>v==='synthetic-secret-second'));
  const storage=await page.evaluate(async()=>({local:JSON.stringify({...localStorage}),packets:JSON.stringify(await secureQuestionnaireController.store.list()),caches:await caches.keys()}));assert.ok(!storage.local.includes('synthetic-secret'));assert.ok(!storage.packets.includes('synthetic-secret'));assert.deepEqual(storage.caches,[]);
  const B={guard:{id:2,site_id:2,full_name:'Synthetic B',access_mode:'standard'},session:{id:20,site_id:2},guard_session_token:'synthetic-B'};
  await page.evaluate(session=>{localStorage.setItem('guard_session_token',session.guard_session_token);localStorage.setItem('aegis_guard_session',JSON.stringify(session));showMainApp(session);},B);
  assert.equal(await page.$eval('#secure-incident-assistant',e=>e.classList.contains('hidden')),true);await page.evaluate(()=>handleAlertConfirmed());
  await page.waitForFunction(()=>document.querySelectorAll('#secure-incident-assistant [data-flow] textarea').length===3,{timeout:25000});
  const keyB=await page.evaluate(()=>[...secureQuestionnaireController.flows.keys()][0]);await fill(keyB,'synthetic-secret-B');await page.evaluate(key=>secureQuestionnaireController.submit(secureQuestionnaireController.flows.get(key)),keyB);
  assert.equal(await page.$eval('.status-badge',e=>e.textContent),'Live ενημέρωση');
  const remaining=await page.evaluate(()=>secureQuestionnaireController.store.list());assert.equal(remaining.length,1);assert.equal(remaining[0].identity.guardId,1);assert.equal(remaining[0].identity.sessionId,10);
  assert.equal(consoleCanaries.length,0);assert.deepEqual(outbound,[]);assert.equal(dispatches.length,3);assert.ok(workerDiagnostics.length>0,'saturated questionnaire pool must fail recoverably while all alerts dispatch');
  const legacyId=Number((await pool.query("INSERT INTO incidents(company_id,site_id,guard_ref,status,trigger_time) VALUES(1,1,1,'active',now()) RETURNING id")).rows[0].id);
  const legacy={guardId:1,sessionId:10,incidentId:legacyId,answers:{incident_type:'synthetic-secret-legacy'},questionIndex:1,draft:'synthetic-secret-unfinished',dueAt:Date.now()};
  legacyUnavailable=true;
  const interrupted=await page.evaluate(async({session,legacy})=>{
   localStorage.setItem('guard_session_token',session.guard_session_token);localStorage.setItem('aegis_guard_session',JSON.stringify(session));showMainApp(session);
   const key=`aegis-incident-questionnaire-v2:${legacy.sessionId}:${legacy.incidentId}`;localStorage.setItem(key,JSON.stringify(legacy));
   let failed=false;try{await secureQuestionnaireController.restoreLegacy();}catch{failed=true;}
   return {failed,plaintextPreserved:localStorage.getItem(key)!==null,sealed:(await secureQuestionnaireController.store.list()).some(p=>p.kind==='legacy'&&p.identity.incidentId===legacy.incidentId)};
  },{session:A,legacy});assert.deepEqual(interrupted,{failed:true,plaintextPreserved:true,sealed:true});
  legacyUnavailable=false;
  const migrated=await page.evaluate(async legacy=>{
   const recovered=await secureQuestionnaireController.restoreLegacy();const flow=recovered.find(f=>f.incidentId===legacy.incidentId);
   return {plaintextRemoved:localStorage.getItem(`aegis-incident-questionnaire-v2:${legacy.sessionId}:${legacy.incidentId}`)===null,answer:flow?.answers.incident_type,draft:flow?.draft,packets:JSON.stringify(await secureQuestionnaireController.store.list())};
  },legacy);assert.equal(migrated.plaintextRemoved,true);assert.equal(migrated.answer,legacy.answers.incident_type);assert.equal(migrated.draft,legacy.draft);assert.ok(!migrated.packets.includes('synthetic-secret-legacy'));
  const dir=process.env.AEGIS_TEST_ARTIFACT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'mobile-session-B-completed.png'),fullPage:true});fs.writeFileSync(path.join(dir,'browser-summary.json'),JSON.stringify({browser:await browser.version(),mode:'Android-compatible Chromium emulation, not physical Android',database:'actual isolated PostgreSQL',syntheticDispatches:dispatches.length,externalRequests:outbound.length,plaintextAnswerStorage:false,cacheStorageEntries:storage.caches.length,legacyInterruptedMigration:'PRESERVED_THEN_VERIFIED_CUSTODY',quotaFailure:'RAM_ONLY_RELOAD_BLOCKED',offlineRestart:'NO_PLAINTEXT_ONLINE_RECOVERY',workerPoolSaturation:'ALERT_DISPATCH_UNBLOCKED',lostReceiptAfterResolution:'PASS',crossSessionIsolation:'PASS'},null,2));}
 }finally{await browser?.close();workerHold?.release();await worker?.stop();if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
