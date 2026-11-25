'use strict';
const PLATFORM_SCOPE='00000000-0000-4000-8000-000000000001';
const PLATFORM_DEFINITION='00000000-0000-4000-8000-000000000002';
const DEFAULT_QUESTIONS=[
 ['00000000-0000-4000-8000-000000000011','incident_type','Τι είδους περιστατικό ήταν; (π.χ. παραβίαση χώρου, ύποπτο άτομο, ψευδής συναγερμός, τεχνικό ζήτημα, test)'],
 ['00000000-0000-4000-8000-000000000012','location','Πού ακριβώς εντοπίστηκε; (π.χ. είσοδος, ζώνη Β2, προαύλιος χώρος)'],
 ['00000000-0000-4000-8000-000000000013','actions_taken','Ολοκλήρωσες τις απαιτούμενες ενέργειες; Τι έκανες;']
];
function platformDefault(){return {title:'Incident Questionnaire',questions:DEFAULT_QUESTIONS.map(([id,,prompt])=>({id,prompt,help:'',type:'LONG_TEXT',required:true,maxLength:5000}))};}
module.exports={PLATFORM_SCOPE,PLATFORM_DEFINITION,DEFAULT_QUESTIONS,platformDefault};
