const test=require('node:test');const assert=require('node:assert/strict');const c=require('node:crypto');
const {validateDefinition,validateAnswers,canonical,fingerprint,LIMITS}=require('../questionnaire/contract');
const {Keyring}=require('../questionnaire/crypto');
const qid='11111111-1111-4111-8111-111111111111', sid='22222222-2222-4222-8222-222222222222',cid='33333333-3333-4333-8333-333333333333';
function definition(){return {title:'Synthetic test',questions:[{id:qid,prompt:'Synthetic question',help:'',type:'LONG_TEXT',required:true,maxLength:5000}]};}
function submission(){return {protocolVersion:2,snapshotId:sid,snapshotDigest:'opaque',clientSubmissionId:cid,answers:[{questionId:qid,value:'Synthetic answer'}],omittedOptionalQuestionIds:[]};}
const snapshot={id:sid,digest:'opaque',questions:validateDefinition(definition()).questions};
function entry(id){const pair=c.generateKeyPairSync('rsa',{modulusLength:3072});return {id,publicKey:pair.publicKey.export({type:'spki',format:'pem'}),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),integrityKey:c.randomBytes(32).toString('base64')};}
const first=entry('isolated-v1'),second=entry('isolated-v2');
test('definition bounds, unsupported types, stable IDs, required whitespace and Unicode code points',()=>{
 assert.equal(validateDefinition(definition()).questions[0].position,1);
 for(const questions of [[],Array(13).fill(definition().questions[0])])assert.throws(()=>validateDefinition({...definition(),questions}));
 for(const type of ['YES_NO','AI_GENERATED','SINGLE_CHOICE'])assert.throws(()=>validateDefinition({...definition(),questions:[{...definition().questions[0],type}]}));
 assert.throws(()=>validateDefinition({...definition(),companyId:4}));
 assert.throws(()=>validateDefinition({...definition(),questions:[{...definition().questions[0],provenance:'PLATFORM_DEFAULT'}]}));
 const input=submission();input.answers[0].value='😀'.repeat(5000);assert.equal(validateAnswers(snapshot,input).answers[0].value.length,10000);
 input.answers[0].value+='😀';assert.throws(()=>validateAnswers(snapshot,input));
 input.answers[0].value='   ';assert.throws(()=>validateAnswers(snapshot,input));
});
test('optional omissions support zero answers, while unknown IDs and substituted snapshots fail',()=>{
 const s={...snapshot,questions:snapshot.questions.map(q=>({...q,required:false}))};
 assert.equal(validateAnswers(s,{...submission(),answers:[],omittedOptionalQuestionIds:[qid]}).answers.length,0);
 assert.throws(()=>validateAnswers(snapshot,{...submission(),snapshotDigest:'forged'}));
 assert.throws(()=>validateAnswers(snapshot,{...submission(),answers:[...submission().answers,...submission().answers]}));
 assert.throws(()=>validateAnswers(snapshot,{...submission(),answers:[{questionId:cid,value:'test'}]}));
});
test('AES-GCM and RSA-OAEP envelopes are random, identity-bound and reject ciphertext tampering',()=>{
 const ring=new Keyring([first],'isolated-v1');const who={incidentId:40,guardId:2,sessionId:5,revision:1};const value={answers:['synthetic-canary']};
 const a=ring.seal(7,'draft',who,value),b=ring.seal(7,'draft',who,value);
 assert.notEqual(a.iv,b.iv);assert.notEqual(a.wrappedKey,b.wrappedKey);assert.ok(!JSON.stringify(a).includes('synthetic-canary'));
 assert.deepEqual(ring.open(7,'draft',who,a),value);
 for(const [scope,purpose,identity] of [[8,'draft',who],[7,'response',who],[7,'draft',{...who,sessionId:6}],[7,'draft',{...who,revision:2}]])assert.throws(()=>ring.open(scope,purpose,identity,a));
 for(const field of ['ciphertext','tag','iv','wrappedKey']){const forged=structuredClone(a);let data=Buffer.from(forged[field],'base64');data[0]^=1;forged[field]=data.toString('base64');assert.throws(()=>ring.open(7,'draft',who,forged));}
 assert.throws(()=>ring.open(7,'draft',who,{...a,version:2}));
});
test('rotation retains historical decryption and tenant integrity differs from public receipt fingerprints',()=>{
 const old=new Keyring([first],first.id),rotated=new Keyring([first,second],second.id);const value={answer:'synthetic'};
 const env=old.seal(7,'draft',{session:5},value);assert.deepEqual(rotated.open(7,'draft',{session:5},env),value);
 assert.notEqual(rotated.integrity(7,'submission',value),rotated.integrity(8,'submission',value));
 assert.notEqual(rotated.integrity(7,'submission',value),fingerprint(value));
 assert.equal(old.integrity(7,'submission',value),rotated.integrity(7,'submission',value,first.id));
 assert.throws(()=>new Keyring([second],second.id).open(7,'draft',{session:5},env));
 assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
 assert.equal(LIMITS.envelopeBytes,98304);
});
test('file custody rejects public permissions, symlinks, malformed material and missing historical keys',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-synthetic-key-'));const file=path.join(dir,'ring.json');
 try{
  fs.writeFileSync(file,JSON.stringify({active:first.id,entries:[first,second]}),{mode:0o600});
  const loaded=Keyring.fromFile(file),value={answer:'Synthetic custody test'};const env=loaded.seal('tenant-a','draft',{sessionId:1},value);assert.deepEqual(loaded.open('tenant-a','draft',{sessionId:1},env),value);
  fs.chmodSync(file,0o640);assert.throws(()=>Keyring.fromFile(file),e=>e.code==='INVALID_KEY_CUSTODY');fs.chmodSync(file,0o600);
  const link=path.join(dir,'link.json');fs.symlinkSync(file,link);assert.throws(()=>Keyring.fromFile(link),e=>e.code==='INVALID_KEY_CUSTODY');
  fs.writeFileSync(file,JSON.stringify({active:first.id,entries:[{...first,privateKey:second.privateKey}]}));assert.throws(()=>Keyring.fromFile(file));
  fs.writeFileSync(file,'malformed');assert.throws(()=>Keyring.fromFile(file),e=>e.code==='INVALID_KEY_CUSTODY');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('Railway runtime key injection is consumed in memory, rejects ambiguous sources and retains historical decrypt keys',()=>{
 const encoded=Buffer.from(JSON.stringify({active:second.id,entries:[first,second]})).toString('base64');const env={QUESTIONNAIRE_KEYRING_BASE64:encoded};
 const ring=Keyring.fromEnvironment(env);assert.equal(env.QUESTIONNAIRE_KEYRING_BASE64,undefined);assert.equal(ring.active,second.id);
 const value={answer:'Synthetic escrow restore canary'},identity={sessionId:1};const old=new Keyring([first],first.id).seal('tenant-a','draft',identity,value);assert.deepEqual(ring.open('tenant-a','draft',identity,old),value);
 for(const supplied of ['not-base64',Buffer.from('{bad json').toString('base64'),Buffer.from(JSON.stringify({active:first.id,entries:[{...first,privateKey:second.privateKey}]})).toString('base64')]){
  const env={QUESTIONNAIRE_KEYRING_BASE64:supplied};assert.throws(()=>Keyring.fromEnvironment(env),e=>e.code==='INVALID_KEY_CUSTODY'&&!String(e).includes(supplied));assert.equal(env.QUESTIONNAIRE_KEYRING_BASE64,undefined);
 }
 assert.throws(()=>Keyring.fromEnvironment({QUESTIONNAIRE_KEYRING_FILE:'/synthetic/path',QUESTIONNAIRE_KEYRING_BASE64:encoded}),e=>e.code==='AMBIGUOUS_KEY_CUSTODY');
});
