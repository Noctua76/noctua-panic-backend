#requires -Version 5.1
param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
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
function Get-AegisCmdArguments {
    param([string]$Path, [string]$Arguments)
    if ($Path -match '[%!"\r\n]') { throw 'AEGIS_SAFE:UNSUPPORTED_CMD_PATH' }
    return '/d /v:off /s /c ""' + $Path + '" ' + $Arguments + '"'
}
function New-AegisStartInfo {
    param($Launcher, [string]$Arguments)
    $Ssh = 'ssh --project 0233d8e5-8437-4d94-ad0c-3f24deb1902e --environment aa887588-a793-47b7-b789-df297f78ef8d --service 75a4edb0-86fb-4fb6-b7d7-3f88880503ec -- node --no-warnings'
    if ($Arguments -ne '--version' -and $Arguments -ne 'whoami --json' -and $Arguments -ne $Ssh) { throw 'AEGIS_SAFE:COMMAND_NOT_ALLOWED' }
    $Info = New-Object Diagnostics.ProcessStartInfo
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    $Info.RedirectStandardInput = $true
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $Info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    if ($Launcher.Kind -eq 'NPM_CMD') {
        if ($Launcher.Path -match '[%!"\r\n]') { throw 'AEGIS_SAFE:UNSUPPORTED_CMD_PATH' }
        # /d disables AutoRun; /v:off disables delayed expansion; /s handles outer quotes.
        $Info.FileName = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
        $Info.Arguments = Get-AegisCmdArguments -Path $Launcher.Path -Arguments $Arguments
    } else {
        $Info.FileName = $Launcher.Path
        $Info.Arguments = $Arguments
    }
    return $Info
}
function Stop-AegisProcess {
    param($Process, [bool]$WindowsMode)
    if ($WindowsMode) {
        $Kill = New-Object Diagnostics.Process
        try {
            $Kill.StartInfo.FileName = Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
            $Kill.StartInfo.Arguments = '/PID ' + $Process.Id + ' /T /F'
            $Kill.StartInfo.UseShellExecute = $false
            $Kill.StartInfo.CreateNoWindow = $true
            $Kill.StartInfo.RedirectStandardOutput = $true
            $Kill.StartInfo.RedirectStandardError = $true
            $null = $Kill.Start()
            $null = $Kill.StandardOutput.ReadToEndAsync()
            $null = $Kill.StandardError.ReadToEndAsync()
            if (-not $Kill.WaitForExit(5000)) { $Kill.Kill() }
        } catch {} finally { $Kill.Dispose() }
    }
    try { if (-not $Process.HasExited) { $Process.Kill() } } catch {}
}
function Invoke-AegisRailway {
    param([string]$Arguments, [string]$InputText = '', [int]$TimeoutMs = 15000)
    $Process = New-Object Diagnostics.Process
    $Process.StartInfo = New-AegisStartInfo -Launcher $AegisRailway -Arguments $Arguments
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    $Started = $false
    $Complete = $false
    try {
        try { $Started = $Process.Start() } catch { throw 'AEGIS_SAFE:RAILWAY_PROCESS_START_FAILED' }
        if (-not $Started) { throw 'AEGIS_SAFE:RAILWAY_PROCESS_START_FAILED' }
        $OutTask = $Process.StandardOutput.ReadToEndAsync()
        $ErrTask = $Process.StandardError.ReadToEndAsync()
        if ($InputText) {
            # A blocked pipe is included in the same deadline as process/stream completion.
            $WriteTask = $Process.StandardInput.WriteLineAsync($InputText)
            if (-not $WriteTask.Wait([Math]::Max(1, $TimeoutMs - [int]$Clock.ElapsedMilliseconds))) { throw 'AEGIS_SAFE:RAILWAY_STDIN_DEADLINE_EXCEEDED' }
        }
        $Process.StandardInput.Close()
        if (-not $Process.WaitForExit([Math]::Max(1, $TimeoutMs - [int]$Clock.ElapsedMilliseconds))) { throw 'AEGIS_SAFE:RAILWAY_PROCESS_DEADLINE_EXCEEDED' }
        foreach ($Task in @($OutTask, $ErrTask)) {
            if (-not $Task.Wait([Math]::Max(1, $TimeoutMs - [int]$Clock.ElapsedMilliseconds))) { throw 'AEGIS_SAFE:RAILWAY_STREAM_DEADLINE_EXCEEDED' }
        }
        $Output = $OutTask.GetAwaiter().GetResult()
        $null = $ErrTask.GetAwaiter().GetResult()
        if ($Output.Length -gt 8388608) { throw 'AEGIS_SAFE:RAILWAY_OUTPUT_LIMIT_EXCEEDED' }
        $Complete = $true
        return [pscustomobject]@{ Code = $Process.ExitCode; Out = $Output }
    } finally {
        if ($Started -and -not $Complete) { Stop-AegisProcess -Process $Process -WindowsMode $AegisRailway.Windows }
        $Clock.Stop()
        $Process.Dispose()
    }
}

