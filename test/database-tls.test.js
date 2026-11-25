const test=require('node:test');const assert=require('node:assert/strict');const tls=require('node:tls');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');const {databaseOptions}=require('../security/database-tls');
test('strict TLS rejects disabling and URI overrides without disclosing credentials',()=>{
 const good=databaseOptions({connectionString:'postgresql://synthetic:synthetic@db.test/demo?sslmode=require'});
 assert.equal(good.ssl.rejectUnauthorized,true);assert.equal(new URL(good.connectionString).searchParams.has('sslmode'),false);
 for(const query of ['sslmode=disable','sslmode=no-verify','sslmode=verify-ca','sslrootcert=/tmp/unsafe'])assert.throws(()=>databaseOptions({connectionString:'postgresql://synthetic:synthetic@db.test/demo?'+query}));
 assert.throws(()=>databaseOptions({connectionString:'not a URL'}),/DATABASE_URL_REQUIRED/);
});
test('actual TLS handshake verifies trusted server identity and rejects unknown CA or wrong name',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-tls-synthetic-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-days','1','-subj','/CN=synthetic-db.test','-addext','subjectAltName=DNS:synthetic-db.test'],{stdio:'ignore'});
 const server=tls.createServer({key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))},s=>s.end());
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 async function connect({trusted=true,identity='synthetic-db.test'}={}){
  const opts=databaseOptions({connectionString:'postgresql://synthetic@127.0.0.1/demo',...(trusted?{caFile:path.join(dir,'cert.pem')}:{}),serverIdentity:identity});
  return new Promise((resolve,reject)=>{const socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:identity,...opts.ssl},()=>{socket.end();resolve(socket.authorized);});socket.on('error',reject);});
 }
 try{assert.equal(await connect(),true);await assert.rejects(connect({trusted:false}));await assert.rejects(connect({identity:'other-db.test'}));}
 finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});

const {runtimeDatabaseOptions}=require('../security/database-tls');
test('Owner release exception is explicit, encrypted, and cannot downgrade a verified profile',()=>{
 const base={DATABASE_URL:'postgresql://synthetic@db.test/demo'};
 assert.equal(runtimeDatabaseOptions(base).ssl.rejectUnauthorized,true);
 const temporary=runtimeDatabaseOptions({...base,AEGIS_DATABASE_TLS_POLICY:'preserve-existing-encrypted'});
 assert.equal(temporary.ssl.rejectUnauthorized,false);assert.equal(temporary.ssl.minVersion,'TLSv1.2');
 for(const extra of [{DATABASE_URL:base.DATABASE_URL+'?sslmode=verify-full'},{DATABASE_CA_FILE:'/synthetic-ca'}])assert.throws(()=>runtimeDatabaseOptions({...base,...extra,AEGIS_DATABASE_TLS_POLICY:'preserve-existing-encrypted'}),/CANNOT_BE_DOWNGRADED/);
});
