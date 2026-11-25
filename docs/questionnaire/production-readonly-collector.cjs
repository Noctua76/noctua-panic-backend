'use strict';
// Standalone read-only collector. Never require db.js, server.js or migration code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const LEGACY_DB_SHA256 = '72bf0bad390189020091dabe49e95542ca6664eaa5c7890c8189eb035e19fd9c';
const REQUIRED_TABLES = ['companies','sites','guards','guard_sessions','incidents','incident_guard_responses','schema_migrations','dashboard_roles','dashboard_permissions','dashboard_role_permissions','user_dashboard_roles','admin_sessions'];
const SAFE_MIGRATION_COLUMNS = ['name','filename','migration_name','version','checksum','applied_at'];
const SAFE_ERRORS = new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','ERR_OSSL_PEM_NO_START_LINE']);
function code(error) { return SAFE_ERRORS.has(error?.code) || /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : 'COLLECTION_FAILED'; }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fault(value) { const error = new Error(value); error.safeCode = value; return error; }
const PUBLIC_UNTRUSTED_CA = "-----BEGIN CERTIFICATE-----\nMIIDMzCCAhugAwIBAgIUH794cxxodW9GgvqAjn4BfQdrsaEwDQYJKoZIhvcNAQEL\nBQAwKTEnMCUGA1UEAwweQUVHSVMtU1lOVEhFVElDLVVOVFJVU1RFRC1ST09UMB4X\nDTI2MTEyNTE0MjYxOFoXDTM2MTEyMjE0MjYxOFowKTEnMCUGA1UEAwweQUVHSVMt\nU1lOVEhFVElDLVVOVFJVU1RFRC1ST09UMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\nMIIBCgKCAQEApubdE1UCZi7C6/VLHKE+Nr+fgrmxQuEdAQA78lZwgRUrciA/boeu\n/yC/2fpuKL5rJzTE7lhBUlHY4CXQCV+1x+MflVHUaj79YSTGl+5c4tBKdLpX92At\nqhaceqPht8YXeNBe0MnzFtx6rK35/xcmX8EoFfYAEO240dnGd56DIgPhG2qT1hwb\nwMHSspCTl6u4xVnqCwjRQx7XkdM4XKalNW1FgbONeVXljFLwLIbIS11aWkQXgsZS\nc5XNE+qWc2T2gncJ2psZkBE6IhdyqiFzjtk1m0kpMlDfoueEvYH8ULuXx61CyU2e\noA/HnfjPJ6UNONRhI2CaI8ewJutNP8MfZQIDAQABo1MwUTAdBgNVHQ4EFgQU+Zmf\nMZ0MezmqpggTCtQMsDfWTg8wHwYDVR0jBBgwFoAU+ZmfMZ0MezmqpggTCtQMsDfW\nTg8wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAPRrjha2OwRfI\ntISdOcmqglyxA3pu8/cGXFT7XfOVnblAHv21LG0UojlnU+Yu3UqEtsVrF+/gqNgk\nZc45H1vDvu9rglXDXEYWQHSyYc4Ka8x3Sj3XfNWiO7OtD5UgsQFABOCE0bJe4jcq\n0PNcLAamP8u15ZDYD0AfcyG7s8bn12WEUMDUifRIHs2SAkvz1mSUeF7SHGNii8DL\nLrjsH8sVGKvLgIgbkmVA4DSCiBKMB8n4nkGlBbXFQwpp61pRA15IewXBQEi22Gbv\nSnauRAJ+pg5G+uTQqv0oVw7yvKv66pyodJBKlS03rKNkaNTHQqWL7CkfuD9TgLp7\ncwD+jptl+w==\n-----END CERTIFICATE-----\n";
const QUERIES = {
  environment: "SELECT version() AS server_version,current_database() AS database,current_user AS runtime_role,session_user AS session_role,current_setting('TimeZone') AS timezone,current_setting('transaction_read_only') AS transaction_read_only,current_setting('row_security') AS row_security",
  tables: "SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,c.reltuples::bigint AS approximate_rows,pg_has_role(current_user,c.relowner,'USAGE') AS owner_privileges,has_table_privilege(current_user,c.oid,'SELECT') AS can_select,has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate,has_table_privilege(current_user,c.oid,'REFERENCES') AS can_reference,has_table_privilege(current_user,c.oid,'TRIGGER') AS can_trigger FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname",
  columns: "SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
  constraints: "SELECT c.relname,con.conname,con.contype,con.convalidated,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname",
  indexes: "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
  triggers: "SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
  extensions: 'SELECT extname,extversion FROM pg_extension ORDER BY extname',
  roles: "SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,pg_has_role(current_user,oid,'MEMBER') AS runtime_is_member,pg_has_role(current_user,oid,'USAGE') AS runtime_has_effective_privileges FROM pg_roles ORDER BY rolname",
  memberships: 'SELECT pg_get_userbyid(member) AS member,pg_get_userbyid(roleid) AS role,admin_option FROM pg_auth_members ORDER BY 1,2',
  grants: "SELECT grantee,table_name,privilege_type,is_grantable FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY grantee,table_name,privilege_type",
  database_privileges: "SELECT pg_get_userbyid(datdba) AS database_owner,has_database_privilege(current_user,oid,'CREATE') AS can_create,has_database_privilege(current_user,oid,'CONNECT') AS can_connect,has_database_privilege(current_user,oid,'TEMP') AS can_temp FROM pg_database WHERE datname=current_database()",
  schema_privileges: "SELECT nspname,pg_get_userbyid(nspowner) AS owner,has_schema_privilege(current_user,oid,'CREATE') AS can_create,has_schema_privilege(current_user,oid,'USAGE') AS can_use FROM pg_namespace WHERE nspname='public'",
  sequences: "SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,has_sequence_privilege(current_user,c.oid,'USAGE') AS can_use,has_sequence_privilege(current_user,c.oid,'SELECT') AS can_select,has_sequence_privilege(current_user,c.oid,'UPDATE') AS can_update FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname",
  routines: "SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS security_definer,has_function_privilege(current_user,p.oid,'EXECUTE') AS can_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,p.oid",
  default_acl: "SELECT pg_get_userbyid(defaclrole) AS owner,n.nspname AS schema,a.defaclobjtype,a.defaclacl::text AS acl FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname='public' OR a.defaclnamespace=0",
  rls: "SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname",
  tls_transport: 'SELECT ssl,version,cipher,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
  migration_columns: "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' ORDER BY ordinal_position"
};
function strictOptions(connectionString, expectedIdentity, ca, telemetry) {
  const uri = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(uri.protocol)) throw fault('INVALID_DATABASE_CONFIGURATION');
  for (const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert','uselibpqcompat']) uri.searchParams.delete(key);
  return {
    connectionString: uri.toString(), connectionTimeoutMillis: 6500, query_timeout: 8500,
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}),
      checkServerIdentity: (_name, cert) => {
        telemetry.driverIdentityChecks++;
        const result = tls.checkServerIdentity(expectedIdentity, cert);
        if (result) telemetry.driverIdentityRejected = true;
        return result;
      }
    }
  };
}
function attestSocket(client, expectedIdentity) {
  const socket = client.connection?.stream;
  const certificate = socket?.getPeerCertificate?.() || {};
  const hasCertificate = Boolean(certificate.raw?.length);
  const identityError = hasCertificate ? tls.checkServerIdentity(expectedIdentity, certificate) : fault('PEER_CERTIFICATE_MISSING');
  return { encrypted: socket?.encrypted === true, chainVerified: socket?.authorized === true,
    peerCertificatePresent: hasCertificate, hostnameVerified: hasCertificate && !identityError,
    certificateSha256: hasCertificate ? sha(certificate.raw) : null,
    verified: socket?.encrypted === true && socket?.authorized === true && hasCertificate && !identityError };
}
async function collect({ env = process.env, cwd = process.cwd(), Client, observeQuery = () => {} } = {}) {
  const output = { collectorVersion: 2, collectedAt: new Date().toISOString(), mode: 'PRODUCTION_READ_ONLY_METADATA',
    runtimeConfiguration: {}, results: {}, errors: {}, completeness: {}, execution: {readOnlyTransactionsVerified: 0, writeStatements: 0, queryCount: 0},
    productionMutations: false, backupRecoverability: 'NOT_ESTABLISHED_BY_CATALOG' };
  const clients = new Set();
  async function createClient(options) {
    const client = new Client(options); clients.add(client); client.on('error', () => {});
    try { await client.connect(); return client; } catch (error) { await client.end().catch(() => {}); clients.delete(client); throw error; }
  }
  async function close(client) { await client.end().catch(() => {}); clients.delete(client); }
  async function query(client, section, sql, params = []) {
    // SQL is constructed only from the fixed metadata inventory and column allowlist.
    if (!/^(SELECT |BEGIN READ ONLY$|SET LOCAL |SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK)/.test(sql) || sql.includes(';')) throw fault('READ_ONLY_STATEMENT_REJECTED');
    observeQuery({section, sql, params}); output.execution.queryCount++;
    return client.query(sql, params);
  }
  async function begin(client) {
    await query(client, 'begin', 'BEGIN READ ONLY');
    await query(client, 'timeout', "SET LOCAL statement_timeout='8s'");
    await query(client, 'timeout', "SET LOCAL lock_timeout='1s'");
    await query(client, 'timeout', "SET LOCAL idle_in_transaction_session_timeout='10s'");
    const check = await query(client, 'read_only', "SELECT current_setting('transaction_read_only') AS value");
    if (check.rows[0]?.value !== 'on') throw fault('READ_ONLY_NOT_ENFORCED');
    output.execution.readOnlyTransactionsVerified++;
  }
  async function probe(name, identity, ca) {
    const telemetry = {driverIdentityChecks: 0, driverIdentityRejected: false}; let client;
    try {
      client = await createClient(strictOptions(env.DATABASE_URL, identity, ca, telemetry));
      const attestation = attestSocket(client, identity);
      if (!attestation.verified) throw fault('TLS_ATTESTATION_FAILED');
      await begin(client); await query(client, name, 'SELECT 1 AS read_only_probe'); await query(client, name, 'ROLLBACK');
      return {outcome: 'CONNECTED', ...attestation, ...telemetry};
    } catch (error) { return {outcome: 'REJECTED', verified: false, chainVerified: false, hostnameVerified: false, code: error.safeCode || code(error), ...telemetry}; }
    finally { if (client) await close(client); }
  }
  try {
    let dbSource;
    try { dbSource = fs.readFileSync(path.join(cwd, 'db.js')); } catch { throw fault('DEPLOYED_DB_SOURCE_UNAVAILABLE'); }
    output.runtimeConfiguration.dbSourceSha256 = sha(dbSource);
    output.runtimeConfiguration.profile = output.runtimeConfiguration.dbSourceSha256 === LEGACY_DB_SHA256 ? 'PINNED_DEPLOYED_LEGACY' : 'UNKNOWN';
    if (output.runtimeConfiguration.profile === 'UNKNOWN') throw fault('RUNTIME_CONNECTION_CONFIGURATION_UNRECOGNIZED');
    if (!env.DATABASE_URL) throw fault('DATABASE_URL_UNAVAILABLE');
    const uri = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(uri.protocol) || !uri.hostname) throw fault('INVALID_DATABASE_CONFIGURATION');
    if (!Client) Client = require('pg').Client;
    output.runtimeConfiguration.pgVersion = require('pg/package.json').version;
    const expectedIdentity = env.DATABASE_TLS_IDENTITY || uri.hostname.replace(/^\[|\]$/g, '');
    if (!/^[A-Za-z0-9:.-]{1,253}$/.test(expectedIdentity)) throw fault('INVALID_TLS_IDENTITY');
    output.runtimeConfiguration.expectedTlsIdentity = expectedIdentity;
    // Reproduce exactly the pinned deployed node-postgres connection configuration.
    // Add only per-client time limits; never import the module's testDb() side effect.
    let runtime;
    try {
      runtime = await createClient({connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: false}, connectionTimeoutMillis:6500, query_timeout:8500});
      const effective = runtime.connectionParameters?.ssl;
      const socket = runtime.connection?.stream;
      output.runtimeConfiguration.tls = {encrypted: socket?.encrypted === true, chainAuthorized: socket?.authorized === true, effectiveRejectUnauthorized: effective?.rejectUnauthorized === true};
      await begin(runtime);
      for (const [section, sql] of Object.entries(QUERIES)) {
        await query(runtime, 'savepoint', 'SAVEPOINT metadata_item');
        try { output.results[section] = (await query(runtime, section, sql, section === 'columns' ? [REQUIRED_TABLES.concat('incident_resolution_actions')] : [])).rows; }
        catch (error) { output.errors[section] = code(error); await query(runtime, 'rollback', 'ROLLBACK TO SAVEPOINT metadata_item'); }
        await query(runtime, 'release', 'RELEASE SAVEPOINT metadata_item');
      }
      const available = (output.results.migration_columns || []).map(row => row.column_name);
      const selected = SAFE_MIGRATION_COLUMNS.filter(name => available.includes(name));
      if (!selected.length) output.errors.migration_history = 'MIGRATION_METADATA_UNAVAILABLE';
      else {
        const names = selected.map(name => '"' + name + '"').join(',');
        const count = Number((await query(runtime, 'migration_count', 'SELECT count(*) AS total FROM public.schema_migrations')).rows[0].total);
        output.results.migration_history = (await query(runtime, 'migration_history', 'SELECT ' + names + ' FROM public.schema_migrations ORDER BY 1 LIMIT 1001')).rows;
        output.completeness.migrationRows = count;
        output.completeness.migrationHistoryTruncated = count > 1000;
        if (count > 1000) output.errors.migration_history = 'MIGRATION_HISTORY_EXCEEDS_BOUND';
      }
      await query(runtime, 'rollback', 'ROLLBACK');
    } catch (error) { output.errors.runtime_inventory = error.safeCode || code(error); }
    finally { if (runtime) await close(runtime); }
    // Trusted material must already exist independently of this peer. Never copy a peer CA.
    let ca;
    if (env.DATABASE_CA_FILE) { try { ca = fs.readFileSync(env.DATABASE_CA_FILE, 'utf8'); } catch { throw fault('CONFIGURED_CA_FILE_UNAVAILABLE'); } }
    if (ca && (!ca.includes('-----BEGIN CERTIFICATE-----') || ca.length > 262144)) throw fault('INVALID_CONFIGURED_CA');
    output.strictTls = {trustSource: ca ? 'EXISTING_CONFIGURED_CA_FILE' : 'NODE_CONFIGURED_TRUST_STORE'};
    output.strictTls.positive = await probe('strict_positive', expectedIdentity, ca);
    if (output.strictTls.positive.verified) {
      output.strictTls.wrongHost = await probe('wrong_host_negative', 'aegis-intentionally-wrong.invalid', ca);
      output.strictTls.untrustedCa = await probe('untrusted_ca_negative', expectedIdentity, PUBLIC_UNTRUSTED_CA);
      output.strictTls.negativeChecksPassed = output.strictTls.wrongHost.outcome === 'REJECTED' && output.strictTls.wrongHost.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && output.strictTls.untrustedCa.outcome === 'REJECTED' && ['SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(output.strictTls.untrustedCa.code);
    } else {
      output.strictTls.wrongHost = output.strictTls.untrustedCa = {outcome:'NOT_EXECUTED', reason:'TRUSTED_POSITIVE_CONNECTION_REQUIRED'};
      output.strictTls.negativeChecksPassed = false;
    }
  } catch (error) { output.errors.collector = error.safeCode || code(error); }
  finally { await Promise.all([...clients].map(client => close(client))); }
  output.completeness.missingTables = REQUIRED_TABLES.filter(name => !(output.results.tables || []).some(row => row.relname === name));
  output.completeness.missingColumnTables = REQUIRED_TABLES.filter(name => !(output.results.columns || []).some(row => row.table_name === name));
  output.completeness.missingSections = Object.keys(QUERIES).filter(name => !Object.hasOwn(output.results, name));
  output.completeness.catalogComplete = Object.keys(output.errors).length === 0 && output.completeness.missingTables.length === 0 && output.completeness.missingSections.length === 0 && output.completeness.missingColumnTables.length === 0 && !output.completeness.migrationHistoryTruncated;
  const runtimeRole = output.results.environment?.[0]?.runtime_role;
  const role = (output.results.roles || []).find(row => row.rolname === runtimeRole);
  output.completeness.runtimeLeastPrivilege = !role ? 'UNKNOWN' : role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb ? 'REQUIRES_REMEDIATION_REVIEW' : 'ROLE_FLAGS_RECORDED_REVIEW_OBJECT_GRANTS';
  output.status = output.completeness.catalogComplete && output.strictTls?.positive?.verified && output.strictTls?.negativeChecksPassed ? 'EVIDENCE_COLLECTED_REQUIRES_REVIEW' : 'INCOMPLETE_BLOCKED';
  return output;
}
async function runCli({collectFn = collect, deadlineMs = 300000} = {}) {
  let emitted = false;
  const emit = result => { if (emitted) return; emitted = true; process.stdout.write('AEGIS_READONLY_EVIDENCE_BEGIN\n' + JSON.stringify(result, null, 2) + '\nAEGIS_READONLY_EVIDENCE_END\n'); };
  const timer = setTimeout(() => { emit({collectorVersion:2,status:'INCOMPLETE_BLOCKED',errors:{collector:'COLLECTOR_DEADLINE_EXCEEDED'},productionMutations:false}); process.exit(2); }, Math.min(300000, Math.max(25, Number(deadlineMs) || 300000)));
  try { const result = await collectFn(); emit(result); if (result.status !== 'EVIDENCE_COLLECTED_REQUIRES_REVIEW') process.exitCode = 2; }
  catch { emit({collectorVersion:2,status:'INCOMPLETE_BLOCKED',errors:{collector:'CONTROLLED_COLLECTION_FAILURE'},productionMutations:false}); process.exitCode = 2; }
  finally { clearTimeout(timer); }
}
module.exports = {collect, runCli, attestSocket, strictOptions, QUERIES, REQUIRED_TABLES, LEGACY_DB_SHA256, PUBLIC_UNTRUSTED_CA};
if (require.main === module) void runCli();
