'use strict';
const crypto = require('node:crypto');
const LIMITS = Object.freeze({ questions:12, title:120, prompt:500, help:240, SHORT_TEXT:500, LONG_TEXT:5000, plainBytes:65536, envelopeBytes:98304 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class QuestionnaireError extends Error {
 constructor(code, status=422) { super(code);this.name='QuestionnaireError';this.code=code;this.status=status; }
}
function fail(code,status){throw new QuestionnaireError(code,status);}
function fields(value, allowed, required=allowed){
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) fail('INVALID_FIELDS');
 return value;
}
function id(value){if(typeof value!=='string'||!UUID.test(value))fail('INVALID_ID');return value.toLowerCase();}
function text(value,max,required=false){
 if(typeof value!=='string'||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)||[...value].length>max||(required&&!value.trim()))fail('INVALID_TEXT');
 return value;
}
function canonical(value){
 if(value===null||typeof value!=='object') return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
function bounded(value,max=LIMITS.plainBytes){const json=canonical(value);if(Buffer.byteLength(json)>max)fail('PAYLOAD_TOO_LARGE',413);return json;}
function validateDefinition(input){
 fields(input,['title','questions']);text(input.title,LIMITS.title,true);
 if(!Array.isArray(input.questions)||input.questions.length<1||input.questions.length>LIMITS.questions)fail('INVALID_QUESTION_COUNT');
 const seen=new Set();const questions=input.questions.map((q,index)=>{
  fields(q,['id','prompt','help','type','required','maxLength'],['id','prompt','type','required','maxLength']);
  const questionId=id(q.id);if(seen.has(questionId))fail('DUPLICATE_QUESTION');seen.add(questionId);
  if(!['SHORT_TEXT','LONG_TEXT'].includes(q.type))fail('UNSUPPORTED_QUESTION_TYPE');
  if(typeof q.required!=='boolean'||!Number.isInteger(q.maxLength)||q.maxLength<1||q.maxLength>LIMITS[q.type])fail('INVALID_QUESTION_LIMIT');
  return {id:questionId,prompt:text(q.prompt,LIMITS.prompt,true),help:text(q.help??'',LIMITS.help),type:q.type,required:q.required,maxLength:q.maxLength,position:index+1};
 });
 const result={schemaVersion:1,title:input.title,questions};bounded(result);return result;
}
function validateAnswers(snapshot,input){
 fields(input,['protocolVersion','snapshotId','snapshotDigest','clientSubmissionId','answers','omittedOptionalQuestionIds']);
 if(input.protocolVersion!==2||id(input.snapshotId)!==snapshot.id||input.snapshotDigest!==snapshot.digest)fail('SNAPSHOT_MISMATCH',409);
 id(input.clientSubmissionId);
 if(!Array.isArray(input.answers)||!Array.isArray(input.omittedOptionalQuestionIds)||input.answers.length>LIMITS.questions||input.omittedOptionalQuestionIds.length>LIMITS.questions)fail('INVALID_ANSWERS');
 const values=new Map(); const omitted=new Set(); const allowed=new Map(snapshot.questions.map(q=>[q.id,q]));
 for(const a of input.answers){fields(a,['questionId','value']);const key=id(a.questionId);if(!allowed.has(key)||values.has(key))fail('INVALID_QUESTION_ID');values.set(key,text(a.value,allowed.get(key).maxLength));}
 for(const x of input.omittedOptionalQuestionIds){const key=id(x);if(!allowed.has(key)||omitted.has(key)||values.has(key)||allowed.get(key).required)fail('INVALID_OMISSION');omitted.add(key);}
 const answers=[]; const omissions=[];
 for(const q of snapshot.questions){
  const v=values.get(q.id);if(v===undefined||!v.trim()){
   if(q.required)fail('REQUIRED_ANSWER_MISSING');
   omissions.push(q.id);
  }else answers.push({questionId:q.id,value:v});
 }
 const result={protocolVersion:2,snapshotId:snapshot.id,snapshotDigest:snapshot.digest,answers,omittedOptionalQuestionIds:omissions};bounded(result);return result;
}
function fingerprint(value){return crypto.createHash('sha256').update(bounded(value)).digest('hex');}
function envelopeFingerprint(value){bounded(value,LIMITS.envelopeBytes);return crypto.createHash('sha256').update(canonical(value)).digest('hex');}
module.exports={envelopeFingerprint,LIMITS,QuestionnaireError,fail,fields,id,text,canonical,bounded,validateDefinition,validateAnswers,fingerprint};