$AegisStage = 'LOCAL_PREFLIGHT_FAILED'
try {
    # Reject a missing destination before authentication or remote work.
    if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw 'AEGIS_SAFE:OUTPUT_DIRECTORY_UNAVAILABLE' }
    $AegisProbePath = Join-Path $OutputDirectory ('Aegis-write-probe-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $AegisProbe = [IO.File]::Open($AegisProbePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $AegisProbe.Flush() } finally { $AegisProbe.Dispose(); [IO.File]::Delete($AegisProbePath) }
    $AegisBytes = [Convert]::FromBase64String($AegisPayloadBase64)
    $AegisSha = [Security.Cryptography.SHA256]::Create()
    try { $AegisActualHash = ([BitConverter]::ToString($AegisSha.ComputeHash($AegisBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $AegisSha.Dispose() }
    if ($AegisActualHash -ne $AegisExpectedPayloadSha256) { throw 'AEGIS_SAFE:COLLECTOR_PAYLOAD_HASH_MISMATCH' }
    $AegisRailway = Resolve-AegisLauncher
    $AegisStage = 'LAUNCHER_PREFLIGHT_FAILED'
    $AegisVersion = Invoke-AegisRailway -Arguments '--version'
    if ($AegisVersion.Code -ne 0 -or $AegisVersion.Out -notmatch '(?im)^railway\s+v?[0-9]+\.[0-9]+\.[0-9]+') { throw 'AEGIS_SAFE:RAILWAY_VERSION_PREFLIGHT_FAILED' }
    Write-Host ('Verified launcher kind: ' + $AegisRailway.Kind)
    $AegisStage = 'AUTHENTICATION_FAILED'
    $AegisAuth = Invoke-AegisRailway -Arguments 'whoami --json'
    if ($AegisAuth.Code -ne 0) { throw 'AEGIS_SAFE:RAILWAY_AUTHENTICATION_REQUIRED' }
    $null = $AegisAuth.Out | ConvertFrom-Json
    $AegisBootstrap = 'const b=Buffer.from("' + $AegisPayloadBase64 + '","base64");if(require("crypto").createHash("sha256").update(b).digest("hex")!=="' + $AegisExpectedPayloadSha256 + '")process.exit(2);const m={exports:{}};new Function("require","module","exports",b.toString("utf8"))(require,m,m.exports);m.exports.runCli();'
    Write-Host ('Collector SHA-256 verified: ' + $AegisActualHash)
    Write-Host 'Running read-only collection in the existing BACKEND shell (60-second collector / 90-second transport limit).'
    $AegisStage = 'SSH_COLLECTION_FAILED'
    $AegisRemote = Invoke-AegisRailway -Arguments 'ssh --project 0233d8e5-8437-4d94-ad0c-3f24deb1902e --environment aa887588-a793-47b7-b789-df297f78ef8d --service 75a4edb0-86fb-4fb6-b7d7-3f88880503ec -- node --no-warnings' -InputText $AegisBootstrap -TimeoutMs 90000
    $AegisStart = 'AEGIS_READONLY_EVIDENCE_BEGIN'
    $AegisEnd = 'AEGIS_READONLY_EVIDENCE_END'
    $AegisFirst = $AegisRemote.Out.IndexOf($AegisStart, [StringComparison]::Ordinal)
    $AegisLast = $AegisRemote.Out.IndexOf($AegisEnd, [StringComparison]::Ordinal)
    if ($AegisFirst -lt 0 -or $AegisLast -le $AegisFirst -or $AegisRemote.Out.IndexOf($AegisStart, $AegisFirst + $AegisStart.Length, [StringComparison]::Ordinal) -ge 0 -or $AegisRemote.Out.IndexOf($AegisEnd, $AegisLast + $AegisEnd.Length, [StringComparison]::Ordinal) -ge 0) { throw 'AEGIS_SAFE:NO_UNIQUE_COMPLETE_COLLECTOR_RECORD' }
    $AegisJson = $AegisRemote.Out.Substring($AegisFirst + $AegisStart.Length, $AegisLast - $AegisFirst - $AegisStart.Length).Trim()
    $AegisStage = 'COLLECTOR_JSON_INVALID'
    $AegisParsed = $AegisJson | ConvertFrom-Json
    if ($AegisParsed.collectorVersion -ne 2 -or $AegisParsed.productionMutations -ne $false -or @('EVIDENCE_COLLECTED_REQUIRES_REVIEW','INCOMPLETE_BLOCKED') -notcontains $AegisParsed.status) { throw 'AEGIS_SAFE:UNEXPECTED_COLLECTOR_RECORD' }
    $AegisStage = 'LOCAL_EXPORT_FAILED'
    $AegisFile = Join-Path $OutputDirectory ('AEGIS-Production-Readonly-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.json')
    $AegisUtf8 = New-Object Text.UTF8Encoding($false)
    $AegisExport = [IO.File]::Open($AegisFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $AegisExportBytes = $AegisUtf8.GetBytes($AegisJson); $AegisExport.Write($AegisExportBytes, 0, $AegisExportBytes.Length); $AegisExport.Flush() }
    finally { $AegisExport.Dispose() }
    Write-Host ('Evidence saved: ' + $AegisFile)
    Write-Host ('Collector result: ' + $AegisParsed.status)
    Write-Host 'Return ONLY this JSON and existing backup/restore evidence. Never send credentials, private keys, operational rows or raw transport output.'
    if ($AegisRemote.Code -ne 0 -or $AegisParsed.status -eq 'INCOMPLETE_BLOCKED') { exit 2 }
} catch {
    $AegisCode = $AegisStage
    if ($_.Exception.Message -match '^AEGIS_SAFE:([A-Z_]+)$') { $AegisCode = $Matches[1] }
    Write-Host ('AEGIS_STOP: ' + $AegisCode)
    Write-Host 'No successful production evidence is established. Return this code only; preserve prior JSON and do not send raw diagnostics or credentials.'
    exit 2
}
