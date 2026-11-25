'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {Client}=require('pg');
const collector=require('../docs/questionnaire/production-readonly-collector.cjs');
const sourcePath=require.resolve('../docs/questionnaire/production-readonly-collector.cjs');
const baseSource=execFileSync('git',['show','8948b767febb47458d9f3ff1f2f36f78c5439246:db.js'],{cwd:path.resolve(__dirname,'..')});
function command(exe,args,options={}){return execFileSync(exe,args,{timeout:15000,stdio:'ignore',...options});}
test('standalone collector uses actual node-postgres TLS, read-only catalog and controlled output',{timeout:45000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-collector-tls-')),data=path.join(root,'data');
 const pgBin=process.env.AEGIS_PG_SERVER_BIN||'/usr/lib/postgresql/16/bin';let started=false;
 t.after(()=>{if(started)command(path.join(pgBin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command(path.join(pgBin,'initdb'),['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 const ca=path.join(root,'ca.crt'),key=path.join(root,'ca.key'),serverKey=path.join(data,'server.key'),serverCert=path.join(data,'server.crt');
 command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',ca,'-days','1','-subj','/CN=AEGIS-SYNTHETIC-COLLECTOR-CA','-addext','basicConstraints=critical,CA:TRUE']);
 command('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',serverKey,'-out',path.join(root,'server.csr'),'-subj','/CN=localhost']);
 fs.writeFileSync(path.join(root,'extensions.txt'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
 command('openssl',['x509','-req','-in',path.join(root,'server.csr'),'-CA',ca,'-CAkey',key,'-CAcreateserial','-out',serverCert,'-days','1','-extfile',path.join(root,'extensions.txt')]);fs.chmodSync(serverKey,0o600);
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nssl=on\nssl_cert_file='server.crt'\nssl_key_file='server.key'\nlog_statement='none'\n");
 command(path.join(pgBin,'pg_ctl'),['-D',data,'-l',path.join(root,'server.log'),'-o','-h 127.0.0.1 -p 54339 -k \'\'','-w','start']);started=true;
 const admin=new Client({connectionString:'postgresql://postgres@127.0.0.1:54339/postgres'});await admin.connect();
 t.after(()=>admin.end());
 await admin.query('CREATE ROLE aegis_collector_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
 for(const name of collector.REQUIRED_TABLES){await admin.query(name==='schema_migrations'?'CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())':`CREATE TABLE ${name}(id integer PRIMARY KEY)`);}
 await admin.query("INSERT INTO schema_migrations(name) VALUES('2026-09-14-operational-security.sql'),('2026-10-02-private-site-sop.sql');ALTER TABLE incidents ADD COLUMN private_note text;INSERT INTO incidents VALUES(1,'SYNTHETIC_OPERATIONAL_ROW_CANARY');GRANT SELECT ON ALL TABLES IN SCHEMA public TO aegis_collector_runtime");
 fs.writeFileSync(path.join(root,'db.js'),baseSource);
 const env={...process.env,DATABASE_URL:'postgresql://aegis_collector_runtime:synthetic-credential-canary@127.0.0.1:54339/postgres',DATABASE_CA_FILE:ca,DATABASE_TLS_IDENTITY:'localhost'};
 await t.test('successful chain and hostname checks are observed, negative connections reject through pg',async()=>{
  const queries=[];const result=await collector.collect({cwd:root,env,observeQuery:q=>queries.push(q)});
  assert.equal(result.completeness.catalogComplete,true,JSON.stringify(result.errors));assert.equal(result.status,'EVIDENCE_COLLECTED_REQUIRES_REVIEW');
  assert.equal(result.strictTls.positive.chainVerified,true);assert.equal(result.strictTls.positive.hostnameVerified,true);assert.ok(result.strictTls.positive.driverIdentityChecks>0);
  assert.equal(result.strictTls.wrongHost.code,'ERR_TLS_CERT_ALTNAME_INVALID');assert.ok(result.strictTls.wrongHost.driverIdentityChecks>0);assert.equal(result.strictTls.wrongHost.driverIdentityRejected,true);
  assert.equal(result.strictTls.untrustedCa.outcome,'REJECTED');assert.equal(result.strictTls.negativeChecksPassed,true);
  assert.equal(result.runtimeConfiguration.tls.effectiveRejectUnauthorized,false);assert.equal(result.runtimeConfiguration.tls.chainAuthorized,false);
  assert.equal(result.results.environment[0].runtime_role,'aegis_collector_runtime');assert.equal(result.results.environment[0].transaction_read_only,'on');
  assert.equal(result.results.database_privileges[0].can_create,false);assert.equal(result.results.tables.find(r=>r.relname==='incidents').can_select,true);assert.equal(result.results.tables.find(r=>r.relname==='incidents').can_truncate,false);
  assert.equal(result.results.migration_history.length,2);assert.ok(result.results.routines);assert.ok(result.results.default_acl);assert.ok(result.results.sequences);
  assert.equal(result.execution.writeStatements,0);assert.equal(result.execution.readOnlyTransactionsVerified,2);
  assert.ok(queries.every(q=>/^(SELECT |BEGIN READ ONLY$|SET LOCAL |SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK)/.test(q.sql)));
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_OPERATIONAL_ROW_CANARY'));assert.ok(!JSON.stringify(result).includes('synthetic-credential-canary'));assert.ok(!JSON.stringify(result).includes('BEGIN CERTIFICATE'));
  assert.equal(require.cache[path.join(root,'db.js')],undefined);
 });
 await t.test('candidate databaseOptions is exercised through the pg SSLRequest path, with both negative handshakes',async()=>{
  const {databaseOptions}=require('../security/database-tls');
  async function connect(identity,caFile=ca){const client=new Client({...databaseOptions({connectionString:env.DATABASE_URL,caFile,serverIdentity:identity}),connectionTimeoutMillis:2000});client.on('error',()=>{});try{await client.connect();assert.equal(collector.attestSocket(client,identity).verified,true);}finally{await client.end().catch(()=>{});}}
  await connect('localhost');await assert.rejects(connect('wrong.invalid'),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');
  const wrongCa=path.join(root,'untrusted.crt');fs.writeFileSync(wrongCa,collector.PUBLIC_UNTRUSTED_CA);await assert.rejects(connect('localhost',wrongCa));
 });
 await t.test('unavailable trusted CA cannot produce a hostname PASS or misleading negative PASS',async()=>{
  const result=await collector.collect({cwd:root,env:{...env,DATABASE_CA_FILE:undefined}});
  assert.equal(result.strictTls.positive.verified,false);assert.equal(result.strictTls.positive.hostnameVerified,false);assert.equal(result.strictTls.wrongHost.outcome,'NOT_EXECUTED');assert.equal(result.strictTls.negativeChecksPassed,false);assert.equal(result.status,'INCOMPLETE_BLOCKED');
 });
 await t.test('node-postgres URI TLS overrides cannot disable the strict probe',async()=>{
  const telemetry={driverIdentityChecks:0};const options=collector.strictOptions(env.DATABASE_URL+'?sslmode=no-verify&uselibpqcompat=true','localhost',collector.PUBLIC_UNTRUSTED_CA,telemetry);
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'),false);
  const client=new Client(options);client.on('error',()=>{});try{await assert.rejects(client.connect());}finally{await client.end().catch(()=>{});}
 });
 await t.test('standalone CLI never imports the deployed startup module or emits driver diagnostics',async()=>{
  const child=spawnSync(process.execPath,['--no-warnings',sourcePath],{cwd:root,env:{...env,NODE_PATH:path.resolve(__dirname,'../node_modules')},encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');assert.ok(child.stdout.startsWith('AEGIS_READONLY_EVIDENCE_BEGIN\n'));assert.ok(child.stdout.trimEnd().endsWith('AEGIS_READONLY_EVIDENCE_END'));
  assert.ok(!child.stdout.includes('Postgres connected'));assert.ok(!child.stdout.includes('synthetic-credential-canary'));assert.ok(!child.stdout.includes('SYNTHETIC_OPERATIONAL_ROW_CANARY'));
 });
 await t.test('PowerShell procedure verifies payload and transports only a bound read-only collector over authenticated SSH',async()=>{
  const wrapper=path.resolve(__dirname,'../docs/questionnaire/owner/AEGIS-Production-Readonly-v3.ps1');
  const fakeBin=path.join(root,'fake-cli'),out=path.join(root,'owner-output');fs.mkdirSync(fakeBin);fs.mkdirSync(out);
  const fake=path.join(fakeBin,'railway');fs.writeFileSync(fake,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "railway 4.0.0"; exit 0; fi\nif [ "$1" = "whoami" ]; then echo "{\\"id\\":\\"synthetic-owner\\"}"; exit 0; fi\nif [ "$1" = "ssh" ]; then exec "'+process.execPath+'" --no-warnings; fi\nexit 91\n');fs.chmodSync(fake,0o700);
  const pwsh=process.env.AEGIS_PWSH_PATH||'pwsh';
  const child=spawnSync(pwsh,['-NoProfile','-File',wrapper,'-OutputDirectory',out],{cwd:root,env:{...env,PATH:fakeBin+path.delimiter+process.env.PATH,NODE_PATH:path.resolve(__dirname,'../node_modules')},encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);const files=fs.readdirSync(out);assert.equal(files.length,1);const evidence=JSON.parse(fs.readFileSync(path.join(out,files[0]),'utf8'));assert.equal(evidence.collectorVersion,2);assert.equal(evidence.strictTls.negativeChecksPassed,true);assert.ok(!child.stdout.includes('synthetic-credential-canary'));
  const tampered=path.join(root,'tampered.ps1');const original=fs.readFileSync(wrapper,'utf8');fs.writeFileSync(tampered,original.replace(/(\$AegisExpectedPayloadSha256 = ')[a-f0-9]{64}/,"$1"+'0'.repeat(64)));
  const rejected=spawnSync(pwsh,['-NoProfile','-File',tampered,'-OutputDirectory',out],{cwd:root,env:{...env,PATH:fakeBin+path.delimiter+process.env.PATH},encoding:'utf8',timeout:5000});assert.notEqual(rejected.status,0);assert.equal(fs.readdirSync(out).length,1);assert.ok(rejected.stdout.includes('COLLECTOR_PAYLOAD_HASH_MISMATCH'));
 });
 await t.test('unexpected deployed source is refused before any connection or catalog query',async()=>{
  fs.writeFileSync(path.join(root,'db.js'),baseSource.toString()+'\nthrow new Error("SYNTHETIC_STARTUP_CANARY");');const queries=[];
  const result=await collector.collect({cwd:root,env,observeQuery:q=>queries.push(q)});assert.equal(result.errors.collector,'RUNTIME_CONNECTION_CONFIGURATION_UNRECOGNIZED');assert.equal(queries.length,0);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_STARTUP_CANARY'));fs.writeFileSync(path.join(root,'db.js'),baseSource);
 });
 await t.test('migration history bounds and missing sections cannot be marked complete',async()=>{
  await admin.query('ALTER TABLE schema_migrations RENAME TO saved_schema_migrations');
  try{const result=await collector.collect({cwd:root,env});assert.equal(result.completeness.catalogComplete,false);assert.equal(result.status,'INCOMPLETE_BLOCKED');assert.equal(result.errors.migration_history,'MIGRATION_METADATA_UNAVAILABLE');}
  finally{await admin.query('ALTER TABLE saved_schema_migrations RENAME TO schema_migrations');}
 });
});


test('collector deadline and exceptional failures emit one sanitized record without stack or startup diagnostics',()=>{
 for(const mode of ['deadline','failure']){
  const code=`require(${JSON.stringify(sourcePath)}).runCli({deadlineMs:35,collectFn:()=>${mode==='deadline'?'new Promise(()=>{})':'Promise.reject(new Error("SYNTHETIC_EXCEPTION_CANARY"))'}})`;
  const start=Date.now(),child=spawnSync(process.execPath,['--no-warnings','-e',code],{encoding:'utf8',timeout:2000});
  assert.equal(child.status,2);assert.equal(child.stderr,'');assert.ok(Date.now()-start<2000);assert.equal((child.stdout.match(/AEGIS_READONLY_EVIDENCE_BEGIN/g)||[]).length,1);assert.ok(!child.stdout.includes('SYNTHETIC_EXCEPTION_CANARY'));assert.ok(child.stdout.includes(mode==='deadline'?'COLLECTOR_DEADLINE_EXCEEDED':'CONTROLLED_COLLECTION_FAILURE'));
 }
});
