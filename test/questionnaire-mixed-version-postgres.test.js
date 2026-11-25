'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{generateKeyPairSync,randomBytes,randomUUID}=require('node:crypto');
const express=require('express'),{Pool}=require('pg');
const {QuestionnaireService}=require('../questionnaire/service'),{Keyring}=require('../questionnaire/crypto'),{registerQuestionnaireRoutes}=require('../questionnaire/routes'),{assertReleaseFloor}=require('../questionnaire/release-floor');
const baseBackend='8948b767febb47458d9f3ff1f2f36f78c5439246',baseGuard='4d62383e4aab0d928716c84597324c5f8577aa10',floorCommit='8e8e8fd8c3585dde8c8121ffd2c5a76232fceb08';
const backend=path.resolve(__dirname,'..'),guardRoot=process.env.AEGIS_GUARD_SOURCE||path.resolve(backend,'../guard-webapp');
function historical(root,ref,name){return execFileSync('git',['show',ref+':'+name],{cwd:root,encoding:'utf8'});}
function section(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
test('old/new wire compatibility and accepted candidate floor preserve immutable facts',{timeout:30000},async t=>{
 const url=process.env.TEST_DATABASE_URL;assert.ok(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname),'isolated PostgreSQL required');
 const admin=new Pool({connectionString:url}),schema='iq_mixed_'+process.pid+'_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:url,max:4,options:`-c search_path=${schema} -c aegis.questionnaire_development=synthetic-only`});const servers=[];const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-floor-'));
 t.after(async()=>{for(const s of servers)await new Promise(r=>s.close(r));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();fs.rmSync(temp,{recursive:true,force:true});});
 await pool.query(`CREATE TABLE companies(id integer PRIMARY KEY,timezone text);CREATE TABLE sites(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),status text DEFAULT 'active');CREATE TABLE guards(id integer PRIMARY KEY);CREATE TABLE guard_sessions(id integer PRIMARY KEY,guard_id integer,site_id integer,status text DEFAULT 'online',login_time timestamp,logout_time timestamp);CREATE TABLE incidents(id bigserial PRIMARY KEY,company_id integer,site_id integer REFERENCES sites(id),guard_ref integer,status text DEFAULT 'active',trigger_time timestamp);CREATE TABLE incident_guard_responses(id bigserial PRIMARY KEY,incident_id bigint,guard_id integer,site_id integer,session_id integer,question_key text,question_text text,answer text,created_at timestamp DEFAULT now());INSERT INTO companies VALUES(1,'Europe/Athens');INSERT INTO sites(id,company_id) VALUES(1,1);INSERT INTO guards VALUES(1);INSERT INTO guard_sessions(id,guard_id,site_id,login_time) VALUES(10,1,1,(now() AT TIME ZONE 'Europe/Athens')-interval '1 hour')`);
 await pool.query(fs.readFileSync(path.resolve(backend,'questionnaire/development-schema.sql'),'utf8'));
 const pair=generateKeyPairSync('rsa',{modulusLength:3072}),entry={id:'synthetic-floor-v1',publicKey:pair.publicKey.export({type:'spki',format:'pem'}),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),integrityKey:randomBytes(32).toString('base64')};const keys=new Keyring([entry],entry.id);
 const service=new QuestionnaireService({pool,keys,authorize:async()=>{}});await service.initializeSynthetic();const guard={guard_id:1,site_id:1,session_id:10,company_id:1},ctx={companyId:1,actorId:1};
 let aiCalls=0;
 async function start(version){
  const app=express();app.use(express.json());const auth=(req,res,next)=>{if(req.headers.authorization!=='Bearer synthetic-original-session')return res.sendStatus(401);req.guard=guard;next();};
  const runtime={enabled:version==='new',service:()=>service};
  const source=version==='old'?historical(backend,baseBackend,'server.js'):fs.readFileSync(path.join(backend,'server.js'),'utf8');
  vm.runInNewContext(section(source,"app.post(['/incident-log'",'// ACTIVE ADMINS'),{app,pool,requireGuardAuth:auth,questionnaireRuntime:runtime,ensureIncidentGuardResponsesTable:async()=>{},Date,console:{log(){},error(){}},processIncidentLog:async()=>{aiCalls++;throw new Error('AI_MUST_NOT_BE_CALLED');}});
  if(version==='new')registerQuestionnaireRoutes({app,requireAuth:(_req,res)=>res.sendStatus(403),requireGuardAuth:auth,runtime});
  app.use((_req,res)=>res.status(404).json({status:'error',code:'LEGACY_ENDPOINT_UNAVAILABLE'}));const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);return `http://127.0.0.1:${server.address().port}`;
 }
 const origins={old:await start('old'),new:await start('new')};
 const senders={old:historical(guardRoot,baseGuard,'index.html'),new:fs.readFileSync(path.join(guardRoot,'index.html'),'utf8')};
 async function legacyIncident(){return Number((await pool.query("INSERT INTO incidents(company_id,site_id,guard_ref,status,trigger_time) VALUES(1,1,1,'active',now()) RETURNING id")).rows[0].id);}
 const answers={incident_type:'Synthetic type',location:'Synthetic location',actions_taken:'Synthetic actions'};
 async function send(clientVersion,serverVersion,incidentId){
  const sandbox={BACKEND_BASE:origins[serverVersion],getGuardAuthHeaders:()=>({Authorization:'Bearer synthetic-original-session','Content-Type':'application/json'}),matchesIncidentSession:f=>f.sessionId===10,isReadOnlyGuardSession:()=>false,Date,fetch};
  vm.createContext(sandbox);vm.runInContext(section(senders[clientVersion],'async function sendIncidentDetailsToBackend(','// ===== LIVE CLOCK'),sandbox);
  return sandbox.sendIncidentDetailsToBackend(answers,{sessionId:10,incidentId});
 }
 for(const client of ['old','new'])for(const server of ['old','new'])await t.test(`${client} Guard legacy sender to ${server} backend over actual HTTP and PostgreSQL`,async()=>{
  const id=await legacyIncident();const receipt=await send(client,server,id);assert.equal(receipt.responsesSaved,true);assert.equal(receipt.responseCount,3);assert.equal((await pool.query('SELECT count(*) FROM incident_guard_responses WHERE incident_id=$1',[id])).rows[0].count,'3');
 });
 const bound=async()=>Number((await pool.query("INSERT INTO incidents(company_id,site_id,guard_ref,guard_session_id,questionnaire_binding,questionnaire_bound_at,trigger_time) SELECT 1,1,1,10,incident_questionnaire_route,now(),now() FROM sites WHERE id=1 RETURNING id")).rows[0].id);
 await t.test('old sender can finalize only the captured compatible platform default',async()=>{const id=await bound();assert.equal((await send('old','new',id)).responseCount,3);assert.equal((await pool.query('SELECT count(*) FROM incident_guard_responses WHERE incident_id=$1',[id])).rows[0].count,'0');});
 const info=await service.manage(ctx,1,'read'),qid=randomUUID();await service.manage(ctx,1,'save',{expectedRevision:info.draftRevision,content:{title:'Synthetic custom',questions:[{id:qid,prompt:'Synthetic custom question',type:'LONG_TEXT',required:true,maxLength:5000}]}});await service.manage(ctx,1,'publish',{expectedDraftRevision:1,expectedAssignmentRevision:info.assignment.sequence});
 const id=await bound();
 await t.test('old sender cannot map three aliases into a captured custom questionnaire',async()=>{await assert.rejects(send('old','new',id),/QUESTIONNAIRE_CLIENT_UPGRADE_REQUIRED/);assert.equal((await pool.query('SELECT count(*) FROM incident_guard_responses WHERE incident_id=$1',[id])).rows[0].count,'0');});
 const {Controller}=require(path.join(guardRoot,'questionnaire/secure-engine.js'));const packets=new Map(),store={list:async()=>[...packets.values()],put:async p=>packets.set(p.key,p),remove:async key=>packets.delete(key),savePublicKey:async()=>{},readPublicKey:async()=>null};
 const controller=new Controller({baseUrl:origins.new,getHeaders:()=>({Authorization:'Bearer synthetic-original-session'}),store,later:()=>{}});controller.setSession({guard:{id:1,site_id:1},session:{id:10}});const flow=controller.queue({id});await flow.initialization;await controller.update(flow,qid,'Synthetic encrypted new-client evidence');await flow.syncing;
 await t.test('new dynamic client against old backend retains sealed evidence and never reports success',async()=>{
  controller.baseUrl=origins.old;await assert.rejects(controller.submit(flow));assert.equal(flow.state,'RETRY_REQUIRED');assert.ok(packets.size>0);assert.ok(!JSON.stringify([...packets.values()]).includes('Synthetic encrypted new-client evidence'));assert.equal((await pool.query('SELECT count(*) FROM incident_questionnaire_submissions s JOIN incident_questionnaire_snapshots q ON q.id=s.snapshot_id WHERE q.incident_id=$1',[id])).rows[0].count,'0');
 });
 let receipt;
 await t.test('new dynamic client and new backend commit once after compatibility is restored',async()=>{controller.baseUrl=origins.new;receipt=await controller.submit(flow);assert.equal(receipt.responsesSaved,true);assert.equal(packets.size,0);assert.equal(aiCalls,0);});
 await t.test('exact accepted candidate readers replay committed receipts and preserve reports after floor rollback',async()=>{
  const frozenBytes=fs.readFileSync(path.join(__dirname,'fixtures/questionnaire-floor.json'));assert.equal(require('node:crypto').createHash('sha256').update(frozenBytes).digest('hex'),'a774cf8c539dc29f1ba2804d117c9ce0f275ba40b60938d14c77cfc4112454c8');const frozen=JSON.parse(frozenBytes);assert.equal(frozen.acceptedLocalCommit,floorCommit);for(const [name,file] of Object.entries(frozen.files)){assert.match(name,/^questionnaire\/[a-z0-9.-]+$/);const bytes=Buffer.from(file.base64,'base64');assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),file.sha256);const target=path.join(temp,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
  const FloorService=require(path.join(temp,'questionnaire/service.js')).QuestionnaireService;const floor=new FloorService({pool,keys,authorize:async()=>{}});
  const snapshot=(await floor.getQuestionnaire(guard,id)).snapshot;assert.equal(snapshot.questions[0].prompt,'Synthetic custom question');const replay=await floor.submit(guard,id,{protocolVersion:2,snapshotId:snapshot.id,snapshotDigest:snapshot.digest,clientSubmissionId:randomUUID(),answers:[{questionId:qid,value:'Synthetic encrypted new-client evidence'}],omittedOptionalQuestionIds:[]});assert.deepEqual(replay,receipt);assert.deepEqual(await floor.report(ctx,id),await service.report(ctx,id));
  const tree=frozen.acceptedTree,oldTree=execFileSync('git',['rev-parse',baseBackend+'^{tree}'],{cwd:backend,encoding:'utf8'}).trim();
  const manifest={status:'REVIEWED_COMPATIBILITY_FLOOR',allowedBackendTrees:[tree],protocolFloor:2,immutableSnapshots:true,custodyReaders:true,receiptRecovery:true};
  assert.deepEqual(assertReleaseFloor({manifest,source:{tree},encryptedEvidencePresent:true,requiredKeyIds:[entry.id],availableKeyIds:[entry.id]}),{compatible:true,productionAuthorization:false});
  assert.throws(()=>assertReleaseFloor({manifest,source:{tree:oldTree},encryptedEvidencePresent:true,requiredKeyIds:[entry.id],availableKeyIds:[entry.id]}),/SOURCE_BELOW_APPROVED_COMPATIBILITY_FLOOR/);
  assert.throws(()=>assertReleaseFloor({manifest,source:{tree},encryptedEvidencePresent:true,requiredKeyIds:[entry.id],availableKeyIds:[]}),/HISTORICAL_KEY_ACCESS_REQUIRED/);
 });
});
