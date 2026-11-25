'use strict';
const {Pool}=require('pg');const {runtimeDatabaseOptions}=require('../security/database-tls');const {QuestionnaireService}=require('./service');const {Keyring}=require('./crypto');const {authorizeDashboard}=require('./authorization');
function createQuestionnaireRuntime({enabled=process.env.QUESTIONNAIRE_ENGINE_ENABLED==='true',poolFactory,keysFactory,log=()=>console.error('QUESTIONNAIRE_WORKER_RECOVERABLE_FAILURE')}={}){
 let service=null,timer=null,working=false;const pending=new Set();let stopped=false;
 const runtime={enabled,
  captureColumns:enabled?', questionnaire_binding, guard_session_id, questionnaire_bound_at':'',
  captureValues:enabled?', s.incident_questionnaire_route, $12::int, NOW()':'',
  service(){if(!service){const pool=poolFactory?poolFactory():new Pool({...runtimeDatabaseOptions(process.env),max:3,connectionTimeoutMillis:1500,query_timeout:5000});try{service=new QuestionnaireService({pool,keys:keysFactory?keysFactory():Keyring.fromEnvironment(process.env),authorize:authorizeDashboard});}catch{void pool.end();const {fail}=require('./contract');fail('QUESTIONNAIRE_KEY_CUSTODY_UNAVAILABLE',503);}}return service;},
  enqueue(incidentId){if(!enabled||stopped)return;if(pending.size<1000)pending.add(String(incidentId));queueMicrotask(()=>void pump());},
  start(){if(!enabled||timer)return;stopped=false;timer=setInterval(()=>void scan(),15000);timer.unref?.();},
  async stop(){stopped=true;if(timer)clearInterval(timer);timer=null;if(service)await service.pool.end();},
 };
 async function pump(){if(working||stopped)return;working=true;try{while(pending.size&&!stopped){const incidentId=pending.values().next().value;pending.delete(incidentId);try{await runtime.service().initializeBoundIncident(incidentId);}catch{log();}}}finally{working=false;}}
 async function scan(){if(stopped||working)return;try{const s=runtime.service();const rows=await s.pool.query(`SELECT i.id FROM incidents i LEFT JOIN incident_questionnaire_snapshots q ON q.incident_id=i.id WHERE i.questionnaire_binding IS NOT NULL AND q.id IS NULL ORDER BY i.id LIMIT 25`);for(const row of rows.rows)runtime.enqueue(row.id);}catch{log();}}
 return runtime;
}
module.exports={createQuestionnaireRuntime};
