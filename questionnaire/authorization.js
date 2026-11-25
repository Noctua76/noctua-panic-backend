'use strict';
const {createDashboardRbac}=require('../auth/dashboard-rbac');const {fail}=require('./contract');
const REQUIRED={report:['incidents.view'],export:['exports.view'],read:['sites.view','questionnaires.view'],save:['sites.manage','questionnaires.draft'],publish:['sites.manage','questionnaires.publish'],restore:['sites.manage','questionnaires.restore'],history:['sites.view','questionnaires.view'],audit:['sites.view','questionnaires.view','audit_logs.view'],recover:['incidents.manage','questionnaires.recover'],retention:['incidents.manage','questionnaires.recover'],platform:['platform_questionnaires.manage']};
async function authorizeDashboard(db,context,operation){
 const auth=context.auth;if(!auth?.session_id||!auth?.user_id||!REQUIRED[operation])fail('PERMISSION_DENIED',403);
 // Linearization: an active session row is held until this bounded operation ends.
 const session=(await db.query('SELECT id FROM admin_sessions WHERE id=$1 AND user_id=$2 AND is_active=true FOR SHARE',[auth.session_id,auth.user_id])).rows[0];if(!session)fail('AUTH_SESSION_INVALID',401);
 // Module grants require a real active role. A removed mapping must never
 // resurrect a stale system_owner claim through the legacy resolver fallback.
 const roles=await db.query('SELECT r.id FROM user_dashboard_roles ur JOIN dashboard_roles r ON r.id=ur.role_id AND r.is_active=true WHERE ur.user_id=$1 FOR SHARE OF ur,r',[auth.user_id]);
 if(!roles.rowCount)fail('PERMISSION_DENIED',403);
 // Freeze existing grants through the bounded transaction. Revocation either
 // commits first and is observed, or waits until this authorized operation ends.
 await db.query('SELECT rp.role_id FROM dashboard_role_permissions rp JOIN dashboard_permissions p ON p.id=rp.permission_id WHERE rp.role_id=ANY($1::int[]) FOR SHARE OF rp,p',[roles.rows.map(r=>r.id)]);
 const fresh=await createDashboardRbac({pool:db}).resolveAuthorization(auth);
 const permission=code=>fresh.is_system_owner||fresh.permissions.includes('*')||fresh.permissions.includes(code);
 if(!REQUIRED[operation].every(permission))fail('PERMISSION_DENIED',403);
 // Evidence review is explicitly designated; generic wildcard/owner status cannot grant it.
 if(['recover','retention'].includes(operation)&&!fresh.permissions.includes('questionnaires.recover'))fail('EXPLICIT_RECOVERY_PERMISSION_REQUIRED',403);
 if(operation==='platform'){
  if(!fresh.is_system_owner||auth.tenant_context_active||Number(auth.actor_company_id??auth.company_id)!==Number(auth.effective_company_id??auth.company_id))fail('HOME_PLATFORM_CONTEXT_REQUIRED',403);
 }else if(!context.companyId||Number(context.companyId)!==Number(auth.effective_company_id))fail('TENANT_CONTEXT_REQUIRED',403);
 if(operation!=='read'&&operation!=='history'&&operation!=='audit'&&operation!=='report'&&operation!=='export'&&(auth.access_mode==='read_only'||(auth.tenant_context_active&&!auth.tenant_context_can_mutate)))fail('READ_ONLY_ACCESS',403);
}
module.exports={authorizeDashboard,REQUIRED};
