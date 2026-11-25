'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const pwsh=process.env.AEGIS_PWSH_PATH||'pwsh',root=path.resolve(__dirname,'../docs/questionnaire/owner'),template=fs.readFileSync(path.join(root,'Owner-Collector.template.ps1'),'utf8');
const functions=template.slice(template.indexOf('function Resolve-AegisLauncher'),template.indexOf("$AegisStage = 'LOCAL_PREFLIGHT_FAILED'"));
function run(body,options={}){const p=spawnSync(pwsh,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';\n"+functions+'\n'+body],{encoding:'utf8',timeout:10000,...options});assert.equal(p.status,0,JSON.stringify({status:p.status,signal:p.signal,errorCode:p.error?.code,stderr:p.stderr,stdout:p.stdout}));return p.stdout;}
test('Windows npm resolution selects Application railway.cmd before PowerShell shim; quoted paths remain one cmd command',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aegis launcher & '));try{const cmd=path.join(temp,'railway.cmd');fs.writeFileSync(cmd,'@echo off\r\n');const native=path.join(temp,'railway.exe');fs.writeFileSync(native,'MZsynthetic');
 const result=run(`$script:Called=@();function Get-Command {param($Name,$CommandType,[switch]$All,$ErrorAction) $script:Called+=$Name;if($CommandType -ne 'Application'){throw 'WRONG_TYPE'};if($Name -eq 'railway.cmd'){[pscustomobject]@{Path=${JSON.stringify(cmd)}}} };$l=Resolve-AegisLauncher -WindowsMode $true;if($l.Kind -ne 'NPM_CMD' -or $script:Called.Count -ne 1){throw 'WRONG_LAUNCHER'};Get-AegisCmdArguments -Path $l.Path -Arguments 'whoami --json'`);
 assert.equal(result.trim(),'/d /v:off /s /c ""'+cmd+'" whoami --json"');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('Windows fallback verifies native MZ and refuses ps1 or extensionless npm shell shim',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-launcher-'));try{const exe=path.join(temp,'railway.exe'),shim=path.join(temp,'railway'),ps=path.join(temp,'railway.ps1');fs.writeFileSync(exe,'MZsynthetic');fs.writeFileSync(shim,'#!/bin/sh');fs.writeFileSync(ps,'Write-Host synthetic');
 run(`function Get-Command {param($Name,$CommandType,[switch]$All,$ErrorAction) if($Name -eq 'railway.exe'){[pscustomobject]@{Path=${JSON.stringify(exe)}}} };$l=Resolve-AegisLauncher -WindowsMode $true;if($l.Kind -ne 'NATIVE'){throw 'NATIVE_REJECTED'};function Get-Command {param($Name,$CommandType,[switch]$All,$ErrorAction) if($Name -eq 'railway'){[pscustomobject]@{Path=${JSON.stringify(shim)}};[pscustomobject]@{Path=${JSON.stringify(ps)}}} };$ok=$false;try{Resolve-AegisLauncher -WindowsMode $true}catch{$ok=$_.Exception.Message -eq 'AEGIS_SAFE:RAILWAY_LAUNCHER_UNAVAILABLE'};if(-not $ok){throw 'UNSAFE_SHIM_ACCEPTED'}`);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('Windows cmd expansion paths and non-allowlisted commands fail before Start',()=>{
 run(`foreach($p in @('C:\\unsafe%NAME%\\railway.cmd','C:\\unsafe!name\\railway.cmd',('C:\\bad'+[char]34+'\\railway.cmd'))){$ok=$false;try{Get-AegisCmdArguments -Path $p -Arguments 'whoami --json'}catch{$ok=$_.Exception.Message -eq 'AEGIS_SAFE:UNSUPPORTED_CMD_PATH'};if(-not $ok){throw 'UNSAFE_PATH'}};$ok=$false;try{New-AegisStartInfo -Launcher ([pscustomobject]@{Path='/synthetic';Kind='NATIVE'}) -Arguments 'up --detach'}catch{$ok=$_.Exception.Message -eq 'AEGIS_SAFE:COMMAND_NOT_ALLOWED'};if(-not $ok){throw 'MUTATING_COMMAND_ACCEPTED'}`);
});
test('blocked stdin and nonterminating process share a bounded deadline and terminate without raw diagnostics',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-launcher-'));try{const bin=path.join(temp,'railway');fs.writeFileSync(bin,'#!/bin/sh\nexec sleep 20\n');fs.chmodSync(bin,0o700);
 const output=run(`$AegisRailway=[pscustomobject]@{Path=${JSON.stringify(bin)};Kind='NATIVE';Windows=$false};foreach($inputText in @('',('x'*1000000))){$clock=[Diagnostics.Stopwatch]::StartNew();$ok=$false;try{Invoke-AegisRailway -Arguments 'whoami --json' -InputText $inputText -TimeoutMs 150}catch{$ok=$_.Exception.Message -match '^AEGIS_SAFE:RAILWAY_(PROCESS|STDIN)_DEADLINE_EXCEEDED$'};if(-not $ok -or $clock.ElapsedMilliseconds -gt 3000){throw 'DEADLINE_FAILED'}};'BOUNDED_CLEANUP_PASS'`);assert.match(output,/BOUNDED_CLEANUP_PASS/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('generated v3 parses cleanly and avoids PowerShell 7-only syntax and .NET Core-only process APIs',()=>{
 const file=path.join(root,'AEGIS-Production-Readonly-v3.ps1');run(`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(file)},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'PARSE_FAILED'};if($ast.FindAll({param($n) $n.GetType().Name -in @('TernaryExpressionAst','PipelineChainAst')},$true).Count){throw 'PS7_SYNTAX'};'PARSE_PASS'`);
 const body=fs.readFileSync(file,'utf8');assert.ok(body.startsWith('#requires -Version 5.1'));assert.ok(!body.includes('.Kill($true)'));assert.ok(!body.includes('.ArgumentList'));assert.ok(!body.includes('??'));assert.ok(!body.includes('&&'));assert.ok(!body.includes('$env:COMSPEC'));
});
test('authentication, SSH diagnostics, malformed/duplicate JSON and incomplete evidence fail safely with atomic unique exports',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-v3-boundary-'));try{
 const bin=path.join(temp,'railway'),out=path.join(temp,'out');fs.mkdirSync(out);
 const record=JSON.stringify({collectorVersion:2,productionMutations:false,status:'INCOMPLETE_BLOCKED',errors:{collector:'SYNTHETIC_INCOMPLETE'}});
 for(const mode of ['auth','malformed','duplicate','incomplete']){
  const marked='AEGIS_READONLY_EVIDENCE_BEGIN\n'+(mode==='malformed'?'not-json':record)+'\nAEGIS_READONLY_EVIDENCE_END\n';
  const output=mode==='duplicate'?marked+marked:marked;
  const body='#!/bin/sh\nif [ "$1" = "--version" ]; then echo "railway 4.0.0"; exit 0; fi\nif [ "$1" = "whoami" ]; then '+(mode==='auth'?'echo SYNTHETIC_AUTH_SECRET >&2; exit 1':'echo "{}"; exit 0')+'; fi\ncat >/dev/null\necho SYNTHETIC_TRANSPORT_SECRET >&2\ncat <<\'AEGIS_FIXED_EOF\'\n'+output+'AEGIS_FIXED_EOF\nexit 2\n';fs.writeFileSync(bin,body);fs.chmodSync(bin,0o700);
  const child=spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',path.join(root,'AEGIS-Production-Readonly-v3.ps1'),'-OutputDirectory',out],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:temp+path.delimiter+process.env.PATH}});
  assert.equal(child.status,2,child.stderr);assert.equal(child.stderr,'');assert.ok(!child.stdout.includes('SYNTHETIC_AUTH_SECRET'));assert.ok(!child.stdout.includes('SYNTHETIC_TRANSPORT_SECRET'));
  if(mode==='auth')assert.match(child.stdout,/RAILWAY_AUTHENTICATION_REQUIRED/);
  if(mode==='malformed')assert.match(child.stdout,/COLLECTOR_JSON_INVALID/);
  if(mode==='duplicate')assert.match(child.stdout,/NO_UNIQUE_COMPLETE_COLLECTOR_RECORD/);
  if(mode!=='incomplete')assert.equal(fs.readdirSync(out).length,0);
 }
 const files=fs.readdirSync(out);assert.equal(files.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out,files[0]),'utf8')),JSON.parse(record));
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
