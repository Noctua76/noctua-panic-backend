'use strict';
const c=require('node:crypto');
const fs=require('node:fs');
const {canonical,bounded,fields,fail,LIMITS}=require('./contract');
const ALGORITHM='RSA-OAEP-256+A256GCM';
function decode(value,length){
 if(typeof value!=='string'||!value.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail('INVALID_ENVELOPE');
 const buf=Buffer.from(value,'base64');if(buf.toString('base64')!==value||(length&&buf.length!==length))fail('INVALID_ENVELOPE');return buf;
}
function publicKey(key){
 const k=c.createPublicKey(key);if(k.asymmetricKeyType!=='rsa'||k.asymmetricKeyDetails.modulusLength<3072)fail('INVALID_STORAGE_KEY',503);return k;
}
function seal(publicPem,keyId,identity,value){
 const key=c.randomBytes(32),iv=c.randomBytes(12);const aad={...identity,envelopeVersion:1,keyId};
 const cipher=c.createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAAD(Buffer.from(canonical(aad)));
 const ciphertext=Buffer.concat([cipher.update(bounded(value),'utf8'),cipher.final()]);
 try{return {version:1,algorithm:ALGORITHM,keyId,aad,iv:iv.toString('base64'),wrappedKey:c.publicEncrypt({key:publicKey(publicPem),padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};}
 finally{key.fill(0);}
}
class Keyring {
 // Inject only non-production keys in tests. Production loading is explicit and fails closed.
 constructor(entries,active){this.entries=new Map(entries.map(e=>[e.id,e]));if(!this.entries.has(active))fail('STORAGE_KEY_UNAVAILABLE',503);this.active=active;}
 entry(keyId){const e=this.entries.get(keyId);if(!e)fail('STORAGE_KEY_UNAVAILABLE',503);return e;}
 public(scope){const e=this.entry(this.active);return {version:1,algorithm:ALGORITHM,keyId:e.id,scope:String(scope),publicKey:publicKey(e.publicKey).export({format:'jwk'})};}
 seal(scope,purpose,identity,value){const e=this.entry(this.active);return seal(e.publicKey,e.id,{scope:String(scope),purpose,...identity},value);}
 open(scope,purpose,identity,envelope){
  bounded(envelope,LIMITS.envelopeBytes);fields(envelope,['version','algorithm','keyId','aad','iv','wrappedKey','ciphertext','tag']);
  if(envelope.version!==1||envelope.algorithm!==ALGORITHM||canonical(envelope.aad)!==canonical({scope:String(scope),purpose,...identity,envelopeVersion:1,keyId:envelope.keyId}))fail('ENVELOPE_IDENTITY_MISMATCH',403);
  const e=this.entry(envelope.keyId);let key;
  try{
   key=c.privateDecrypt({key:e.privateKey,padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},decode(envelope.wrappedKey));
   if(key.length!==32)fail('INVALID_ENVELOPE');
   const decipher=c.createDecipheriv('aes-256-gcm',key,decode(envelope.iv,12),{authTagLength:16});
   decipher.setAAD(Buffer.from(canonical(envelope.aad)));decipher.setAuthTag(decode(envelope.tag,16));
   const raw=Buffer.concat([decipher.update(decode(envelope.ciphertext)),decipher.final()]);
   if(raw.length>LIMITS.plainBytes)fail('PAYLOAD_TOO_LARGE',413);return JSON.parse(raw.toString('utf8'));
  }catch(err){if(err.code==='STORAGE_KEY_UNAVAILABLE'||err.code==='PAYLOAD_TOO_LARGE')throw err;fail('INVALID_ENVELOPE');}
  finally{key?.fill(0);}
 }
 integrity(scope,purpose,value,keyId=this.active){
  const e=this.entry(keyId);const master=decode(e.integrityKey,32);
  try{const tenant=c.createHmac('sha256',master).update(canonical({scope:String(scope),purpose})).digest();try{return keyId+':'+c.createHmac('sha256',tenant).update(bounded(value)).digest('hex');}finally{tenant.fill(0);}}
  finally{master.fill(0);}
 }
 static fromFile(filename){
  // Validate the opened descriptor, not a pathname checked before a second open.
  // A symlink or replacement between lstat/read must not redirect private-key reads.
  let fd,raw;
  try{
   fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   const stat=fs.fstatSync(fd);if(!stat.isFile()||(stat.mode&0o077)||stat.uid!==process.getuid?.()||stat.size<1||stat.size>1048576)fail('INVALID_KEY_CUSTODY',503);
   raw=JSON.parse(fs.readFileSync(fd,'utf8'));
  }catch{fail('INVALID_KEY_CUSTODY',503);}finally{if(fd!==undefined)fs.closeSync(fd);}
  return Keyring.fromObject(raw);
 }
 static fromEnvironment(env=process.env){
  const filename=env.QUESTIONNAIRE_KEYRING_FILE,encoded=env.QUESTIONNAIRE_KEYRING_BASE64;
  if(encoded!==undefined)delete env.QUESTIONNAIRE_KEYRING_BASE64;
  if(filename&&encoded!==undefined)fail('AMBIGUOUS_KEY_CUSTODY',503);
  if(filename)return Keyring.fromFile(filename);
  let bytes;
  try{
   if(typeof encoded!=='string'||encoded.length<1||encoded.length>1398104)fail('INVALID_KEY_CUSTODY',503);
   bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded||bytes.length>1048576)fail('INVALID_KEY_CUSTODY',503);
   return Keyring.fromObject(JSON.parse(bytes.toString('utf8')));
  }catch{fail('INVALID_KEY_CUSTODY',503);}finally{bytes?.fill(0);}
 }
 static fromObject(raw){
  fields(raw,['active','entries']);
  if(!Array.isArray(raw.entries)||!raw.entries.length||raw.entries.length>20)fail('INVALID_KEY_CUSTODY',503);
  for(const e of raw.entries){fields(e,['id','publicKey','privateKey','integrityKey']);if(!/^[A-Za-z0-9_-]{1,60}$/.test(e.id))fail('INVALID_KEY_CUSTODY',503);publicKey(e.publicKey);decode(e.integrityKey,32);const priv=c.createPrivateKey(e.privateKey);if(!c.createPublicKey(priv).export({type:'spki',format:'pem'}).includes(publicKey(e.publicKey).export({type:'spki',format:'pem'})))fail('INVALID_KEY_CUSTODY',503);}
  if(new Set(raw.entries.map(e=>e.id)).size!==raw.entries.length)fail('INVALID_KEY_CUSTODY',503);return new Keyring(raw.entries,raw.active);
 }
}
module.exports={Keyring,seal,ALGORITHM};
