'use strict';
const SAFE_ACCESS_LOG_FORMAT=':method :status :response-time ms';
function sensitiveResponseCache(req,res,next){
 const headers=req.headers||{};
 if(headers.authorization||headers['x-guard-session-token']||/^\/(?:guard|incidents|incident-log|settings|admin|auth|sites|guards|patrols|shift-reports)(?:\/|$)/.test(req.path||'')){
  res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.vary('Authorization');
 }
 next();
}
function createSafeRequestError(logger=(...args)=>console.error(...args)){
 return (error,req,res,_next)=>{
  const tooLarge=error.type==='entity.too.large'||error.code==='LIMIT_FILE_SIZE';
  const invalidJson=error.type==='entity.parse.failed';
  const status=tooLarge?413:invalidJson?400:(Number.isInteger(error.status)&&error.status>=400&&error.status<500?error.status:500);
  const code=tooLarge?'PAYLOAD_TOO_LARGE':invalidJson?'INVALID_JSON_REQUEST':status>=500?'REQUEST_FAILED':'REQUEST_REJECTED';
  logger('HTTP_REQUEST_REJECTED',{code,status});
  if(res.headersSent){res.destroy();return;}
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  return res.status(status).json({status:'error',code,message:'The request could not be completed.'});
 };
}
const safeRequestError=createSafeRequestError();
module.exports={sensitiveResponseCache,SAFE_ACCESS_LOG_FORMAT,createSafeRequestError,safeRequestError};
