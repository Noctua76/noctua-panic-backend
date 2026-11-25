'use strict';
const fs=require('node:fs');const tls=require('node:tls');const net=require('node:net');
// No credentials, CA contents or connection strings are included in diagnostic errors.
function databaseOptions({connectionString,caFile,serverIdentity}={}){
 let url;try{url=new URL(connectionString);}catch{throw new Error('DATABASE_URL_REQUIRED');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname)throw new Error('DATABASE_URL_INVALID');
 const mode=url.searchParams.get('sslmode');
 if(mode&&!['require','verify-full'].includes(mode))throw new Error('DATABASE_TLS_MODE_REJECTED');
 for(const field of ['sslcert','sslkey','sslrootcert'])if(url.searchParams.has(field))throw new Error('DATABASE_TLS_URI_OVERRIDE_REJECTED');
 url.searchParams.delete('sslmode');url.searchParams.delete('ssl');
 const expected=serverIdentity||url.hostname.replace(/^\[|\]$/g,'');
 if(!net.isIP(expected)&&!(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(expected)))throw new Error('DATABASE_TLS_IDENTITY_INVALID');
 let ca;if(caFile){try{ca=fs.readFileSync(caFile,'utf8');}catch{throw new Error('DATABASE_TLS_CA_UNAVAILABLE');}if(!ca.includes('-----BEGIN CERTIFICATE-----'))throw new Error('DATABASE_TLS_CA_INVALID');}
 return {connectionString:url.toString(),ssl:{rejectUnauthorized:true,minVersion:'TLSv1.2',...(ca?{ca}:{}),checkServerIdentity:(_hostname,cert)=>tls.checkServerIdentity(expected,cert)}};
}
module.exports={databaseOptions};

// Explicit, temporary release exception approved by Owner 2026-11-25.
// Keep strict validation as the default; preserve the observed encrypted production
// profile only until the existing self-signed trust chain is independently repaired.
function runtimeDatabaseOptions(env=process.env){
 if(env.AEGIS_DATABASE_TLS_POLICY!=='preserve-existing-encrypted')return databaseOptions({connectionString:env.DATABASE_URL,caFile:env.DATABASE_CA_FILE,serverIdentity:env.DATABASE_TLS_IDENTITY});
 let url;try{url=new URL(env.DATABASE_URL);}catch{throw new Error('DATABASE_URL_REQUIRED');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname)throw new Error('DATABASE_URL_INVALID');
 if(url.searchParams.get('sslmode')==='verify-full'||env.DATABASE_CA_FILE)throw new Error('VERIFIED_DATABASE_PROFILE_CANNOT_BE_DOWNGRADED');
 for(const field of ['sslmode','ssl','sslcert','sslkey','sslrootcert','uselibpqcompat'])url.searchParams.delete(field);
 return {connectionString:url.toString(),ssl:{rejectUnauthorized:false,minVersion:'TLSv1.2'}};
}
module.exports.runtimeDatabaseOptions=runtimeDatabaseOptions;
