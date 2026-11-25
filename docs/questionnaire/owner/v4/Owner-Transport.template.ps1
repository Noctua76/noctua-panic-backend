#requires -Version 5.1
param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$AegisOverall=[Diagnostics.Stopwatch]::StartNew()
$AegisPayloadBase64 = '__PAYLOAD_BASE64__'
$AegisExpectedPayloadSha256 = '__PAYLOAD_SHA256__'
function Resolve-AegisLauncher {
    param([bool]$WindowsMode = ($env:OS -eq 'Windows_NT'))
    # Never pass ExternalScript (.ps1), alias or function to CreateProcess.
    $Names = @('railway')
    if ($WindowsMode) { $Names = @('railway.cmd', 'railway.exe', 'railway') }
    foreach ($Name in $Names) {
        $Candidates = @(Get-Command -Name $Name -CommandType Application -All -ErrorAction SilentlyContinue)
        foreach ($Candidate in $Candidates) {
            $Path = $Candidate.Path
            if (-not $Path -or -not [IO.File]::Exists($Path)) { continue }
            $Extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
            if ($Extension -eq '.ps1') { continue }
            if ($WindowsMode -and $Extension -eq '.cmd') {
                # cmd performs percent expansion even inside quotes; reject ambiguous paths.
                if ($Path -match '[%!"\r\n]') { throw 'AEGIS_SAFE:UNSUPPORTED_CMD_PATH' }
                return [pscustomobject]@{ Path = $Path; Kind = 'NPM_CMD'; Windows = $true }
            }
            if ($WindowsMode) {
                if ($Extension -and $Extension -ne '.exe') { continue }
                $Stream = [IO.File]::OpenRead($Path)
                try { $IsPe = ($Stream.ReadByte() -eq 77 -and $Stream.ReadByte() -eq 90) }
                finally { $Stream.Dispose() }
                if (-not $IsPe) { continue }
            }
            return [pscustomobject]@{ Path = $Path; Kind = 'NATIVE'; Windows = $WindowsMode }
        }
    }
    throw 'AEGIS_SAFE:RAILWAY_LAUNCHER_UNAVAILABLE'
}
# C# capture avoids ReadToEnd hiding the SSH error until EOF or a blocked stdin write ends.
if (-not ('AegisCaptureV4' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
public class AegisCaptureV4 {
 readonly object gate = new object();
 readonly StringBuilder output = new StringBuilder(), error = new StringBuilder();
 public Task OutTask, ErrTask;
 public bool Limited, ReadFailed;
 public void Start(Process p) { OutTask=Read(p.StandardOutput,output); ErrTask=Read(p.StandardError,error); }
 async Task Read(StreamReader r,StringBuilder b) {
  try { char[] a=new char[1024]; int n;
   while((n=await r.ReadAsync(a,0,a.Length).ConfigureAwait(false))>0) {
    lock(gate) { if(b.Length+n>8388608) {Limited=true;return;} b.Append(a,0,n); }
   }
  } catch {lock(gate) {ReadFailed=true;}}
 }
 public string Out() {lock(gate) {return output.ToString();}}
 public string Err() {lock(gate) {return error.ToString();}}
}
'@
}
function Get-AegisQuotedWord {
 param([string]$Value,[bool]$WindowsMode)
 if ($Value -match '[\r\n\x00]') {throw 'AEGIS_SAFE:UNSAFE_COMMAND_WORD'}
 if ($WindowsMode) {
  if ($Value -match '[%!"\r\n]') {throw 'AEGIS_SAFE:UNSAFE_WINDOWS_COMMAND_WORD'}
  return '"'+$Value+'"'
 }
 $q=[string][char]39; $replacement=$q+[char]34+$q+[char]34+$q
 return $q+$Value.Replace($q,$replacement)+$q
}
function Get-AegisFailureClass {
 param([string]$Out,[string]$Err,[bool]$TimedOut,[int]$ExitCode)
 $Text=$Err+"`n"+$Out
 if($Text -match '(?i)unrecognized subcommand|unexpected argument|Found argument .*wasn.t expected'){return 'CLI_CAPABILITY_UNAVAILABLE'}
 if($Text -match '(?i)Bad owner or permissions|Bad configuration option'){return 'SSH_LOCAL_CONFIGURATION_REJECTED'}
 if($Text -match '(?i)REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key'){return 'SSH_HOST_KEY_CHANGED'}
 if($Text -match '(?i)Host key verification failed|No .* host key is known|authenticity of host .* cannot be established'){return 'SSH_HOST_TRUST_REQUIRED'}
 if($Text -match '(?i)No registered SSH keys|No SSH keys found'){return 'SSH_REGISTERED_LOCAL_KEY_REQUIRED'}
 if($Text -match '(?i)Permission denied \(publickey|no supported authentication methods'){return 'SSH_KEY_AUTHENTICATION_DENIED'}
 if($Text -match '(?i)passphrase|sign_and_send_pubkey: signing failed|agent refused operation'){return 'SSH_KEY_UNLOCK_REQUIRED'}
 if($Text -match '(?i)Could not resolve hostname|Name or service not known'){return 'SSH_DNS_FAILED'}
 if($Text -match '(?i)Connection timed out|Connection refused|No route to host|Connection reset'){return 'SSH_CONNECT_FAILED'}
 if($Text -match '(?i)node: not found|node: command not found|exec.*node.*not found'){return 'REMOTE_NODE_UNAVAILABLE'}
 if($TimedOut){return 'TRANSPORT_DEADLINE_EXCEEDED'}
 if($ExitCode -ne 0){return 'PROCESS_EXIT_NONZERO'}
 return 'NO_CONFIRMED_REMOTE_SENTINEL'
}
function Stop-AegisOwnedProcess {
 param($Process)
 if($env:OS -eq 'Windows_NT') {
  $Kill=New-Object Diagnostics.Process
  try {
   $Kill.StartInfo.FileName=Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
   $Kill.StartInfo.Arguments='/PID '+$Process.Id+' /T /F'
   $Kill.StartInfo.UseShellExecute=$false;$Kill.StartInfo.CreateNoWindow=$true
   $Kill.StartInfo.RedirectStandardOutput=$true;$Kill.StartInfo.RedirectStandardError=$true
   $null=$Kill.Start();$null=$Kill.StandardOutput.ReadToEndAsync();$null=$Kill.StandardError.ReadToEndAsync()
   if(-not $Kill.WaitForExit(3000)){$Kill.Kill()}
  }catch{}finally{$Kill.Dispose()}
 }
 try{if(-not $Process.HasExited){$Process.Kill()}}catch{}
}
function Invoke-AegisTransport {
 param([string]$Executable,[string[]]$Words,[string]$InputText='',[int]$TimeoutMs=30000,[string]$Stage='LOCAL')
 $WindowsMode=$env:OS -eq 'Windows_NT'
 $Remaining=600000-[int]$AegisOverall.ElapsedMilliseconds-10000
 if($Remaining -le 0){throw 'AEGIS_SAFE:TOTAL_BUDGET_EXHAUSTED'}
 $Budget=[Math]::Min($TimeoutMs,$Remaining)
 # OS file-backed stdin gives EOF without waiting for a 25KB+ write into an unread pipe.
 # This local file contains only public collector code or synthetic data, never credentials.
 $InputFile=Join-Path $AegisTemp ([Guid]::NewGuid().ToString('N')+'.stdin')
 $Utf8=New-Object Text.UTF8Encoding($false)
 $Clock=[Diagnostics.Stopwatch]::StartNew()
 [IO.File]::WriteAllText($InputFile,$InputText,$Utf8)
 if($Clock.ElapsedMilliseconds -gt 15000){throw 'AEGIS_SAFE:LOCAL_STDIN_PREPARATION_DEADLINE'}
 $Parts=@((Get-AegisQuotedWord $Executable $WindowsMode))
 foreach($Word in $Words){$Parts+=Get-AegisQuotedWord $Word $WindowsMode}
 $Line=($Parts -join ' ')+' < '+(Get-AegisQuotedWord $InputFile $WindowsMode)
 $Info=New-Object Diagnostics.ProcessStartInfo
 $Info.UseShellExecute=$false;$Info.CreateNoWindow=$true
 $Info.RedirectStandardOutput=$true;$Info.RedirectStandardError=$true
 $Info.StandardOutputEncoding=$Utf8;$Info.StandardErrorEncoding=$Utf8
 if($WindowsMode){$Info.FileName=Join-Path ([Environment]::SystemDirectory) 'cmd.exe';$Info.Arguments='/d /v:off /s /c "'+$Line+'"'}
 else{$Info.FileName='/bin/sh';$Info.Arguments='-c '+[char]34+('exec '+$Line).Replace('\','\\').Replace([string][char]34,'\'+[char]34)+[char]34}
 $Process=New-Object Diagnostics.Process;$Process.StartInfo=$Info
 $Capture=New-Object AegisCaptureV4;$Started=$false;$TimedOut=$false;$ExitCode=-1
 try {
  try{$Started=$Process.Start()}catch{throw 'AEGIS_SAFE:PROCESS_START_FAILED'}
  if(-not $Started){throw 'AEGIS_SAFE:PROCESS_START_FAILED'}
  $Capture.Start($Process)
  while(-not $Process.WaitForExit(100)) {
   if($Capture.Limited){break}
   if($Clock.ElapsedMilliseconds -ge $Budget){$TimedOut=$true;break}
  }
  if($TimedOut -or $Capture.Limited){Stop-AegisOwnedProcess $Process}
  try{if($Process.HasExited){$ExitCode=$Process.ExitCode}}catch{}
  foreach($Task in @($Capture.OutTask,$Capture.ErrTask)) {
   $Wait=[Math]::Max(1,[Math]::Min(3000,$Budget-[int]$Clock.ElapsedMilliseconds))
   if(-not $Task.Wait($Wait)){$TimedOut=$true}
  }
  $Out=$Capture.Out();$Err=$Capture.Err()
  $Class=Get-AegisFailureClass $Out $Err $TimedOut $ExitCode
  $Entry=[ordered]@{stage=$Stage;elapsedMs=[int]$Clock.ElapsedMilliseconds;budgetMs=$Budget;stdinBytes=$Utf8.GetByteCount($InputText);stdinMode='OS_FILE_BACKED_EOF';stdoutChars=$Out.Length;stderrChars=$Err.Length;exitCode=$ExitCode;timedOut=$TimedOut;classification=$Class;sshAuthenticated=($Err -match '(?i)Authenticated to ');hostKeyMatched=($Err -match '(?i)known and matches|Found key in ')}
  $AegisReport.stages.Add([pscustomobject]$Entry)
  if($Capture.Limited){throw 'AEGIS_SAFE:CAPTURE_LIMIT_EXCEEDED'}
  if($Capture.ReadFailed){throw 'AEGIS_SAFE:CAPTURE_READ_FAILED'}
  return [pscustomobject]@{Out=$Out;Err=$Err;Code=$ExitCode;TimedOut=$TimedOut;Class=$Class}
 }finally{
  if($Started){try{if(-not $Process.HasExited){Stop-AegisOwnedProcess $Process}}catch{}}
  $Process.Dispose();$Clock.Stop();[IO.File]::Delete($InputFile)
 }
}
function Assert-AegisResult {
 param($Result,[string]$Expected)
 if($Result.TimedOut -or $Result.Code -ne 0){throw ('AEGIS_SAFE:'+$Result.Class)}
 if($Expected -and $Result.Out.Trim() -ne $Expected){throw 'AEGIS_SAFE:REMOTE_SENTINEL_MISSING_OR_CHANGED'}
 $Last=$AegisReport.stages[$AegisReport.stages.Count-1]
 $Last.classification='PASS_PROCESS_EXIT_ONLY'
 if($Expected){$Last.classification='PASS_EXPECTED_REMOTE_SENTINEL'}
}
function Write-AegisJsonFile {
 param([string]$Name,$Value)
 $Path=Join-Path $OutputDirectory ($Name+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json')
 $Utf8=New-Object Text.UTF8Encoding($false);$Bytes=$Utf8.GetBytes(($Value|ConvertTo-Json -Depth 40))
 $File=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$File.Write($Bytes,0,$Bytes.Length);$File.Flush()}finally{$File.Dispose()}
 return $Path
}

# MAIN: every network step is read-only; no SSH keys/config/trust are created or changed.
$AegisReport=[ordered]@{procedureVersion=4;mode='READ_ONLY_DIAGNOSTIC_AND_COLLECTION';totalBudgetMs=600000;collectorBudgetMs=300000;stdinPreparationBudgetMs=15000;productionMutations=$false;stages=(New-Object 'System.Collections.Generic.List[object]');status='INCOMPLETE_BLOCKED';failureStage='LOCAL_PREFLIGHT';failureCode=$null}
$AegisTemp=$null;$AegisExit=2
try {
 if(-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)){throw 'AEGIS_SAFE:OUTPUT_DIRECTORY_UNAVAILABLE'}
 $ProbePath=Join-Path $OutputDirectory ('Aegis-write-probe-'+[Guid]::NewGuid().ToString('N')+'.tmp')
 $Probe=[IO.File]::Open($ProbePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$Probe.Flush()}finally{$Probe.Dispose();[IO.File]::Delete($ProbePath)}
 $AegisTemp=Join-Path ([IO.Path]::GetTempPath()) ('Aegis-Readonly-'+[Guid]::NewGuid().ToString('N'))
 $null=[IO.Directory]::CreateDirectory($AegisTemp)
 $AegisBytes=[Convert]::FromBase64String($AegisPayloadBase64)
 $Hash=[Security.Cryptography.SHA256]::Create()
 try{$Actual=([BitConverter]::ToString($Hash.ComputeHash($AegisBytes))).Replace('-','').ToLowerInvariant()}finally{$Hash.Dispose()}
 if($Actual -ne $AegisExpectedPayloadSha256){throw 'AEGIS_SAFE:COLLECTOR_PAYLOAD_HASH_MISMATCH'}
 $AegisReport.collectorSha256=$Actual
 $Launcher=Resolve-AegisLauncher
 $AegisReport.launcherKind=$Launcher.Kind
 $Stage='CLI_VERSION';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('--version') '' 15000 $Stage
 Assert-AegisResult $Result ''
 if($Result.Out -notmatch '(?im)^railway\s+v?([0-9]+\.[0-9]+\.[0-9]+)'){throw 'AEGIS_SAFE:CLI_VERSION_INVALID'}
 $AegisReport.railwayVersion=$Matches[1]
 $Stage='CLI_AUTH';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('whoami','--json') '' 30000 $Stage
 Assert-AegisResult $Result '';$null=$Result.Out|ConvertFrom-Json
 $Stage='REGISTERED_KEY_INVENTORY';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('ssh','keys','list') '' 45000 $Stage
 Assert-AegisResult $Result ''
 $RegisteredSection=''
 if($Result.Out -match '(?ms)^Registered (?:Workspace )?SSH Keys:\r?\n(.*?)(?=^[^\s]|\z)'){$RegisteredSection=$Matches[1]}
 $Registered=@([regex]::Matches($RegisteredSection,'(?m)^\s*Fingerprint:\s+(SHA256:[A-Za-z0-9+/]{20,64})')|ForEach-Object {$_.Groups[1].Value})
 $AegisReport.registeredFingerprintCount=@($Registered).Count
 if(@($Registered).Count -eq 0){throw 'AEGIS_SAFE:SSH_REGISTERED_KEY_REQUIRED'}
 $AegisReport.failureStage='OPENSSH_LOCAL_PREFLIGHT'
 $SshCandidates=@(Get-Command -Name ssh -CommandType Application -All -ErrorAction SilentlyContinue|Where-Object {$_.Path -notmatch '\.(ps1|cmd|bat)$'})
 $KeyCandidates=@(Get-Command -Name ssh-keygen -CommandType Application -All -ErrorAction SilentlyContinue|Where-Object {$_.Path -notmatch '\.(ps1|cmd|bat)$'})
 if($SshCandidates.Count -eq 0 -or $KeyCandidates.Count -eq 0){throw 'AEGIS_SAFE:OPENSSH_TOOLS_UNAVAILABLE'}
 $Ssh=$SshCandidates[0];$Keygen=$KeyCandidates[0]
 $Result=Invoke-AegisTransport $Ssh.Path @('-V') '' 15000 'OPENSSH_LOCAL_VERSION'
 Assert-AegisResult $Result ''
 if($Result.Err -match '(OpenSSH[^,\s]+)'){$AegisReport.openSshVersion=$Matches[1]}
 $AegisIdentity=$null
 $PubDirectory=Join-Path $HOME '.ssh'
 foreach($Pub in @(Get-ChildItem -LiteralPath $PubDirectory -Filter '*.pub' -File -ErrorAction SilentlyContinue)) {
  $Private=$Pub.FullName.Substring(0,$Pub.FullName.Length-4)
  if(-not [IO.File]::Exists($Private)){continue}
  $Result=Invoke-AegisTransport $Keygen.Path @('-l','-E','sha256','-f',$Pub.FullName) '' 10000 'LOCAL_PUBLIC_KEY_MATCH'
  if($Result.Code -eq 0 -and $Result.Out -match 'SHA256:[A-Za-z0-9+/]{20,64}' -and $Registered -contains $Matches[0]){$AegisIdentity=$Private;break}
 }
 # Agent-only registered keys may still authenticate; no private key is read or exported here.
 $AegisReport.localRegisteredFileMatch=($null -ne $AegisIdentity)
 $Stage='TARGET_RESOLUTION_DRY_RUN';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('ssh','config','--dry-run','--project','0233d8e5-8437-4d94-ad0c-3f24deb1902e','--environment','aa887588-a793-47b7-b789-df297f78ef8d','--service','75a4edb0-86fb-4fb6-b7d7-3f88880503ec') '' 45000 $Stage
 Assert-AegisResult $Result ''
 if($Result.Out -notmatch '(?im)^\s*HostName\s+ssh\.railway\.com\s*$'){throw 'AEGIS_SAFE:UNEXPECTED_SSH_RELAY'}
 if($Result.Out -notmatch '(?im)^\s*User\s+([0-9a-fA-F-]{36})\s*$'){throw 'AEGIS_SAFE:TARGET_RESOLUTION_INVALID'}
 $Target=$Matches[1]
 $Port='22';if($Result.Out -match '(?im)^\s*Port\s+(\d+)\s*$'){$Port=$Matches[1]}
 if($Port -ne '22'){throw 'AEGIS_SAFE:UNEXPECTED_SSH_RELAY_PORT'}
 $SshWords=@('-T','-v','-o','BatchMode=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ControlMaster=no','-o','ControlPath=none','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15','-o','ConnectionAttempts=1','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2')
 if($AegisIdentity){$SshWords+=@('-i',$AegisIdentity,'-o','IdentitiesOnly=yes')}
 $SshWords+=@('-l',$Target,'ssh.railway.com')
 $Nonce='730000000'+(Get-Random -Minimum 100000 -Maximum 999999).ToString()
 $Stage='SSH_HOST_AUTH_REMOTE_NODE';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings','-p',$Nonce)) '' 45000 $Stage
 Assert-AegisResult $Result $Nonce
 $AegisReport.strictNoninteractiveSsh='PASS_REMOTE_NODE_NONCE'
 $Small='console.log("AEGIS_SMALL_'+$Nonce+'");'
 $Stage='REMOTE_STDIN_SMALL';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings')) $Small 45000 $Stage
 Assert-AegisResult $Result ('AEGIS_SMALL_'+$Nonce)
 $Bootstrap='const b=Buffer.from("'+$AegisPayloadBase64+'","base64");if(require("crypto").createHash("sha256").update(b).digest("hex")!=="'+$Actual+'")process.exit(2);const m={exports:{}};new Function("require","module","exports",b.toString("utf8"))(require,m,m.exports);m.exports.runCli({deadlineMs:300000});'
 $Large='console.log("AEGIS_LARGE_'+$Nonce+'");/*'
 $Large=$Large+('x'*($Bootstrap.Length-$Large.Length-2))+'*/'
 $AegisReport.syntheticPayloadBytes=$Large.Length
 $AegisReport.collectorTransportBytes=$Bootstrap.Length
 $Stage='REMOTE_STDIN_COLLECTOR_SIZE';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings')) $Large 75000 $Stage
 Assert-AegisResult $Result ('AEGIS_LARGE_'+$Nonce)
 # Only after all harmless probes pass may the real read-only collector run.
 if(600000-$AegisOverall.ElapsedMilliseconds -lt 340000){throw 'AEGIS_SAFE:INSUFFICIENT_REMAINING_COLLECTOR_BUDGET'}
 $Stage='READ_ONLY_COLLECTOR';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings')) $Bootstrap 330000 $Stage
 $Start='AEGIS_READONLY_EVIDENCE_BEGIN';$End='AEGIS_READONLY_EVIDENCE_END'
 if(([regex]::Matches($Result.Out,$Start)).Count -ne 1 -or ([regex]::Matches($Result.Out,$End)).Count -ne 1){throw ('AEGIS_SAFE:'+$Result.Class)}
 $a=$Result.Out.IndexOf($Start)+$Start.Length;$b=$Result.Out.IndexOf($End)
 if($b -le $a){throw 'AEGIS_SAFE:COLLECTOR_MARKERS_INVALID'}
 $Evidence=$Result.Out.Substring($a,$b-$a).Trim()|ConvertFrom-Json
 if($Evidence.collectorVersion -ne 2 -or $Evidence.productionMutations -ne $false -or @('EVIDENCE_COLLECTED_REQUIRES_REVIEW','INCOMPLETE_BLOCKED') -notcontains $Evidence.status){throw 'AEGIS_SAFE:COLLECTOR_RECORD_INVALID'}
 $EvidencePath=Write-AegisJsonFile 'AEGIS-Production-Readonly' $Evidence
 Write-Host ('Evidence saved: '+$EvidencePath)
 $AegisReport.status=$Evidence.status
 if($Result.Code -eq 0 -and -not $Result.TimedOut -and $Evidence.status -eq 'EVIDENCE_COLLECTED_REQUIRES_REVIEW'){$AegisExit=0;$AegisReport.failureStage=$null}
 else{$AegisReport.failureCode='COLLECTOR_INCOMPLETE_OR_NONZERO'}
}catch{
 $Code='UNEXPECTED_STAGE_FAILURE'
 if($_.Exception.Message -match '^AEGIS_SAFE:([A-Z_]+)$'){$Code=$Matches[1]}
 $AegisReport.failureCode=$Code
 Write-Host ('AEGIS_STOP: '+$AegisReport.failureStage+' / '+$Code)
}finally{
 if($AegisTemp){try{[IO.Directory]::Delete($AegisTemp,$true)}catch{}}
 $AegisReport.elapsedMs=[int]$AegisOverall.ElapsedMilliseconds
 try{$ReportPath=Write-AegisJsonFile 'AEGIS-Transport-Diagnostics-v4' $AegisReport;Write-Host ('Sanitized diagnostics saved: '+$ReportPath)}catch{Write-Host 'AEGIS_STOP: DIAGNOSTIC_EXPORT_FAILED'}
 $AegisOverall.Stop()
}
Write-Host 'Return only generated sanitized JSON files. No raw SSH output, keys, credentials or operational rows.'
exit $AegisExit
