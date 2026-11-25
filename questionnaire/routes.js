'use strict';
const {fields,fail,id}=require('./contract');const {PLATFORM_SCOPE,PLATFORM_DEFINITION}=require('./defaults');
function registerQuestionnaireRoutes({app,requireAuth,requireGuardAuth,runtime}){
 const headers=res=>{res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Vary','Authorization');res.setHeader('X-Content-Type-Options','nosniff');};
 const context=req=>({auth:req.auth,companyId:Number(req.auth?.effective_company_id),actorId:Number(req.auth?.user_id)});
 const wrap=handler=>async(req,res)=>{headers(res);let service;try{if(!runtime.enabled)fail('QUESTIONNAIRE_ENGINE_UNAVAILABLE',503);service=runtime.service();return res.json(await handler(service,req));}catch(e){const expected=e.name==='QuestionnaireError';if(expected&&[403,409].includes(e.status)&&req.auth){try{await service?.recordRejected(context(req),e.code,req.params?.siteId);}catch{console.error('QUESTIONNAIRE_SECURITY_AUDIT_UNAVAILABLE');}}return res.status(expected?e.status:503).json({status:'error',code:expected?e.code:'QUESTIONNAIRE_RECOVERABLE_FAILURE',recoverable:!expected||e.status===503,responsesSaved:false});}};
 const base='/settings/sites/:siteId/incident-questionnaire';
 app.get(base,requireAuth,wrap((s,r)=>s.manage(context(r),Number(r.params.siteId),'read')));
 app.get(base+'/draft',requireAuth,wrap((s,r)=>s.manage(context(r),Number(r.params.siteId),'read')));
 app.put(base+'/draft',requireAuth,wrap((s,r)=>s.manage(context(r),Number(r.params.siteId),'save',r.body)));
 app.post(base+'/publish',requireAuth,wrap((s,r)=>s.manage(context(r),Number(r.params.siteId),'publish',r.body)));
 app.post(base+'/restore-default',requireAuth,wrap((s,r)=>s.manage(context(r),Number(r.params.siteId),'restore',r.body)));
 app.get(base+'/versions/:versionId',requireAuth,wrap((s,r)=>s.tx(async db=>{
  await s.authorize(db,context(r),'history');const site=await s.site(db,context(r).companyId,r.params.siteId);
  const owned=(await db.query('SELECT 1 FROM site_incident_questionnaire_assignments WHERE site_id=$1 AND scope_id=$2 AND version_id=$3',[site.id,site.scope_id,id(r.params.versionId)])).rowCount;if(!owned)fail('NOT_FOUND',404);
  const v=await s.version(db,r.params.versionId);return {status:'ok',version:{id:v.id,number:v.version_number,title:v.title,questions:v.questions}};
 })));
 app.get(base+'/audit',requireAuth,wrap((s,r)=>s.tx(async db=>{
  await s.authorize(db,context(r),'audit');const site=await s.site(db,context(r).companyId,r.params.siteId);
  const rows=await db.query('SELECT id,action,reference_id,actor_id,created_at,outcome FROM incident_questionnaire_audit_events WHERE scope_id=$1 AND site_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50',[site.scope_id,site.id]);return {status:'ok',events:rows.rows};
 })));
 app.get('/settings/incident-questionnaire-default',requireAuth,wrap((s,r)=>s.tx(async db=>{
  await s.authorize(db,context(r),'read');const head=await s.platformLock(db);const v=await s.version(db,head.active_default_version_id);return {status:'ok',version:{id:v.id,title:v.title,questions:v.questions}};
 })));
 app.get('/admin/incident-questionnaire-defaults',requireAuth,wrap((s,r)=>s.tx(async db=>{await s.authorize(db,context(r),'platform');const head=await s.platformLock(db);const v=await s.version(db,head.active_default_version_id);return {status:'ok',version:{id:v.id,title:v.title,questions:v.questions}};})));
 app.post('/admin/incident-questionnaire-defaults',requireAuth,wrap((s,r)=>{fields(r.body,['content']);return s.activateDefault(context(r),r.body.content);}));
 app.post('/settings/incidents/:incidentId/questionnaire-recovery',requireAuth,wrap((s,r)=>s.recover(context(r),r.params.incidentId,r.body)));
 const guardWrite=(req)=>{if(req.guard?.access_mode==='read_only')fail('READ_ONLY_ACCESS',403);};
 app.get('/guard/questionnaire-capabilities',requireGuardAuth,async(req,res)=>{headers(res);return res.json({status:'ok',protocolVersion:runtime.enabled?2:1,secureDrafts:runtime.enabled,dynamicQuestionnaires:runtime.enabled,offlineRestartRequiresOnlineRecovery:true});});
 app.get('/guard/questionnaire-pending',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.listPending(r.guard);}));
 app.get('/guard/questionnaire-storage-key',requireGuardAuth,wrap((s,r)=>s.tx(async db=>{guardWrite(r);const site=await s.site(db,r.guard.company_id,r.guard.site_id);return {status:'ok',...s.keys.public(site.scope_id),identity:{companyId:Number(r.guard.company_id),siteId:Number(r.guard.site_id),guardId:Number(r.guard.guard_id),sessionId:Number(r.guard.session_id)}};})));
 const guardBase='/guard/incidents/:incidentId';
 app.get(guardBase+'/legacy-questionnaire-draft',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.readLegacy(r.guard,r.params.incidentId);}));
 app.put(guardBase+'/legacy-questionnaire-draft',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.checkpointLegacy(r.guard,r.params.incidentId,r.body);}));
 app.post('/settings/incidents/:incidentId/legacy-questionnaire-recovery',requireAuth,wrap((s,r)=>s.recoverLegacy(context(r),r.params.incidentId,r.body)));
 app.get(guardBase+'/questionnaire',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.getQuestionnaire(r.guard,r.params.incidentId);}));
 app.get(guardBase+'/questionnaire-draft',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.readDraft(r.guard,r.params.incidentId);}));
 app.put(guardBase+'/questionnaire-draft',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.checkpoint(r.guard,r.params.incidentId,r.body);}));
 app.post(guardBase+'/questionnaire-receipt-recovery',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.recoverReceipt(r.guard,r.params.incidentId,r.body);}));
 app.post(guardBase+'/questionnaire-submission',requireGuardAuth,wrap((s,r)=>{guardWrite(r);return s.submit(r.guard,r.params.incidentId,r.body);}));
 app.use((error,req,res,next)=>{if(/questionnaire/.test(req.path)){headers(res);return res.status(error.type==='entity.too.large'?413:400).json({status:'error',code:error.type==='entity.too.large'?'PAYLOAD_TOO_LARGE':'INVALID_QUESTIONNAIRE_REQUEST'});}next(error);});
 // Unknown module resources never reach generic GET permission defaults.
 app.use((req,res,next)=>{if(/(?:incident-questionnaire|questionnaire-recovery|^\/guard\/.*questionnaire)/.test(req.path)){headers(res);return res.status(404).json({status:'error',code:'QUESTIONNAIRE_ROUTE_NOT_FOUND'});}next();});
}
module.exports={registerQuestionnaireRoutes};
