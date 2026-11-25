const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {randomUUID,generateKeyPairSync,randomBytes}=require('node:crypto');const {Pool}=require('pg');
const {QuestionnaireService}=require('../questionnaire/service');const {Keyring}=require('../questionnaire/crypto');const {fail}=require('../questionnaire/contract');
const url=process.env.TEST_DATABASE_URL;
test('real PostgreSQL questionnaire integrity, concurrency, custody, receipts and isolation',{skip:!url&&'TEST_DATABASE_URL required'},async t=>{
 assert.ok(['localhost','127.0.0.1','::1'].includes(new URL(url).hostname),'Synthetic database must be loopback');
 const admin=new Pool({connectionString:url});const schema='iq_test_'+process.pid+'_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:url,max:4,options:`-c search_path=${schema} -c aegis.questionnaire_development=synthetic-only`});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query(`CREATE TABLE companies(id integer PRIMARY KEY);CREATE TABLE sites(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),status text DEFAULT 'active');CREATE TABLE guards(id integer PRIMARY KEY);CREATE TABLE guard_sessions(id integer PRIMARY KEY,guard_id integer REFERENCES guards(id),site_id integer REFERENCES sites(id),status text DEFAULT 'online',logout_time timestamp);CREATE TABLE incidents(id bigserial PRIMARY KEY,company_id integer REFERENCES companies(id),site_id integer REFERENCES sites(id),guard_ref integer REFERENCES guards(id),status text DEFAULT 'active');INSERT INTO companies VALUES(1),(2);INSERT INTO sites(id,company_id) VALUES(1,1),(2,2);INSERT INTO guards VALUES(1),(2);INSERT INTO guard_sessions(id,guard_id,site_id) VALUES(10,1,1),(20,2,2),(11,1,1);`);
 await pool.query(fs.readFileSync(require.resolve('../questionnaire/development-schema.sql'),'utf8'));
 const pair=generateKeyPairSync('rsa',{modulusLength:3072});const entry={id:'synthetic-v1',publicKey:pair.publicKey.export({type:'spki',format:'pem'}),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),integrityKey:randomBytes(32).toString('base64')};const keys=new Keyring([entry],entry.id);
 const svc=new QuestionnaireService({pool,keys,authorize:async(_db,context)=>{if(context.role!=='authorized')fail('PERMISSION_DENIED',403);}});
 await svc.initializeSynthetic();const ctx={companyId:1,actorId:1,role:'authorized'},guard={company_id:1,site_id:1,guard_id:1,session_id:10};
 async function incident(){return (await pool.query(`INSERT INTO incidents(company_id,site_id,guard_ref,guard_session_id,questionnaire_binding,questionnaire_bound_at) SELECT 1,1,1,10,incident_questionnaire_route,now() FROM sites WHERE id=1 RETURNING id`)).rows[0].id;}
 const iid=await incident(),original=await svc.getQuestionnaire(guard,iid);
 await t.test('fixed original wording, stable IDs and explicit session ownership',async()=>{
  assert.equal(original.snapshot.questions.length,3);assert.match(original.snapshot.questions[0].prompt,/π.χ./);
  for(const g of [{...guard,company_id:2},{...guard,site_id:2},{...guard,guard_id:2},{...guard,session_id:11}])await assert.rejects(svc.getQuestionnaire(g,iid),e=>e.status===404);
  await assert.rejects(svc.manage({...ctx,companyId:2},1,'read'),e=>e.status===404);
  await assert.rejects(svc.manage({...ctx,role:'viewer'},1,'read'),e=>e.status===403);
 });
 await t.test('revision conflicts and immutable publication leave captured incidents unchanged',async()=>{
  const info=await svc.manage(ctx,1,'read');const content={title:'Synthetic custom',questions:[{id:randomUUID(),prompt:'Synthetic custom prompt',help:'',type:'SHORT_TEXT',required:true,maxLength:500},{id:randomUUID(),prompt:'Optional synthetic',type:'LONG_TEXT',required:false,maxLength:5000}]};
  await svc.manage(ctx,1,'save',{expectedRevision:0,content});
  await assert.rejects(svc.manage(ctx,1,'save',{expectedRevision:0,content}),e=>e.status===409);
  const pub=await svc.manage(ctx,1,'publish',{expectedDraftRevision:1,expectedAssignmentRevision:info.assignment.sequence});
  assert.equal(pub.assignment.mode,'CUSTOM');assert.equal((await svc.getQuestionnaire(guard,iid)).snapshot.id,original.snapshot.id);
  const changed=await svc.getQuestionnaire(guard,await incident());assert.equal(changed.snapshot.questions.length,2);assert.equal(changed.snapshot.title,'Synthetic custom');
  await assert.rejects(pool.query(`UPDATE incident_questionnaire_versions SET digest='forged' WHERE id=$1`,[pub.assignment.versionId]),/QUESTIONNAIRE_IMMUTABLE/);
 });
 await t.test('lost receipt retry after resolution, conflict and encrypted facts',async()=>{
  const input={protocolVersion:2,snapshotId:original.snapshot.id,snapshotDigest:original.snapshot.digest,clientSubmissionId:randomUUID(),answers:original.snapshot.questions.map(q=>({questionId:q.id,value:'synthetic-secret-canary'})),omittedOptionalQuestionIds:[]};
  const [a,b]=await Promise.all([svc.submit(guard,iid,input),svc.submit(guard,iid,input)]);assert.deepEqual(a,b);
  await pool.query("UPDATE incidents SET status='resolved' WHERE id=$1",[iid]);
  assert.deepEqual(await svc.submit(guard,iid,{...input,clientSubmissionId:randomUUID()}),a);
  await assert.rejects(svc.submit(guard,iid,{...input,answers:input.answers.map(x=>({...x,value:'changed'}))}),e=>e.status===409);
  const rows=await pool.query('SELECT * FROM incident_questionnaire_responses');assert.equal(rows.rowCount,3);assert.ok(!JSON.stringify(rows.rows).includes('synthetic-secret-canary'));
 });
 await t.test('sealed local ingestion, exact custody replay, authenticated recovery and retention flags',async()=>{
  const incidentId=await incident(),s=(await svc.getQuestionnaire(guard,incidentId)).snapshot;
  const draftId=randomUUID();const identity={companyId:1,siteId:1,guardId:1,sessionId:10,incidentId:Number(incidentId),snapshotId:s.id,snapshotDigest:s.digest,draftId,revision:1};
  const scope=(await pool.query('SELECT scope_id FROM incident_questionnaire_snapshots WHERE id=$1',[s.id])).rows[0].scope_id;
  const value={protocolVersion:2,snapshotId:s.id,snapshotDigest:s.digest,answers:[{questionId:s.questions[0].id,value:'synthetic-draft-canary'}]};
  const input={draftId,expectedRevision:0,revision:1,envelope:keys.seal(scope,'draft-checkpoint',identity,value)};
  const receipt=await svc.checkpoint(guard,incidentId,input);assert.deepEqual(await svc.checkpoint(guard,incidentId,input),receipt);
  const read=await svc.readDraft(guard,incidentId);assert.deepEqual(read.draft,value);
  await assert.rejects(svc.readDraft({...guard,session_id:11},incidentId),e=>e.status===404);
  const dbrow=(await pool.query('SELECT * FROM incident_questionnaire_drafts WHERE id=$1',[draftId])).rows[0];assert.ok(!JSON.stringify(dbrow).includes('synthetic-draft-canary'));
  await pool.query('UPDATE guard_sessions SET logout_time=now() WHERE id=10');
  await assert.rejects(svc.readDraft(guard,incidentId),e=>e.status===404);
  const recovery=await svc.recover(ctx,incidentId,{reason:'SESSION_EXPIRED_REVIEW',draftId});assert.equal(recovery.state,'UNSUBMITTED_EVIDENCE');assert.equal(recovery.originalSessionId,10);
  await assert.rejects(svc.recover({...ctx,companyId:2},incidentId,{reason:'SESSION_EXPIRED_REVIEW'}),e=>e.status===404);
  assert.deepEqual(await svc.markReview(),{enabled:false});assert.deepEqual(await svc.cleanupCommitted(ctx),{enabled:false});
  await pool.query('UPDATE guard_sessions SET logout_time=NULL WHERE id=10');
 });
 await t.test('management row lock and update do not block alert INSERT foreign keys',async()=>{
  const hold=await pool.connect();await hold.query('BEGIN');await hold.query('SELECT id FROM sites WHERE id=1 FOR NO KEY UPDATE');
  try{const alert=await pool.connect();try{await alert.query("SET statement_timeout='800ms'");assert.ok(await alert.query(`INSERT INTO incidents(company_id,site_id,guard_ref,guard_session_id,questionnaire_binding) SELECT 1,1,1,10,incident_questionnaire_route FROM sites WHERE id=1 RETURNING id`));}finally{alert.release();}}finally{await hold.query('ROLLBACK');hold.release();}
 });
 await t.test('actual role revocation, conjunctive grants and owner tenant boundaries precede decryption',async()=>{
  await pool.query(`CREATE TABLE dashboard_roles(id integer PRIMARY KEY,code text,name text,scope text,is_system_role boolean,authorization_version integer,is_active boolean);CREATE TABLE dashboard_permissions(id serial PRIMARY KEY,code text UNIQUE);CREATE TABLE dashboard_role_permissions(role_id integer,permission_id integer);CREATE TABLE user_dashboard_roles(user_id integer PRIMARY KEY,role_id integer);CREATE TABLE admin_sessions(id integer PRIMARY KEY,user_id integer,is_active boolean);INSERT INTO dashboard_roles VALUES(1,'company_administrator','Admin','company',true,1,true),(2,'system_owner','Owner','platform',true,1,true);INSERT INTO user_dashboard_roles VALUES(1,1),(2,2);INSERT INTO admin_sessions VALUES(1,1,true),(2,2,true);INSERT INTO dashboard_permissions(code) VALUES('sites.view'),('sites.manage'),('questionnaires.view'),('questionnaires.draft'),('questionnaires.publish'),('questionnaires.restore'),('exports.view'),('incidents.view');INSERT INTO dashboard_role_permissions SELECT 1,id FROM dashboard_permissions;`);
  const {authorizeDashboard}=require('../questionnaire/authorization');let decryptions=0;const monitored=Object.create(keys);monitored.open=(...args)=>{decryptions++;return keys.open(...args);};
  const service=new QuestionnaireService({pool,keys:monitored,authorize:authorizeDashboard});const auth={session_id:1,user_id:1,effective_company_id:1,actor_company_id:1,company_id:1,role:'company_administrator',access_mode:'standard',permissions:['*'],is_system_owner:true};const real={auth,companyId:1,actorId:1};
  assert.equal((await service.manage(real,1,'read')).status,'ok');
  await pool.query("DELETE FROM dashboard_role_permissions WHERE permission_id=(SELECT id FROM dashboard_permissions WHERE code='questionnaires.view')");const before=decryptions;await assert.rejects(service.manage(real,1,'read'),e=>e.status===403);assert.equal(decryptions,before);
  await pool.query("INSERT INTO dashboard_role_permissions SELECT 1,id FROM dashboard_permissions WHERE code='questionnaires.view'");
  await pool.query("DELETE FROM dashboard_role_permissions WHERE permission_id=(SELECT id FROM dashboard_permissions WHERE code='sites.view')");await assert.rejects(service.manage(real,1,'read'),e=>e.status===403);
  await pool.query("INSERT INTO dashboard_role_permissions SELECT 1,id FROM dashboard_permissions WHERE code='sites.view'");
  const owner={auth:{...auth,session_id:2,user_id:2,effective_company_id:2,tenant_context_active:true,tenant_context_can_mutate:false},companyId:2,actorId:2};
  await assert.rejects(service.manage(owner,1,'read'),e=>e.status===404);await assert.rejects(service.manage(owner,2,'restore',{expectedAssignmentRevision:1,reason:'RESTORE_PLATFORM_DEFAULT'}),e=>e.status===403);
  await pool.query('UPDATE admin_sessions SET is_active=false WHERE id=1');await assert.rejects(service.manage(real,1,'read'),e=>e.status===401);
  await pool.query('UPDATE admin_sessions SET is_active=true WHERE id=1');
  await pool.query('DELETE FROM user_dashboard_roles WHERE user_id=2');
  await assert.rejects(service.manage(owner,2,'read'),e=>e.status===403);
  await pool.query('INSERT INTO user_dashboard_roles VALUES(2,2)');
  const held=await pool.connect();await held.query('BEGIN');
  let revoke;
  try{
   await authorizeDashboard(held,real,'read');
   revoke=pool.query("DELETE /* synthetic_concurrent_questionnaire_revoke */ FROM dashboard_role_permissions WHERE role_id=1 AND permission_id=(SELECT id FROM dashboard_permissions WHERE code='questionnaires.view')");
   let blocked=false;for(let n=0;n<50;n++){
    blocked=Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE query LIKE 'DELETE /* synthetic_concurrent_questionnaire_revoke */%' AND wait_event_type='Lock'")).rowCount);if(blocked)break;await new Promise(r=>setTimeout(r,10));
   }
   assert.equal(blocked,true,'concurrent revoke must linearize after the held authorization decision');
  }finally{await held.query('ROLLBACK');held.release();await revoke;}
  await assert.rejects(service.manage(real,1,'read'),e=>e.status===403);
  await pool.query("INSERT INTO dashboard_role_permissions SELECT 1,id FROM dashboard_permissions WHERE code='questionnaires.view'");
 });
 await t.test('wildcard and platform owner require an explicit fresh evidence-recovery grant',async()=>{
  const {authorizeDashboard}=require('../questionnaire/authorization');
  await pool.query("INSERT INTO dashboard_permissions(code) VALUES('questionnaires.recover'),('incidents.manage'),('*') ON CONFLICT(code) DO NOTHING;INSERT INTO dashboard_role_permissions SELECT 1,id FROM dashboard_permissions WHERE code='*'");
  const reviewer={companyId:1,actorId:1,auth:{session_id:1,user_id:1,effective_company_id:1,company_id:1,actor_company_id:1,access_mode:'standard'}};
  await assert.rejects(svc.tx(db=>authorizeDashboard(db,reviewer,'recover')),e=>e.code==='EXPLICIT_RECOVERY_PERMISSION_REQUIRED');
  const owner={companyId:2,actorId:2,auth:{session_id:2,user_id:2,effective_company_id:2,company_id:1,actor_company_id:1,tenant_context_active:true,tenant_context_can_mutate:true}};
  await assert.rejects(svc.tx(db=>authorizeDashboard(db,owner,'recover')),e=>e.code==='EXPLICIT_RECOVERY_PERMISSION_REQUIRED');
  await pool.query("INSERT INTO dashboard_role_permissions SELECT 1,id FROM dashboard_permissions WHERE code='questionnaires.recover'");
  await svc.tx(db=>authorizeDashboard(db,reviewer,'recover'));
  await pool.query("DELETE FROM dashboard_role_permissions WHERE role_id=1 AND permission_id=(SELECT id FROM dashboard_permissions WHERE code='questionnaires.recover')");
  await assert.rejects(svc.tx(db=>authorizeDashboard(db,reviewer,'recover')),e=>e.code==='EXPLICIT_RECOVERY_PERMISSION_REQUIRED');
  await pool.query("DELETE FROM dashboard_role_permissions WHERE role_id=1 AND permission_id=(SELECT id FROM dashboard_permissions WHERE code='*')");
 });
 await t.test('receipt recovery from a sealed packet remains exact after incident resolution',async()=>{
  const incidentId=await incident(),s=(await svc.getQuestionnaire(guard,incidentId)).snapshot;
  const scope=(await pool.query('SELECT scope_id FROM incident_questionnaire_snapshots WHERE id=$1',[s.id])).rows[0].scope_id;
  const draftId=randomUUID();const value={protocolVersion:2,snapshotId:s.id,snapshotDigest:s.digest,answers:s.questions.filter(q=>q.required).map(q=>({questionId:q.id,value:'Synthetic final canary'}))};
  const identity={companyId:1,siteId:1,guardId:1,sessionId:10,incidentId:Number(incidentId),snapshotId:s.id,snapshotDigest:s.digest,draftId,revision:7};
  const packet={draftId,expectedRevision:0,revision:7,envelope:keys.seal(scope,'draft-checkpoint',identity,value)};await svc.checkpoint(guard,incidentId,packet);
  const receipt=await svc.submit(guard,incidentId,{...value,clientSubmissionId:randomUUID(),omittedOptionalQuestionIds:s.questions.filter(q=>!q.required).map(q=>q.id)});
  await pool.query("UPDATE incidents SET status='resolved' WHERE id=$1",[incidentId]);
  const recovered=await svc.recoverReceipt(guard,incidentId,packet);assert.deepEqual(recovered.receipt,receipt);
  const forgedValue={...value,answers:value.answers.map(a=>({...a,value:'Changed'}))};await assert.rejects(svc.recoverReceipt(guard,incidentId,{...packet,envelope:keys.seal(scope,'draft-checkpoint',identity,forgedValue)}),e=>e.status===409);
 });
 await t.test('legacy unversioned custody preserves partial answers with accepted fail-closed session proof',async()=>{
  await pool.query("ALTER TABLE guard_sessions ADD COLUMN login_time timestamp; ALTER TABLE incidents ADD COLUMN trigger_time timestamp; UPDATE guard_sessions SET login_time=(now() AT TIME ZONE 'Europe/Athens')-interval '1 hour' WHERE id=10; UPDATE guard_sessions SET login_time=(now() AT TIME ZONE 'Europe/Athens')+interval '1 hour' WHERE id=11");
  const i=(await pool.query("INSERT INTO incidents(company_id,site_id,guard_ref,status,trigger_time) VALUES(1,1,1,'active',now()) RETURNING id")).rows[0].id;
  const scope=(await pool.query('SELECT id FROM incident_questionnaire_scopes WHERE company_id=1')).rows[0].id,draftId=randomUUID();
  const identity={companyId:1,siteId:1,guardId:1,sessionId:10,incidentId:Number(i),draftId,revision:1};const value={protocolVersion:1,answers:{incident_type:'Synthetic legacy answer'},questionIndex:1,draft:'Synthetic unfinished legacy draft',dueAt:Date.now()};
  const packet={draftId,expectedRevision:0,revision:1,envelope:keys.seal(scope,'legacy-draft-checkpoint',identity,value)};
  const receipt=await svc.checkpointLegacy(guard,i,packet);assert.equal(receipt.legacyUnversioned,true);assert.equal(receipt.associationStatus,'VERIFIED_SESSION');assert.deepEqual((await svc.readLegacy(guard,i)).draft,value);
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM incident_questionnaire_legacy_drafts')).rows).includes('Synthetic unfinished'));
  await assert.rejects(svc.readLegacy({...guard,session_id:11},i),e=>e.code==='LEGACY_SESSION_ASSOCIATION_UNPROVEN');
  await pool.query('UPDATE guard_sessions SET logout_time=now() WHERE id=10');await assert.rejects(svc.readLegacy(guard,i),e=>e.code==='LEGACY_SESSION_ASSOCIATION_UNPROVEN');
  const reviewed=await svc.recoverLegacy(ctx,i,{reason:'SESSION_EXPIRED_REVIEW',originalSessionId:10});assert.equal(reviewed.state,'UNSUBMITTED_EVIDENCE');assert.equal(reviewed.originalSessionId,10);assert.deepEqual(reviewed.draft,value);
  await assert.rejects(svc.recoverLegacy({...ctx,companyId:2},i,{reason:'SESSION_EXPIRED_REVIEW',originalSessionId:10}),e=>e.status===404);
  assert.equal((await pool.query('SELECT questionnaire_binding FROM incidents WHERE id=$1',[i])).rows[0].questionnaire_binding,null);
  assert.equal((await pool.query('SELECT count(*) FROM incident_questionnaire_submissions WHERE snapshot_id IN (SELECT id FROM incident_questionnaire_snapshots WHERE incident_id=$1)',[i])).rows[0].count,'0');await pool.query('UPDATE guard_sessions SET logout_time=NULL WHERE id=10');
 });
 await t.test('rejected management attempts audit only bounded metadata in a separate transaction',async()=>{
  const {registerQuestionnaireRoutes}=require('../questionnaire/routes');let handler;const expressAdapter={get(){},put(path,_auth,fn){if(path.endsWith('/draft'))handler=fn;},post(){},use(){}};
  const denied=new QuestionnaireService({pool,keys,authorize:async()=>fail('PERMISSION_DENIED',403)});
  registerQuestionnaireRoutes({app:expressAdapter,requireAuth(){},requireGuardAuth(){},runtime:{enabled:true,service:()=>denied}});
  const res={setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  await handler({auth:{effective_company_id:1,user_id:1},params:{siteId:'1'},body:{content:'SYNTHETIC_SECRET_DENIED'}},res);
  assert.equal(res.statusCode,403);const audit=(await pool.query("SELECT * FROM incident_questionnaire_audit_events WHERE action='QUESTIONNAIRE_REJECTED' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(audit.outcome,'DENIED');assert.equal(audit.reason,'PERMISSION_DENIED');assert.ok(!JSON.stringify(audit).includes('SYNTHETIC_SECRET_DENIED'));
 });
 await t.test('mixed clients reject custom mapping and preserve compatible default receipt semantics',async()=>{
  const incompatible=await incident();
  await assert.rejects(svc.submitCompatibleLegacy(guard,incompatible,{incident_type:'Synthetic',location:'Synthetic',actions_taken:'Synthetic'}),e=>e.code==='QUESTIONNAIRE_CLIENT_UPGRADE_REQUIRED');
  assert.equal((await pool.query('SELECT count(*) FROM incident_questionnaire_submissions sub JOIN incident_questionnaire_snapshots q ON q.id=sub.snapshot_id WHERE q.incident_id=$1',[incompatible])).rows[0].count,'0');
  const info=await svc.manage(ctx,1,'read');await svc.manage(ctx,1,'restore',{expectedAssignmentRevision:info.assignment.sequence,reason:'SYNTHETIC_COMPATIBILITY_TEST'});
  const compatible=await incident();const answer={incident_type:'Synthetic type',location:'Synthetic location',actions_taken:'Synthetic actions'};
  const receipt=await svc.submitCompatibleLegacy(guard,compatible,answer);assert.equal(receipt.responseCount,3);
  await pool.query("UPDATE incidents SET status='resolved' WHERE id=$1",[compatible]);assert.deepEqual(await svc.submitCompatibleLegacy(guard,compatible,answer),receipt);
  const draft=await svc.manage(ctx,1,'read');await svc.manage(ctx,1,'publish',{expectedDraftRevision:draft.draftRevision,expectedAssignmentRevision:draft.assignment.sequence});
 });
 await t.test('transaction failure rolls back all facts and preserves the exact checkpoint',async()=>{
  const incidentId=await incident(),snapshot=(await svc.getQuestionnaire(guard,incidentId)).snapshot;
  const input={protocolVersion:2,snapshotId:snapshot.id,snapshotDigest:snapshot.digest,clientSubmissionId:randomUUID(),answers:snapshot.questions.filter(q=>q.required).map(q=>({questionId:q.id,value:'Synthetic rollback evidence'})),omittedOptionalQuestionIds:snapshot.questions.filter(q=>!q.required).map(q=>q.id)};
  await pool.query(`CREATE FUNCTION iq_synthetic_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ROLLBACK'; END $$; CREATE TRIGGER iq_synthetic_reject BEFORE INSERT ON incident_questionnaire_responses FOR EACH ROW EXECUTE FUNCTION iq_synthetic_reject()`);
  try{await assert.rejects(svc.submit(guard,incidentId,input),/SYNTHETIC_ROLLBACK/);assert.equal((await pool.query('SELECT count(*) FROM incident_questionnaire_submissions WHERE snapshot_id=$1',[snapshot.id])).rows[0].count,'0');}
  finally{await pool.query('DROP TRIGGER iq_synthetic_reject ON incident_questionnaire_responses');}
  assert.equal((await svc.submit(guard,incidentId,input)).responsesSaved,true);
 });
 await t.test('encrypted SQL backup restores facts with retained historical keys and compatible readers',async()=>{
  const bin=process.env.AEGIS_PG_BIN||'/usr/bin';
  const {execFileSync}=require('node:child_process'),path=require('node:path');
  const dump=execFileSync(path.join(bin,'pg_dump'),['--dbname',url,'--schema',schema,'--no-owner','--no-privileges'],{timeout:15000,maxBuffer:16*1024*1024}).toString();
  assert.ok(!dump.includes('synthetic-secret-canary'),'backup must not contain answer plaintext');
  const restoredSchema=schema+'_restored',sql=dump.replaceAll(schema,restoredSchema);
  execFileSync(path.join(bin,'psql'),['--dbname',url,'-X','-v','ON_ERROR_STOP=1'],{input:sql,timeout:15000,stdio:['pipe','ignore','pipe']});
  const restored=new Pool({connectionString:url,options:`-c search_path=${restoredSchema}`});
  try{
   const pair2=generateKeyPairSync('rsa',{modulusLength:3072});const next={id:'synthetic-v2',publicKey:pair2.publicKey.export({type:'spki',format:'pem'}),privateKey:pair2.privateKey.export({type:'pkcs8',format:'pem'}),integrityKey:randomBytes(32).toString('base64')};
   const retained=new QuestionnaireService({pool:restored,keys:Keyring.fromEnvironment({QUESTIONNAIRE_KEYRING_BASE64:Buffer.from(JSON.stringify({active:next.id,entries:[entry,next]})).toString('base64')}),authorize:svc.authorize});
   assert.deepEqual(await retained.report(ctx,iid),await svc.report(ctx,iid));
   const missing=new QuestionnaireService({pool:restored,keys:new Keyring([next],next.id),authorize:svc.authorize});await assert.rejects(missing.report(ctx,iid),e=>e.code==='STORAGE_KEY_UNAVAILABLE');
   assert.equal((await restored.query('SELECT count(*) FROM incident_questionnaire_responses')).rows[0].count,(await pool.query('SELECT count(*) FROM incident_questionnaire_responses')).rows[0].count);
  }finally{await restored.end();await admin.query(`DROP SCHEMA ${restoredSchema} CASCADE`);}
 });
 await t.test('legal hold blocks redundant cleanup while unsubmitted evidence is never destroyed',async()=>{
  const row=(await pool.query("SELECT * FROM incident_questionnaire_drafts WHERE state='SUBMITTED' LIMIT 1")).rows[0];assert.ok(row);
  await pool.query("UPDATE incident_questionnaire_drafts SET legal_hold=true,updated_at=now()-interval '2 hours' WHERE id=$1",[row.id]);
  await svc.cleanupCommitted(ctx,{approvedPolicy:true,redundantHours:1});assert.ok((await pool.query('SELECT checkpoint_envelope FROM incident_questionnaire_drafts WHERE id=$1',[row.id])).rows[0].checkpoint_envelope);
  const unsubmitted=(await pool.query("SELECT count(*) FROM incident_questionnaire_drafts WHERE state<>'SUBMITTED'")).rows[0].count;
  await pool.query('UPDATE incident_questionnaire_drafts SET legal_hold=false WHERE id=$1',[row.id]);await svc.cleanupCommitted(ctx,{approvedPolicy:true,redundantHours:1});
  assert.equal((await pool.query('SELECT checkpoint_envelope FROM incident_questionnaire_drafts WHERE id=$1',[row.id])).rows[0].checkpoint_envelope,null);
  assert.equal((await pool.query("SELECT count(*) FROM incident_questionnaire_drafts WHERE state<>'SUBMITTED'")).rows[0].count,unsubmitted);
  assert.ok((await pool.query('SELECT count(*) FROM incident_questionnaire_submissions WHERE snapshot_id=$1',[row.snapshot_id])).rows[0].count>'0');
 });
 await t.test('1000-site global-default activation is atomic and custom sites remain unchanged under concurrent incident insertion',async()=>{
  await svc.tx(async db=>{const initialize=await svc.prepareSiteCreation(db,2,1);for(let n=3;n<=1002;n++){const site=(await db.query('INSERT INTO sites(id,company_id) VALUES($1,2) RETURNING *',[n])).rows[0];await initialize(site);}});
  const customBefore=(await pool.query('SELECT incident_questionnaire_route FROM sites WHERE id=1')).rows[0].incident_questionnaire_route;
  const {platformDefault}=require('../questionnaire/defaults');const before=Date.now();const timings=[];
  const activating=svc.activateDefault(ctx,platformDefault());
  const inserts=Array.from({length:40},async()=>{const start=Date.now();const row=await pool.query(`INSERT INTO incidents(company_id,site_id,guard_ref,guard_session_id,questionnaire_binding,questionnaire_bound_at) SELECT 2,2,2,20,incident_questionnaire_route,now() FROM sites WHERE id=2 RETURNING questionnaire_binding`);timings.push(Date.now()-start);return row.rows[0].questionnaire_binding;});
  const [published,bindings]=await Promise.all([activating,Promise.all(inserts)]);const elapsed=Date.now()-before;
  assert.equal(published.sitesUpdated,1001);const current=(await pool.query('SELECT incident_questionnaire_route FROM sites WHERE id=2')).rows[0].incident_questionnaire_route;
  assert.equal(current.versionId,published.versionId);assert.deepEqual((await pool.query('SELECT incident_questionnaire_route FROM sites WHERE id=1')).rows[0].incident_questionnaire_route,customBefore);
  for(const binding of bindings){const proof=(await pool.query('SELECT version_id,digest FROM site_incident_questionnaire_assignments WHERE id=$1',[binding.assignmentId])).rows[0];assert.equal(binding.versionId,proof.version_id);assert.equal(binding.digest,proof.digest);}
  const versions=(await pool.query("SELECT count(DISTINCT incident_questionnaire_route->>'versionId') AS n FROM sites WHERE incident_questionnaire_route->>'mode'='DEFAULT'")).rows[0].n;assert.equal(versions,'1');
  timings.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({syntheticFleet:1000,activationMs:elapsed,concurrentIncidentInserts:40,incidentP95Ms:timings[Math.floor(timings.length*.95)],incidentMaxMs:timings.at(-1)}));
 });

});
