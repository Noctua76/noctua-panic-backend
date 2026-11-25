'use strict';
const {randomUUID}=require('node:crypto');
const {validateDefinition,validateAnswers,fields,id,text,fail,fingerprint,canonical,envelopeFingerprint}=require('./contract');
const {PLATFORM_SCOPE,PLATFORM_DEFINITION,DEFAULT_QUESTIONS,platformDefault}=require('./defaults');
const Q='incident_questionnaire_';
class QuestionnaireService {
 constructor({pool,keys,authorize=async()=>{fail('AUTHORIZATION_REQUIRED',403);}}){this.pool=pool;this.keys=keys;this.authorize=authorize;}
 async tx(work){const db=await this.pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='1500ms'; SET LOCAL statement_timeout='5s'");const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}}
 async audit(db,scope,site,actor,action,reference,reason=null){await db.query(`INSERT INTO ${Q}audit_events(id,scope_id,site_id,actor_id,action,reference_id,outcome,reason) VALUES($1,$2,$3,$4,$5,$6,'SUCCESS',$7)`,[randomUUID(),scope,site,actor,action,reference,reason]);}
 async recordRejected(context,code,siteId=null){
  // Separate transaction after rollback; never include request fields or raw errors.
  if(!context.auth||!Number.isSafeInteger(context.actorId)||context.actorId<1||!Number.isSafeInteger(context.companyId)||!/^[A-Z_]{3,70}$/.test(code))return;
  return this.tx(async db=>{
   const scope=(await db.query(`SELECT id FROM ${Q}scopes WHERE company_id=$1`,[context.companyId])).rows[0];if(!scope)return;
   const site=Number.isSafeInteger(Number(siteId))&&Number(siteId)>0?(await db.query('SELECT id FROM sites WHERE id=$1 AND company_id=$2',[siteId,context.companyId])).rows[0]?.id:null;
   await db.query(`INSERT INTO ${Q}audit_events(id,scope_id,site_id,actor_id,action,outcome,reason) VALUES($1,$2,$3,$4,'QUESTIONNAIRE_REJECTED',$5,$6)`,[randomUUID(),scope.id,site??null,context.actorId,/CONFLICT/.test(code)?'CONFLICT':'DENIED',code]);
  });
 }
 async platformLock(db,exclusive=false){const r=await db.query(`SELECT * FROM ${Q}definitions WHERE id=$1 ${exclusive?'FOR UPDATE':'FOR SHARE'}`,[PLATFORM_DEFINITION]);if(!r.rows[0])fail('QUESTIONNAIRE_NOT_INITIALIZED',503);return r.rows[0];}
 async site(db,company,siteId,lock=false){
  if(!Number.isSafeInteger(Number(company))||!Number.isSafeInteger(Number(siteId)))fail('NOT_FOUND',404);
  const r=await db.query(`SELECT s.*,sc.id AS scope_id FROM sites s JOIN ${Q}scopes sc ON sc.company_id=s.company_id WHERE s.id=$1 AND s.company_id=$2 ${lock?'FOR NO KEY UPDATE OF s':''}`,[siteId,company]);if(!r.rows[0])fail('NOT_FOUND',404);return r.rows[0];
 }
 async definition(db,site){const r=await db.query(`SELECT * FROM ${Q}definitions WHERE site_id=$1 AND scope_id=$2`,[site.id,site.scope_id]);return r.rows[0];}
 async version(db,versionId){
  const r=await db.query(`SELECT v.*,d.site_id FROM ${Q}versions v JOIN ${Q}definitions d ON d.id=v.definition_id WHERE v.id=$1`,[versionId]);const v=r.rows[0];if(!v)fail('QUESTIONNAIRE_VERSION_UNAVAILABLE',503);
  const title=this.keys.open(v.scope_id,'version-title',{versionId:v.id},v.title_envelope).title;
  const rows=await db.query(`SELECT * FROM ${Q}version_questions WHERE version_id=$1 ORDER BY position`,[v.id]);
  const questions=rows.rows.map(q=>({...this.keys.open(v.scope_id,'version-question',{versionId:v.id,questionId:q.question_id},q.content_envelope),id:q.question_id,position:q.position,type:q.type,required:q.required,maxLength:q.max_length,provenance:q.provenance}));
  const clean=validateDefinition({title,questions:questions.map(({position,provenance,...q})=>q)});
  if(this.keys.integrity(v.scope_id,'manifest',clean,v.key_id)!==v.digest)fail('QUESTIONNAIRE_INTEGRITY_FAILURE',503);
  return {...v,title,questions};
 }
 async publishVersion(db,{definitionId,scope,content,actor,provenance}){
  const clean=validateDefinition(content);const versionId=randomUUID();
  const next=await db.query(`SELECT COALESCE(max(version_number),0)+1 AS n FROM ${Q}versions WHERE definition_id=$1`,[definitionId]);
  const digest=this.keys.integrity(scope,'manifest',clean);const envelope=this.keys.seal(scope,'version-title',{versionId},{title:clean.title});
  await db.query(`INSERT INTO ${Q}versions(id,scope_id,definition_id,version_number,title_envelope,digest,key_id,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[versionId,scope,definitionId,next.rows[0].n,envelope,digest,this.keys.active,actor]);
  for(const q of clean.questions){
   await db.query(`INSERT INTO ${Q}question_ids(id,definition_id,scope_id,legacy_alias) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[q.id,definitionId,scope,provenance==='PLATFORM_DEFAULT'?DEFAULT_QUESTIONS.find(x=>x[0]===q.id)?.[1]??null:null]);
   const ownership=await db.query(`SELECT id FROM ${Q}question_ids WHERE id=$1 AND definition_id=$2 AND scope_id=$3`,[q.id,definitionId,scope]);if(!ownership.rowCount)fail('INVALID_QUESTION_ID');
   const enc=this.keys.seal(scope,'version-question',{versionId,questionId:q.id},{prompt:q.prompt,help:q.help});
   await db.query(`INSERT INTO ${Q}version_questions(version_id,scope_id,question_id,position,type,required,max_length,content_envelope,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[versionId,scope,q.id,q.position,q.type,q.required,q.maxLength,enc,provenance]);
  }
  return {id:versionId,scope_id:scope,digest};
 }
 async assign(db,site,version,mode,actor,expected){
  const current=site.incident_questionnaire_route;const sequence=current?.sequence??0;if(sequence!==expected)fail('ASSIGNMENT_REVISION_CONFLICT',409);
  const assignmentId=randomUUID();const capsule={contractVersion:2,assignmentId,scopeId:site.scope_id,sourceScopeId:version.scope_id,versionId:version.id,digest:version.digest,mode,sequence:sequence+1};
  await db.query(`INSERT INTO site_incident_questionnaire_assignments(id,scope_id,company_id,site_id,sequence,mode,source_scope_id,version_id,digest,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[assignmentId,site.scope_id,site.company_id,site.id,capsule.sequence,mode,version.scope_id,version.id,version.digest,actor]);
  await db.query('UPDATE sites SET incident_questionnaire_route=$2 WHERE id=$1',[site.id,capsule]);
  await this.audit(db,site.scope_id,site.id,actor,mode==='DEFAULT'?'RESTORE_DEFAULT':'PUBLISH',assignmentId);return capsule;
 }
 async prepareSiteCreation(db,companyId,actorId){
  const head=await this.platformLock(db); // Before the operational company-number lock.
  return async site=>{
   await db.query(`INSERT INTO ${Q}scopes(id,company_id,kind) VALUES($1,$2,'TENANT') ON CONFLICT(company_id) DO NOTHING`,[randomUUID(),companyId]);
   const scope=(await db.query(`SELECT id FROM ${Q}scopes WHERE company_id=$1`,[companyId])).rows[0].id;
   await db.query(`INSERT INTO ${Q}definitions(id,scope_id,site_id) VALUES($1,$2,$3)`,[randomUUID(),scope,site.id]);
   const v=(await db.query(`SELECT id,scope_id,digest FROM ${Q}versions WHERE id=$1`,[head.active_default_version_id])).rows[0];
   const capsule=await this.assign(db,{...site,scope_id:scope},v,'DEFAULT',actorId,0);site.incident_questionnaire_route=capsule;
  };
 }
 async initializeRelease({actorId=0,expectedKeyId}={}){
  if(actorId!==0||!expectedKeyId||this.keys.active!==expectedKeyId)fail('RELEASE_BOOTSTRAP_NOT_AUTHORIZED',403);
  return this.tx(async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtext('aegis-questionnaire-release-bootstrap'))");
   const migration=await db.query("SELECT 1 FROM schema_migrations WHERE name='2026-11-25-incident-questionnaires.sql'");
   if(!migration.rowCount)fail('QUESTIONNAIRE_MIGRATION_REQUIRED',503);
   await db.query(`INSERT INTO ${Q}scopes(id,kind) VALUES($1,'PLATFORM') ON CONFLICT(id) DO NOTHING`,[PLATFORM_SCOPE]);
   await db.query(`INSERT INTO ${Q}definitions(id,scope_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,[PLATFORM_DEFINITION,PLATFORM_SCOPE]);
   const head=await this.platformLock(db,true);let version;
   if(head.active_default_version_id){const v=await this.version(db,head.active_default_version_id);version={id:v.id,scope_id:v.scope_id,digest:v.digest};}
   else{version=await this.publishVersion(db,{definitionId:PLATFORM_DEFINITION,scope:PLATFORM_SCOPE,content:platformDefault(),actor:actorId,provenance:'PLATFORM_DEFAULT'});await db.query(`UPDATE ${Q}definitions SET active_default_version_id=$2 WHERE id=$1`,[PLATFORM_DEFINITION,version.id]);}
   const sites=await db.query('SELECT s.* FROM sites s JOIN companies c ON c.id=s.company_id ORDER BY s.id FOR NO KEY UPDATE OF s');let assigned=0;
   for(const site of sites.rows){
    if(site.incident_questionnaire_route)continue; // Never overwrite later valid publications.
    await db.query(`INSERT INTO ${Q}scopes(id,company_id,kind) VALUES($1,$2,'TENANT') ON CONFLICT(company_id) DO NOTHING`,[randomUUID(),site.company_id]);
    const sc=(await db.query(`SELECT id FROM ${Q}scopes WHERE company_id=$1`,[site.company_id])).rows[0];site.scope_id=sc.id;
    await db.query(`INSERT INTO ${Q}definitions(id,scope_id,site_id) VALUES($1,$2,$3) ON CONFLICT(site_id) DO NOTHING`,[randomUUID(),sc.id,site.id]);
    await this.assign(db,site,version,'DEFAULT',actorId,0);assigned++;
   }
   return {status:'ok',keyId:expectedKeyId,defaultVersionId:version.id,sitesInspected:sites.rowCount,sitesAssigned:assigned,systemActorId:0};
  });
 }
 async initializeSynthetic(actor=1){
  // Explicit isolated setup only; never called by server startup or migrations.
  return this.tx(async db=>{
   const check=await db.query("SELECT current_setting('aegis.questionnaire_development',true) AS mode");if(check.rows[0].mode!=='synthetic-only')fail('SYNTHETIC_ENVIRONMENT_REQUIRED',403);
   await db.query(`INSERT INTO ${Q}scopes(id,kind) VALUES($1,'PLATFORM')`,[PLATFORM_SCOPE]);
   await db.query(`INSERT INTO ${Q}definitions(id,scope_id) VALUES($1,$2)`,[PLATFORM_DEFINITION,PLATFORM_SCOPE]);
   const v=await this.publishVersion(db,{definitionId:PLATFORM_DEFINITION,scope:PLATFORM_SCOPE,content:platformDefault(),actor,provenance:'PLATFORM_DEFAULT'});
   await db.query(`UPDATE ${Q}definitions SET active_default_version_id=$2 WHERE id=$1`,[PLATFORM_DEFINITION,v.id]);
   const sites=await db.query('SELECT * FROM sites ORDER BY id');
   for(const site of sites.rows){let sc=await db.query(`SELECT id FROM ${Q}scopes WHERE company_id=$1`,[site.company_id]);if(!sc.rowCount){sc=await db.query(`INSERT INTO ${Q}scopes(id,company_id,kind) VALUES($1,$2,'TENANT') RETURNING id`,[randomUUID(),site.company_id]);}site.scope_id=sc.rows[0].id;await db.query(`INSERT INTO ${Q}definitions(id,scope_id,site_id) VALUES($1,$2,$3)`,[randomUUID(),site.scope_id,site.id]);await this.assign(db,site,v,'DEFAULT',actor,0);}
   return v;
  });
 }
 async manage(context,siteId,operation,input={}){
  return this.tx(async db=>{
   await this.authorize(db,context,operation);await this.platformLock(db);const site=await this.site(db,context.companyId,siteId,operation!=='read');
   if(operation!=='read'&&site.status&&site.status!=='active')fail('SITE_NOT_ACTIVE',409);
   const def=await this.definition(db,site);if(!def)fail('QUESTIONNAIRE_NOT_INITIALIZED',503);
   if(operation==='read'){
    const version=await this.version(db,site.incident_questionnaire_route?.versionId);
    const history=await db.query(`SELECT a.id,a.sequence,a.mode,a.version_id,a.actor_id,a.created_at,v.version_number FROM site_incident_questionnaire_assignments a JOIN ${Q}versions v ON v.id=a.version_id WHERE a.site_id=$1 AND a.scope_id=$2 ORDER BY a.sequence DESC LIMIT 50`,[site.id,site.scope_id]);
    return {status:'ok',assignment:site.incident_questionnaire_route,draftRevision:def.draft_revision,draft:def.draft_envelope?this.keys.open(site.scope_id,'configuration-draft',{definitionId:def.id,revision:def.draft_revision},def.draft_envelope):null,version:{id:version.id,number:version.version_number,publishedAt:version.published_at,publishedBy:version.published_by,title:version.title,questions:version.questions},history:history.rows};
   }
   if(operation==='save'){
    fields(input,['expectedRevision','content']);if(input.expectedRevision!==def.draft_revision)fail('DRAFT_REVISION_CONFLICT',409);
    const clean=validateDefinition(input.content);const revision=def.draft_revision+1;
    const enc=this.keys.seal(site.scope_id,'configuration-draft',{definitionId:def.id,revision},clean);
    await db.query(`UPDATE ${Q}definitions SET draft_revision=$2,draft_envelope=$3 WHERE id=$1`,[def.id,revision,enc]);await this.audit(db,site.scope_id,site.id,context.actorId,'SAVE_DRAFT',def.id);return {status:'ok',draftRevision:revision};
   }
   if(operation==='publish'){
    fields(input,['expectedDraftRevision','expectedAssignmentRevision']);if(input.expectedDraftRevision!==def.draft_revision||!def.draft_envelope)fail('DRAFT_REVISION_CONFLICT',409);
    const stored=this.keys.open(site.scope_id,'configuration-draft',{definitionId:def.id,revision:def.draft_revision},def.draft_envelope);
    const content={title:stored.title,questions:stored.questions.map(({position,...q})=>q)};
    const v=await this.publishVersion(db,{definitionId:def.id,scope:site.scope_id,content,actor:context.actorId,provenance:'COMPANY_CUSTOM'});
    const assignment=await this.assign(db,site,v,'CUSTOM',context.actorId,input.expectedAssignmentRevision);return {status:'ok',assignment};
   }
   if(operation==='restore'){
    fields(input,['expectedAssignmentRevision','reason']);text(input.reason,240,true);
    const head=await this.platformLock(db);const v=await this.version(db,head.active_default_version_id);const assignment=await this.assign(db,site,v,'DEFAULT',context.actorId,input.expectedAssignmentRevision);return {status:'ok',assignment};
   }
   fail('UNKNOWN_QUESTIONNAIRE_OPERATION',404);
  });
 }
 async activateDefault(context,content){return this.tx(async db=>{
  await this.authorize(db,context,'platform');const head=await this.platformLock(db,true);
  const v=await this.publishVersion(db,{definitionId:head.id,scope:PLATFORM_SCOPE,content,actor:context.actorId,provenance:'PLATFORM_DEFAULT'});
  const sites=await db.query(`SELECT s.*,sc.id AS scope_id FROM sites s JOIN ${Q}scopes sc ON sc.company_id=s.company_id WHERE s.incident_questionnaire_route->>'mode'='DEFAULT' ORDER BY s.id FOR NO KEY UPDATE OF s`);
  for(const site of sites.rows)await this.assign(db,site,v,'DEFAULT',context.actorId,site.incident_questionnaire_route.sequence);
  await db.query(`UPDATE ${Q}definitions SET active_default_version_id=$2 WHERE id=$1`,[head.id,v.id]);await this.audit(db,PLATFORM_SCOPE,null,context.actorId,'ACTIVATE_DEFAULT',v.id);return {status:'ok',versionId:v.id,sitesUpdated:sites.rowCount};
 });}
 async incident(db,guard,incidentId,lock=false){
  if(!guard||![guard.company_id,guard.site_id,guard.guard_id,guard.session_id].every(v=>Number.isSafeInteger(Number(v))&&Number(v)>0))fail('NOT_FOUND',404);
  const r=await db.query(`SELECT i.*,sc.id AS scope_id FROM incidents i JOIN sites s ON s.id=i.site_id JOIN ${Q}scopes sc ON sc.company_id=s.company_id JOIN guard_sessions gs ON gs.id=i.guard_session_id AND gs.guard_id=i.guard_ref AND gs.site_id=i.site_id WHERE i.id=$1 AND i.company_id=$2 AND s.company_id=$2 AND i.site_id=$3 AND i.guard_ref=$4 AND i.guard_session_id=$5 AND gs.logout_time IS NULL AND gs.status IN ('online','active') FOR SHARE OF gs ${lock?'FOR NO KEY UPDATE OF i':''}`,[incidentId,guard.company_id,guard.site_id,guard.guard_id,guard.session_id]);if(!r.rows[0])fail('NOT_FOUND',404);return r.rows[0];
 }
 async snapshot(db,incident){
  const binding=incident.questionnaire_binding;if(!binding||binding.contractVersion!==2||binding.scopeId!==incident.scope_id)fail('QUESTIONNAIRE_BINDING_UNAVAILABLE',503);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,722))",['questionnaire-snapshot:'+incident.id]);
  let row=(await db.query(`SELECT * FROM ${Q}snapshots WHERE incident_id=$1 AND scope_id=$2`,[incident.id,incident.scope_id])).rows[0];
  if(!row){
   const proof=await db.query('SELECT * FROM site_incident_questionnaire_assignments WHERE id=$1 AND scope_id=$2 AND site_id=$3 AND company_id=$4 AND version_id=$5 AND digest=$6',[binding.assignmentId,incident.scope_id,incident.site_id,incident.company_id,binding.versionId,binding.digest]);if(!proof.rowCount)fail('QUESTIONNAIRE_BINDING_UNAVAILABLE',503);
   const v=await this.version(db,binding.versionId);if(v.scope_id!==binding.sourceScopeId||v.digest!==binding.digest)fail('QUESTIONNAIRE_INTEGRITY_FAILURE',503);
   const snapshotId=randomUUID();const title=this.keys.seal(incident.scope_id,'snapshot-title',{snapshotId},{title:v.title});
   row=(await db.query(`INSERT INTO ${Q}snapshots(id,incident_id,scope_id,company_id,site_id,guard_id,session_id,assignment_id,source_scope_id,version_id,digest,title_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[snapshotId,incident.id,incident.scope_id,incident.company_id,incident.site_id,incident.guard_ref,incident.guard_session_id,binding.assignmentId,binding.sourceScopeId,v.id,v.digest,title])).rows[0];
   for(const q of v.questions){const enc=this.keys.seal(incident.scope_id,'snapshot-question',{snapshotId,questionId:q.id},{prompt:q.prompt,help:q.help});await db.query(`INSERT INTO ${Q}snapshot_questions(snapshot_id,scope_id,question_id,position,type,required,max_length,provenance,content_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[snapshotId,incident.scope_id,q.id,q.position,q.type,q.required,q.maxLength,q.provenance,enc]);}
  }
  const rows=await db.query(`SELECT * FROM ${Q}snapshot_questions WHERE snapshot_id=$1 AND scope_id=$2 ORDER BY position`,[row.id,incident.scope_id]);
  return {...row,title:this.keys.open(row.scope_id,'snapshot-title',{snapshotId:row.id},row.title_envelope).title,questions:rows.rows.map(q=>({...this.keys.open(row.scope_id,'snapshot-question',{snapshotId:row.id,questionId:q.question_id},q.content_envelope),id:q.question_id,position:q.position,type:q.type,required:q.required,maxLength:q.max_length,provenance:q.provenance}))};
 }
 async initializeBoundIncident(incidentId){return this.tx(async db=>{
  const i=(await db.query(`SELECT i.*,sc.id AS scope_id FROM incidents i JOIN sites s ON s.id=i.site_id JOIN ${Q}scopes sc ON sc.company_id=s.company_id WHERE i.id=$1 AND i.company_id=s.company_id AND i.guard_session_id IS NOT NULL`,[incidentId])).rows[0];
  if(!i)fail('QUESTIONNAIRE_BINDING_UNAVAILABLE',503);const s=await this.snapshot(db,i);return {snapshotId:s.id};
 });}
 async listPending(guard){
  const rows=await this.pool.query(`SELECT i.id,i.questionnaire_bound_at FROM incidents i JOIN sites st ON st.id=i.site_id JOIN guard_sessions gs ON gs.id=i.guard_session_id AND gs.guard_id=i.guard_ref AND gs.site_id=i.site_id LEFT JOIN ${Q}snapshots q ON q.incident_id=i.id LEFT JOIN ${Q}submissions sub ON sub.snapshot_id=q.id WHERE i.company_id=$1 AND st.company_id=$1 AND i.site_id=$2 AND i.guard_ref=$3 AND i.guard_session_id=$4 AND gs.logout_time IS NULL AND gs.status IN ('online','active') AND i.questionnaire_binding IS NOT NULL AND sub.id IS NULL ORDER BY i.id DESC LIMIT 100`,[guard.company_id,guard.site_id,guard.guard_id,guard.session_id]);
  return {status:'ok',incidents:rows.rows.map(i=>({id:Number(i.id),dueAt:new Date(i.questionnaire_bound_at).getTime()+15000}))};
 }
 async getQuestionnaire(guard,incidentId){return this.tx(async db=>{const i=await this.incident(db,guard,incidentId);const s=await this.snapshot(db,i);return {status:'ok',state:'READY',protocolVersion:2,incidentId:Number(i.id),snapshot:{id:s.id,digest:s.digest,versionId:s.version_id,title:s.title,questions:s.questions}};});}
 async submit(guard,incidentId,input){return this.tx(async db=>{
  const i=await this.incident(db,guard,incidentId,true),s=await this.snapshot(db,i);const clean=validateAnswers(s,input);
  const existing=(await db.query(`SELECT * FROM ${Q}submissions WHERE snapshot_id=$1 AND scope_id=$2`,[s.id,s.scope_id])).rows[0];
  if(existing){if(this.keys.integrity(s.scope_id,'submission',clean,existing.integrity_key_id)!==existing.integrity)fail('SUBMISSION_CONFLICT',409);return this.keys.open(s.scope_id,'receipt',{snapshotId:s.id,submissionId:existing.id},existing.receipt_envelope);}
  if(!['active','in_progress'].includes(i.status))fail('INCIDENT_NOT_OPEN',409);
  const submissionId=randomUUID();const receipt={status:'ok',protocolVersion:2,incidentId:Number(i.id),snapshotId:s.id,snapshotDigest:s.digest,submissionId,clientSubmissionId:input.clientSubmissionId,payloadDigest:fingerprint(clean),responsesSaved:true,questionCount:s.questions.length,answeredCount:clean.answers.length,omittedOptionalQuestionIds:clean.omittedOptionalQuestionIds};
  await db.query(`INSERT INTO ${Q}submissions(id,snapshot_id,scope_id,client_submission_id,integrity,integrity_key_id,receipt_envelope,answered_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[submissionId,s.id,s.scope_id,input.clientSubmissionId,this.keys.integrity(s.scope_id,'submission',clean),this.keys.active,this.keys.seal(s.scope_id,'receipt',{snapshotId:s.id,submissionId},receipt),clean.answers.length]);
  for(const answer of clean.answers)await db.query(`INSERT INTO ${Q}responses(submission_id,snapshot_id,scope_id,question_id,answer_envelope) VALUES($1,$2,$3,$4,$5)`,[submissionId,s.id,s.scope_id,answer.questionId,this.keys.seal(s.scope_id,'answer',{snapshotId:s.id,submissionId,questionId:answer.questionId},{value:answer.value})]);
  await db.query(`UPDATE ${Q}drafts SET state='SUBMITTED',updated_at=now() WHERE snapshot_id=$1 AND scope_id=$2`,[s.id,s.scope_id]);return receipt;
 });}
 async report(context,incidentId,operation='report') {return this.tx(async db=>{
  await this.authorize(db,context,operation);
  const i=(await db.query(`SELECT i.*,sc.id AS scope_id FROM incidents i JOIN sites s ON s.id=i.site_id JOIN ${Q}scopes sc ON sc.company_id=s.company_id WHERE i.id=$1 AND i.company_id=$2 AND s.company_id=$2`,[incidentId,context.companyId])).rows[0];
  if(!i)fail('NOT_FOUND',404);if(!i.questionnaire_binding)return null;
  const s=await this.snapshot(db,i);const sub=(await db.query(`SELECT * FROM ${Q}submissions WHERE snapshot_id=$1 AND scope_id=$2`,[s.id,s.scope_id])).rows[0];
  const rows=sub?(await db.query(`SELECT * FROM ${Q}responses WHERE submission_id=$1 AND snapshot_id=$2 AND scope_id=$3`,[sub.id,s.id,s.scope_id])).rows:[];
  const responses=s.questions.map(q=>{const row=rows.find(a=>a.question_id===q.id);return {question_key:q.id,question_text:q.prompt,answer:row?this.keys.open(s.scope_id,'answer',{snapshotId:s.id,submissionId:sub.id,questionId:q.id},row.answer_envelope).value:(sub?'Optional answer omitted':'Not submitted'),position:q.position,type:q.type,required:q.required,provenance:q.provenance,omitted:Boolean(sub&&!row),submitted:Boolean(sub),created_at:sub?.submitted_at??null};});
  return {snapshotId:s.id,versionId:s.version_id,digest:s.digest,submitted:Boolean(sub),responses};
 });}
 async submitCompatibleLegacy(guard,incidentId,answers){
  const lookup=await this.pool.query(`SELECT questionnaire_binding FROM incidents WHERE id=$1 AND company_id=$2 AND site_id=$3 AND guard_ref=$4`,[incidentId,guard.company_id,guard.site_id,guard.guard_id]);
  if(!lookup.rows[0])fail('NOT_FOUND',404);if(!lookup.rows[0].questionnaire_binding)return null;
  const binding=lookup.rows[0].questionnaire_binding;
  if(binding.mode!=='DEFAULT'||binding.sourceScopeId!==PLATFORM_SCOPE)fail('QUESTIONNAIRE_CLIENT_UPGRADE_REQUIRED',409);
  const info=await this.getQuestionnaire(guard,incidentId);
  const version=(await this.pool.query(`SELECT version_number FROM ${Q}versions WHERE id=$1 AND definition_id=$2`,[binding.versionId,PLATFORM_DEFINITION])).rows[0];
  if(version?.version_number!==1||info.snapshot.questions.length!==3||DEFAULT_QUESTIONS.some(([qid,,prompt],i)=>info.snapshot.questions[i].id!==qid||info.snapshot.questions[i].prompt!==prompt))fail('QUESTIONNAIRE_CLIENT_UPGRADE_REQUIRED',409);
  const result=await this.submit(guard,incidentId,{protocolVersion:2,snapshotId:info.snapshot.id,snapshotDigest:info.snapshot.digest,clientSubmissionId:randomUUID(),answers:DEFAULT_QUESTIONS.map(([questionId,alias])=>({questionId,value:answers[alias]})),omittedOptionalQuestionIds:[]});
  return {status:'ok',incidentId:result.incidentId,responsesSaved:true,responseCount:3};
 }
 async recoverReceipt(guard,incidentId,input){return this.tx(async db=>{
  fields(input,['draftId','expectedRevision','revision','envelope']);id(input.draftId);
  const i=await this.incident(db,guard,incidentId),s=await this.snapshot(db,i);
  const identity={companyId:Number(i.company_id),siteId:Number(i.site_id),guardId:Number(i.guard_ref),sessionId:Number(i.guard_session_id),incidentId:Number(i.id),snapshotId:s.id,snapshotDigest:s.digest,draftId:input.draftId,revision:input.revision};
  const draft=this.keys.open(s.scope_id,'draft-checkpoint',identity,input.envelope);fields(draft,['protocolVersion','snapshotId','snapshotDigest','answers']);
  const clean=validateAnswers(s,{...draft,clientSubmissionId:randomUUID(),omittedOptionalQuestionIds:[]});
  const sub=(await db.query(`SELECT * FROM ${Q}submissions WHERE snapshot_id=$1 AND scope_id=$2`,[s.id,s.scope_id])).rows[0];
  if(!sub||this.keys.integrity(s.scope_id,'submission',clean,sub.integrity_key_id)!==sub.integrity)fail('SUBMISSION_CONFLICT',409);
  return {status:'ok',draft,verifiedEnvelopeDigest:envelopeFingerprint(input.envelope),receipt:this.keys.open(s.scope_id,'receipt',{snapshotId:s.id,submissionId:sub.id},sub.receipt_envelope)};
 });}
 async checkpoint(guard,incidentId,input){return this.tx(async db=>{
  const i=await this.incident(db,guard,incidentId,true),s=await this.snapshot(db,i);
  return this.checkpointRecord(db,i,s,input);
 });}
 async checkpointRecord(db,i,s,input,review=false){
  fields(input,['draftId','expectedRevision','revision','envelope']);id(input.draftId);
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||(!Number.isSafeInteger(input.revision)||input.revision<=input.expectedRevision))fail('DRAFT_REVISION_CONFLICT',409);
  const identity={companyId:Number(i.company_id),siteId:Number(i.site_id),guardId:Number(i.guard_ref),sessionId:Number(i.guard_session_id),incidentId:Number(i.id),snapshotId:s.id,snapshotDigest:s.digest,draftId:input.draftId,revision:input.revision};
  const checkpoint=this.keys.open(s.scope_id,'draft-checkpoint',identity,input.envelope);
  fields(checkpoint,['protocolVersion','snapshotId','snapshotDigest','answers']);
  if(checkpoint.protocolVersion!==2||checkpoint.snapshotId!==s.id||checkpoint.snapshotDigest!==s.digest||!Array.isArray(checkpoint.answers)||checkpoint.answers.length>12)fail('SNAPSHOT_MISMATCH',409);
  const seen=new Set();for(const a of checkpoint.answers){fields(a,['questionId','value']);const q=s.questions.find(q=>q.id===id(a.questionId));if(!q||seen.has(q.id))fail('INVALID_QUESTION_ID');seen.add(q.id);text(a.value,q.maxLength);}
  const current=(await db.query(`SELECT * FROM ${Q}drafts WHERE snapshot_id=$1 AND scope_id=$2 FOR UPDATE`,[s.id,s.scope_id])).rows[0];
  if(current&&current.id!==input.draftId)fail('DRAFT_REVISION_CONFLICT',409);
  if(current?.state==='SUBMITTED')fail('DRAFT_ALREADY_SUBMITTED',409);
  if(current?.revision===input.revision){const old=this.keys.open(s.scope_id,'draft-checkpoint',identity,current.checkpoint_envelope);if(canonical(old)!==canonical(checkpoint))fail('DRAFT_REVISION_CONFLICT',409);return {...this.keys.open(s.scope_id,'draft-receipt',{draftId:current.id,revision:current.revision},current.receipt_envelope),verifiedEnvelopeDigest:envelopeFingerprint(input.envelope)};}
  if((current?.revision??0)!==input.expectedRevision)fail('DRAFT_REVISION_CONFLICT',409);
  const state=review?'REVIEW_REQUIRED':(['active','in_progress'].includes(i.status)?'CHECKPOINTED':'RETENTION_ONLY');
  const receipt={status:'ok',protocolVersion:2,incidentId:Number(i.id),snapshotId:s.id,draftId:input.draftId,revision:input.revision,state,payloadDigest:fingerprint(checkpoint),originalSessionId:Number(i.guard_session_id)};
  // Re-encrypt under the active server key after validation; imported old keys remain readable.
  const enc=this.keys.seal(s.scope_id,'draft-checkpoint',identity,checkpoint),rec=this.keys.seal(s.scope_id,'draft-receipt',{draftId:input.draftId,revision:input.revision},receipt);
  if(current)await db.query(`UPDATE ${Q}drafts SET revision=$2,state=$3,checkpoint_envelope=$4,receipt_envelope=$5,updated_at=now() WHERE id=$1`,[current.id,input.revision,state,enc,rec]);
  else await db.query(`INSERT INTO ${Q}drafts(id,scope_id,snapshot_id,guard_id,session_id,revision,state,checkpoint_envelope,receipt_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.draftId,s.scope_id,s.id,i.guard_ref,i.guard_session_id,input.revision,state,enc,rec]);
  return {...receipt,verifiedEnvelopeDigest:envelopeFingerprint(input.envelope)};
 }
 async readDraft(guard,incidentId){return this.tx(async db=>{
  const i=await this.incident(db,guard,incidentId),s=await this.snapshot(db,i);
  const row=(await db.query(`SELECT * FROM ${Q}drafts WHERE snapshot_id=$1 AND scope_id=$2 AND guard_id=$3 AND session_id=$4`,[s.id,s.scope_id,guard.guard_id,guard.session_id])).rows[0];if(!row)return {status:'ok',draft:null};
  const identity={companyId:Number(i.company_id),siteId:Number(i.site_id),guardId:Number(i.guard_ref),sessionId:Number(i.guard_session_id),incidentId:Number(i.id),snapshotId:s.id,snapshotDigest:s.digest,draftId:row.id,revision:row.revision};
  const receipt=this.keys.open(s.scope_id,'draft-receipt',{draftId:row.id,revision:row.revision},row.receipt_envelope);
  return {status:'ok',draft:row.state==='SUBMITTED'?null:this.keys.open(s.scope_id,'draft-checkpoint',identity,row.checkpoint_envelope),receipt};
 });}
 async recover(context,incidentId,input){return this.tx(async db=>{
  fields(input,['reason','draftId','packet'],['reason']);if(!['SESSION_EXPIRED_REVIEW','OPERATIONAL_EVIDENCE_REVIEW'].includes(input.reason))fail('INVALID_RECOVERY_REASON');await this.authorize(db,context,'recover');
  if(input.packet){
   const owned=(await db.query(`SELECT i.*,s.id AS snapshot_id,s.scope_id FROM incidents i JOIN ${Q}snapshots s ON s.incident_id=i.id JOIN sites st ON st.id=i.site_id WHERE i.id=$1 AND i.company_id=$2 AND st.company_id=$2`,[incidentId,context.companyId])).rows[0];
   if(!owned)fail('NOT_FOUND',404);
   const original=(await db.query(`SELECT * FROM ${Q}snapshots WHERE id=$1`,[owned.snapshot_id])).rows[0];
   const questions=(await db.query(`SELECT question_id AS id,max_length AS "maxLength" FROM ${Q}snapshot_questions WHERE snapshot_id=$1 ORDER BY position`,[original.id])).rows;
   await this.checkpointRecord(db,owned,{...original,questions},input.packet,true);
  }
  const r=await db.query(`SELECT d.*,s.incident_id,s.company_id,s.site_id,s.guard_id AS original_guard_id,s.session_id AS original_session_id,s.digest FROM ${Q}drafts d JOIN ${Q}snapshots s ON s.id=d.snapshot_id AND s.scope_id=d.scope_id WHERE s.incident_id=$1 AND s.company_id=$2 AND ($3::uuid IS NULL OR d.id=$3)`,[incidentId,context.companyId,input.draftId??null]);
  const row=r.rows[0];if(!row)fail('NOT_FOUND',404);
  await this.audit(db,row.scope_id,row.site_id,context.actorId,'REVIEW_UNSUBMITTED_EVIDENCE',row.id,input.reason);
  if(row.state==='SUBMITTED')return {status:'ok',state:'SUBMITTED',draft:null};
  const identity={companyId:Number(row.company_id),siteId:Number(row.site_id),guardId:Number(row.original_guard_id),sessionId:Number(row.original_session_id),incidentId:Number(row.incident_id),snapshotId:row.snapshot_id,snapshotDigest:row.digest,draftId:row.id,revision:row.revision};
  return {status:'ok',state:'UNSUBMITTED_EVIDENCE',originalGuardId:row.original_guard_id,originalSessionId:row.original_session_id,draft:this.keys.open(row.scope_id,'draft-checkpoint',identity,row.checkpoint_envelope)};
 });}
 async markReview({inactiveHours=null}={}){
  // Non-destructive only. No retention durations are activated by default.
  if(inactiveHours===null)return {enabled:false};if(!Number.isInteger(inactiveHours)||inactiveHours<1)fail('INVALID_RETENTION_POLICY');
  const r=await this.pool.query(`UPDATE ${Q}drafts SET review_flag=true WHERE state IN ('CHECKPOINTED','RETENTION_ONLY','REVIEW_REQUIRED') AND updated_at < now()-($1::int * interval '1 hour')`,[inactiveHours]);return {enabled:true,flagged:r.rowCount};
 }
 async cleanupCommitted(context,{approvedPolicy=false,redundantHours=null}={}){
  if(!approvedPolicy||!Number.isInteger(redundantHours)||redundantHours<1) return {enabled:false};
  return this.tx(async db=>{await this.authorize(db,context,'retention');const r=await db.query(`UPDATE ${Q}drafts d SET checkpoint_envelope=NULL WHERE d.scope_id IN (SELECT id FROM ${Q}scopes WHERE company_id=$1) AND d.state='SUBMITTED' AND NOT d.legal_hold AND d.updated_at<now()-($2::int*interval '1 hour') AND EXISTS (SELECT 1 FROM ${Q}submissions s WHERE s.snapshot_id=d.snapshot_id AND s.scope_id=d.scope_id)`,[context.companyId,redundantHours]);return {enabled:true,cleaned:r.rowCount};});
 }
}
require('./legacy-custody').registerLegacyMethods(QuestionnaireService);
module.exports={QuestionnaireService};
