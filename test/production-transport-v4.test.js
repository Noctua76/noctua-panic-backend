'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn,spawnSync,execFileSync}=require('node:child_process');
const q=s=>"'"+s.replaceAll("'","''")+"'";
const pwsh=process.env.AEGIS_PWSH_PATH||'pwsh',template=fs.readFileSync(path.resolve(__dirname,'../docs/questionnaire/owner/v4/Owner-Transport.template.ps1'),'utf8');
const functions=template.slice(template.indexOf('function Resolve-AegisLauncher'),template.indexOf('# MAIN:'));
function ps(body,dir,timeout=15000){const setup=`$ErrorActionPreference='Stop';$AegisOverall=[Diagnostics.Stopwatch]::StartNew();$AegisTemp=${q(dir)};$AegisReport=@{stages=(New-Object 'System.Collections.Generic.List[object]')};`;
 const result=spawnSync(pwsh,['-NoProfile','-NonInteractive','-Command',setup+functions+'\n'+body],{encoding:'utf8',timeout});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);return result.stdout;}
function cmd(exe,args){return execFileSync(exe,args,{timeout:10000,stdio:'pipe'});}
test('v4 actual OpenSSH: strict host/key authentication, remote Node and collector-sized EOF across small/large stdin',{timeout:30000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-v4-ssh-'));let server;const port=54349;
 t.after(()=>{if(server)server.kill();fs.rmSync(root,{recursive:true,force:true});});
 const host=path.join(root,'host'),client=path.join(root,'client'),wrong=path.join(root,'wrong');
 for(const key of [host,client,wrong])cmd('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
 const username=os.userInfo().username,config=path.join(root,'sshd_config'),known=path.join(root,'known_hosts');
 fs.writeFileSync(known,'[127.0.0.1]:'+port+' '+fs.readFileSync(host+'.pub','utf8'));
 fs.writeFileSync(config,`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${host}\nAuthorizedKeysFile ${client}.pub\nPidFile ${root}/server.pid\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${username}\nLogLevel ERROR\n`);
 server=spawn('/usr/sbin/sshd',['-D','-e','-f',config],{stdio:['ignore','ignore','pipe']});let serverError='';server.stderr.on('data',b=>serverError+=b);await new Promise(r=>setTimeout(r,150));assert.equal(server.exitCode,null,serverError);
 const base=['-F','/dev/null','-T','-v','-p',String(port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','IdentitiesOnly=yes','-o','UserKnownHostsFile='+known,'-o','GlobalKnownHostsFile=/dev/null','-i',client,'-l',username,'127.0.0.1'];
 const node=process.execPath;
 const payloadLength=Buffer.byteLength('const b=Buffer.from("'+Buffer.from(fs.readFileSync(path.resolve(__dirname,'../docs/questionnaire/production-readonly-collector.cjs'))).toString('base64')+'","base64");')+500;
 const small='console.log("AEGIS_SMALL_ACTUAL_SSH")';const large='console.log("AEGIS_LARGE_ACTUAL_SSH");/*'+'x'.repeat(payloadLength)+'*/';
 const code=`$base=@(${base.map(q).join(',')});$r=Invoke-AegisTransport '/usr/bin/ssh' ($base+@(${q(node)},'-p','730000000123456')) '' 5000 'NODE_NONCE';Assert-AegisResult $r '730000000123456';$r=Invoke-AegisTransport '/usr/bin/ssh' ($base+@(${q(node)})) ${q(small)} 5000 'SMALL';Assert-AegisResult $r 'AEGIS_SMALL_ACTUAL_SSH';$r=Invoke-AegisTransport '/usr/bin/ssh' ($base+@(${q(node)})) ${q(large)} 5000 'LARGE';Assert-AegisResult $r 'AEGIS_LARGE_ACTUAL_SSH';$AegisReport|ConvertTo-Json -Depth 5 -Compress`;
 const result=JSON.parse(ps(code,root));assert.equal(result.stages.length,3);assert.ok(result.stages.every(v=>v.classification==='PASS_EXPECTED_REMOTE_SENTINEL'));assert.ok(result.stages.every(v=>v.sshAuthenticated));assert.ok(result.stages[2].stdinBytes>25000);
 await t.test('full v4 procedure uses harmless probes before collector and exports stage-specific sanitized JSON',()=>{
 const fake=path.join(root,'fake'),out=path.join(root,'out');fs.mkdirSync(fake);fs.mkdirSync(out);
 const fp=cmd('ssh-keygen',['-l','-E','sha256','-f',client+'.pub']).toString().match(/SHA256:[A-Za-z0-9+/]+/)[0];
 const cli=path.join(fake,'railway');fs.writeFileSync(cli,'#!/bin/sh\ncase "$1" in\n--version) echo "railway 5.75.0";;\nwhoami) echo "{}";;\nssh) if [ "$2" = "keys" ]; then echo "Registered SSH Keys:"; echo " Fingerprint: '+fp+'"; else echo "Host synthetic"; echo " HostName ssh.railway.com"; echo " User 00000000-0000-4000-8000-000000000001"; fi;;\nesac\n');fs.chmodSync(cli,0o700);
 const nativeCli=path.join(fake,'native-cli');fs.renameSync(cli,nativeCli);fs.writeFileSync(cli,'#!'+process.execPath+'\nconst {execFileSync}=require("node:child_process");try{execFileSync('+JSON.stringify(nativeCli)+',process.argv.slice(2),{stdio:"inherit"})}catch(e){process.exit(e.status||2)}\n');fs.chmodSync(cli,0o700);
 const shim=path.join(fake,'ssh');
 // Local fixture redirects only the final relay destination and authenticated username.
 const shimCode='#!/usr/bin/python3\nimport os,sys\na=sys.argv[1:]\nif a==["-V"]:os.execv("/usr/bin/ssh",["ssh","-V"])\ni=a.index("-l");a[i+1]='+JSON.stringify(username)+'\ni=a.index("ssh.railway.com");a[i]="127.0.0.1"\ni=a.index("node");a[i]='+JSON.stringify(process.execPath)+'\nopts='+JSON.stringify(base.slice(0,-3))+'\nos.execv("/usr/bin/ssh",["ssh"]+opts+a)\n';
 fs.writeFileSync(shim,shimCode);fs.chmodSync(shim,0o700);
 const child=spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',path.resolve(__dirname,'../docs/questionnaire/owner/AEGIS-Production-Readonly-v4.ps1'),'-OutputDirectory',out],{encoding:'utf8',timeout:20000,env:{...process.env,PATH:fake+path.delimiter+process.env.PATH}});
 assert.equal(child.status,2,child.stderr+' '+child.stdout);assert.equal(child.stderr,'');
 const files=fs.readdirSync(out),reportName=files.find(x=>x.startsWith('AEGIS-Transport-Diagnostics'));
 assert.ok(reportName,child.stdout);const report=JSON.parse(fs.readFileSync(path.join(out,reportName),'utf8'));
 assert.ok(report.stages.find(x=>x.stage==='REMOTE_STDIN_COLLECTOR_SIZE'&&x.classification==='PASS_EXPECTED_REMOTE_SENTINEL'),JSON.stringify(report));
 assert.equal(report.syntheticPayloadBytes,report.collectorTransportBytes);assert.equal(report.collectorBudgetMs,300000);assert.equal(report.totalBudgetMs,600000);
 assert.ok(report.stages.some(x=>x.stage==='READ_ONLY_COLLECTOR'));assert.ok(files.some(x=>x.startsWith('AEGIS-Production-Readonly-')));
 assert.ok(!JSON.stringify(report).includes(fp));assert.ok(!JSON.stringify(report).includes(client));
 });
 await t.test('unknown host trust is rejected and classified without autoaccept or raw diagnostics',()=>{
 const noTrust=base.map(x=>x==='UserKnownHostsFile='+known?'UserKnownHostsFile=/dev/null':x);
 const value=JSON.parse(ps(`$r=Invoke-AegisTransport '/usr/bin/ssh' @(${noTrust.map(q).join(',')},'true') '' 5000 'HOST_TRUST';$AegisReport|ConvertTo-Json -Depth 5 -Compress`,root));assert.equal(value.stages[0].classification,'SSH_HOST_TRUST_REQUIRED');assert.notEqual(value.stages[0].exitCode,0);
 });
 await t.test('wrong authentication key is rejected and classified',()=>{
 const badKey=base.map(x=>x===client?wrong:x);
 const value=JSON.parse(ps(`$r=Invoke-AegisTransport '/usr/bin/ssh' @(${badKey.map(q).join(',')},'true') '' 5000 'AUTH_KEY';$AegisReport|ConvertTo-Json -Depth 5 -Compress`,root));assert.equal(value.stages[0].classification,'SSH_KEY_AUTHENTICATION_DENIED');assert.notEqual(value.stages[0].exitCode,0);
 });
});
test('v4 retains partial sanitized classifications on stalled reader; timeout is bounded with no WriteLineAsync dependency',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-v4-stall-'));try{
 const result=JSON.parse(ps(`$r=Invoke-AegisTransport '/bin/sh' @('-c','echo "Host key verification failed. SYNTHETIC_SECRET" >&2; exec sleep 20') ('x'*100000) 200 'STALLED_READER';$AegisReport|ConvertTo-Json -Depth 5 -Compress`,root));assert.equal(result.stages[0].classification,'SSH_HOST_TRUST_REQUIRED');assert.equal(result.stages[0].timedOut,true);assert.ok(result.stages[0].elapsedMs<4000);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
 assert.ok(!template.includes('WriteLineAsync'));assert.ok(!template.includes('StrictHostKeyChecking=no'));assert.ok(template.includes('StrictHostKeyChecking=yes'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('v4 timeout policy and .NET Framework-compatible generated source parse',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-v4-parse-'));try{
 const script=path.resolve(__dirname,'../docs/questionnaire/owner/AEGIS-Production-Readonly-v4.ps1');ps(`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(script)},[ref]$tokens,[ref]$errors);if($errors.Count){$errors|Out-String|Write-Host;throw 'PARSE_FAILED'};if($ast.FindAll({param($n)$n.GetType().Name -in @('TernaryExpressionAst','PipelineChainAst')},$true).Count){throw 'PS7_SYNTAX'}`,root);
 assert.match(template,/totalBudgetMs=600000;collectorBudgetMs=300000/);assert.match(template,/\$Bootstrap 330000/);assert.match(fs.readFileSync(path.resolve(__dirname,'../docs/questionnaire/production-readonly-collector.cjs'),'utf8'),/Math.min\(300000/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('v4 global budget stops before process start, and Windows quoting rejects expansion paths',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-v4-budget-'));try{
 ps(String.raw`$AegisOverall=[pscustomobject]@{ElapsedMilliseconds=600000};$ok=$false;try{Invoke-AegisTransport '/does/not/exist' @() '' 330000 'BUDGET'}catch{$ok=$_.Exception.Message -eq 'AEGIS_SAFE:TOTAL_BUDGET_EXHAUSTED'};if(-not $ok){throw 'BUDGET_NOT_ENFORCED'};foreach($p in @('C:\unsafe%HOME%\x','C:\unsafe!x\x')){$ok=$false;try{Get-AegisQuotedWord $p $true}catch{$ok=$_.Exception.Message -eq 'AEGIS_SAFE:UNSAFE_WINDOWS_COMMAND_WORD'};if(-not $ok){throw 'UNSAFE_WORD_ACCEPTED'}}`,root);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
