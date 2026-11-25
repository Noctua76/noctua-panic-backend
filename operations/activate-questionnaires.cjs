'use strict';
// Explicit one-off release bootstrap. Never imported by server startup.
const {Pool}=require('pg');const {runtimeDatabaseOptions}=require('../security/database-tls');const {Keyring}=require('../questionnaire/crypto');const {QuestionnaireService}=require('../questionnaire/service');
(async()=>{let pool;try{
 if(process.env.AEGIS_QUESTIONNAIRE_RELEASE_CONFIRM!=='OWNER_RELEASE_20261125')throw new Error('CONFIRMATION_REQUIRED');
 const keys=Keyring.fromEnvironment(process.env);pool=new Pool({...runtimeDatabaseOptions(process.env),max:1,connectionTimeoutMillis:5000});
 const result=await new QuestionnaireService({pool,keys}).initializeRelease({actorId:0,expectedKeyId:keys.active});
 process.stdout.write('AEGIS_QUESTIONNAIRE_ACTIVATION_BEGIN\n'+JSON.stringify(result)+'\nAEGIS_QUESTIONNAIRE_ACTIVATION_END\n');
}catch{process.stdout.write('AEGIS_QUESTIONNAIRE_ACTIVATION_FAILED\n');process.exitCode=2;}finally{if(pool)await pool.end();}})();
