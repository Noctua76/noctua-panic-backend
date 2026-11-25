'use strict';
function classifyQuestionnaireRoute(method,path){
 if(!/questionnaire/.test(path))return undefined;
 if(/^\/settings\/sites\/\d+\/incident-questionnaire(?:\/draft)?$/.test(path))return method==='GET'?'questionnaires.view':method==='PUT'&&path.endsWith('/draft')?'questionnaires.draft':'__unclassified_questionnaire__';
 if(/^\/settings\/sites\/\d+\/incident-questionnaire\/(versions\/[0-9a-f-]+|audit)$/.test(path)&&method==='GET')return 'questionnaires.view';
 if(/^\/settings\/sites\/\d+\/incident-questionnaire\/publish$/.test(path)&&method==='POST')return 'questionnaires.publish';
 if(/^\/settings\/sites\/\d+\/incident-questionnaire\/restore-default$/.test(path)&&method==='POST')return 'questionnaires.restore';
 if(path==='/settings/incident-questionnaire-default'&&method==='GET')return 'questionnaires.view';
 if(/^\/settings\/incidents\/\d+\/(?:legacy-)?questionnaire-recovery$/.test(path)&&method==='POST')return 'questionnaires.recover';
 if(path==='/admin/incident-questionnaire-defaults'&&['GET','POST'].includes(method))return 'platform_questionnaires.manage';
 return '__unclassified_questionnaire__';
}
module.exports={classifyQuestionnaireRoute};
