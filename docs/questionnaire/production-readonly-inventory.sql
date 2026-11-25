-- Q02 protected evidence only. No incident/answer/session-token rows or credentials.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object('server_version',version(),'timezone',current_setting('TimeZone'),'database',current_database(),'current_role',current_user,'session_role',session_user) AS environment;
SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('companies','sites','guards','guard_sessions','incidents','incident_guard_responses','incident_resolution_actions','schema_migrations','dashboard_roles','dashboard_permissions','dashboard_role_permissions','user_dashboard_roles') ORDER BY table_name,ordinal_position;
SELECT c.relname,con.conname,con.contype,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname;
SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname;
SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname;
SELECT extname,extversion FROM pg_extension;
SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname;
SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles ORDER BY rolname;
SELECT pg_get_userbyid(member) AS member,pg_get_userbyid(roleid) AS role,admin_option FROM pg_auth_members;
SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY grantee,table_name,privilege_type;
SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public';
SELECT ssl,version,cipher,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid();
SELECT to_regclass('public.schema_migrations') AS migration_table;
-- If schema_migrations exists, export its migration names/checksums separately, not arbitrary operational rows.
ROLLBACK;
