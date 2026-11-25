'use strict';
const {fields,id,text,fail,fingerprint,canonical,envelopeFingerprint}=require('./contract');const {LEGACY_ASSOCIATION_SQL}=require('./legacy-association');
const aliases=['incident_type','location','actions_taken'];
function validateLegacy(value){
 fields(value,['protocolVersion','answers','questionIndex','draft','dueAt']);
 if(value.protocolVersion!==1||!Number.isInteger(value.questionIndex)||value.questionIndex<0||value.questionIndex>2||!Number.isFinite(value.dueAt))fail('INVALID_LEGACY_DRAFT');
 fields(value.answers,aliases,[]);for(const valueText of Object.values(value.answers))text(valueText,5000);text(value.draft,5000);return value;
}
function legacyIdentity(i,draftId,revision){return {companyId:Number(i.company_id),siteId:Number(i.site_id),guardId:Number(i.guard_ref),sessionId:Number(i.original_session_id),incidentId:Number(i.id),draftId,revision};}
async function ownership(service,db,guard,incidentId){
 const result=await db.query(LEGACY_ASSOCIATION_SQL,[incidentId,guard.guard_id,guard.site_id,guard.session_id,guard.company_id]);if(result.rowCount!==1)fail('LEGACY_SESSION_ASSOCIATION_UNPROVEN',409);
 const site=await service.site(db,guard.company_id,guard.site_id);
 return {...result.rows[0],scope_id:site.scope_id,company_id:guard.company_id,site_id:guard.site_id,guard_ref:guard.guard_id,original_session_id:guard.session_id};
}
async function putRecord(service,db,i,input,review=false){
 fields(input,['draftId','expectedRevision','revision','envelope']);id(input.draftId);
 if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!Number.isSafeInteger(input.revision)||input.revision<=input.expectedRevision)fail('DRAFT_REVISION_CONFLICT',409);
 const identity=legacyIdentity(i,input.draftId,input.revision);const value=validateLegacy(service.keys.open(i.scope_id,'legacy-draft-checkpoint',identity,input.envelope));
 const old=(await db.query('SELECT * FROM incident_questionnaire_legacy_drafts WHERE incident_id=$1 AND guard_id=$2 AND session_id=$3 FOR UPDATE',[i.id,i.guard_ref,i.original_session_id])).rows[0];
 if(old&&old.id!==input.draftId)fail('DRAFT_REVISION_CONFLICT',409);
 if(old?.revision===input.revision){const previous=service.keys.open(i.scope_id,'legacy-draft-checkpoint',identity,old.checkpoint_envelope);if(canonical(previous)!==canonical(value))fail('DRAFT_REVISION_CONFLICT',409);return {...service.keys.open(i.scope_id,'legacy-draft-receipt',{draftId:old.id,revision:old.revision},old.receipt_envelope),verifiedEnvelopeDigest:envelopeFingerprint(input.envelope)};}
 if((old?.revision??0)!==input.expectedRevision)fail('DRAFT_REVISION_CONFLICT',409);
 const state=review?'REVIEW_REQUIRED':['active','in_progress'].includes(i.status)?'CHECKPOINTED':'RETENTION_ONLY';
 const receipt={status:'ok',protocolVersion:1,legacyUnversioned:true,incidentId:Number(i.id),draftId:input.draftId,revision:input.revision,originalSessionId:Number(i.original_session_id),state,payloadDigest:fingerprint(value),associationStatus:review?'REVIEW_REQUIRED':'VERIFIED_SESSION'};
 const envelope=service.keys.seal(i.scope_id,'legacy-draft-checkpoint',identity,value);const rec=service.keys.seal(i.scope_id,'legacy-draft-receipt',{draftId:input.draftId,revision:input.revision},receipt);
 if(old)await db.query('UPDATE incident_questionnaire_legacy_drafts SET revision=$2,state=$3,checkpoint_envelope=$4,receipt_envelope=$5,updated_at=now() WHERE id=$1',[old.id,input.revision,state,envelope,rec]);
 else await db.query('INSERT INTO incident_questionnaire_legacy_drafts(id,scope_id,company_id,incident_id,site_id,guard_id,session_id,revision,state,association_status,checkpoint_envelope,receipt_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[input.draftId,i.scope_id,i.company_id,i.id,i.site_id,i.guard_ref,i.original_session_id,input.revision,state,receipt.associationStatus,envelope,rec]);return {...receipt,verifiedEnvelopeDigest:envelopeFingerprint(input.envelope)};
}
function registerLegacyMethods(QuestionnaireService){
 QuestionnaireService.prototype.checkpointLegacy=function(guard,incidentId,input){return this.tx(async db=>putRecord(this,db,await ownership(this,db,guard,incidentId),input));};
 QuestionnaireService.prototype.readLegacy=function(guard,incidentId){return this.tx(async db=>{
  const i=await ownership(this,db,guard,incidentId);const row=(await db.query('SELECT * FROM incident_questionnaire_legacy_drafts WHERE incident_id=$1 AND guard_id=$2 AND session_id=$3',[incidentId,guard.guard_id,guard.session_id])).rows[0];if(!row)return {status:'ok',draft:null};
  return {status:'ok',draft:this.keys.open(i.scope_id,'legacy-draft-checkpoint',legacyIdentity(i,row.id,row.revision),row.checkpoint_envelope),receipt:this.keys.open(i.scope_id,'legacy-draft-receipt',{draftId:row.id,revision:row.revision},row.receipt_envelope)};
 });};
 QuestionnaireService.prototype.recoverLegacy=function(context,incidentId,input){return this.tx(async db=>{
  fields(input,['reason','originalSessionId','packet'],['reason','originalSessionId']);if(!['SESSION_EXPIRED_REVIEW','OPERATIONAL_EVIDENCE_REVIEW'].includes(input.reason))fail('INVALID_RECOVERY_REASON');await this.authorize(db,context,'recover');
  const row=(await db.query('SELECT i.id,i.status,i.company_id,i.site_id,i.guard_ref,gs.id AS original_session_id,sc.id AS scope_id FROM incidents i JOIN sites s ON s.id=i.site_id JOIN guard_sessions gs ON gs.id=$3 AND gs.guard_id=i.guard_ref AND gs.site_id=i.site_id JOIN incident_questionnaire_scopes sc ON sc.company_id=s.company_id WHERE i.id=$1 AND i.company_id=$2 AND s.company_id=$2 AND i.questionnaire_binding IS NULL',[incidentId,context.companyId,input.originalSessionId])).rows[0];if(!row)fail('NOT_FOUND',404);
  if(input.packet)await putRecord(this,db,row,input.packet,true);
  const draft=(await db.query('SELECT * FROM incident_questionnaire_legacy_drafts WHERE incident_id=$1 AND guard_id=$2 AND session_id=$3',[row.id,row.guard_ref,row.original_session_id])).rows[0];if(!draft)fail('NOT_FOUND',404);
  await this.audit(db,row.scope_id,row.site_id,context.actorId,'REVIEW_LEGACY_UNSUBMITTED_EVIDENCE',draft.id,input.reason);
  return {status:'ok',state:'UNSUBMITTED_EVIDENCE',legacyUnversioned:true,associationStatus:draft.association_status,originalGuardId:row.guard_ref,originalSessionId:row.original_session_id,draft:this.keys.open(row.scope_id,'legacy-draft-checkpoint',legacyIdentity(row,draft.id,draft.revision),draft.checkpoint_envelope)};
 });};
}
module.exports={registerLegacyMethods};
