# Windows production collector launcher v3 — execution-path review

Status: corrected and locally verified with explicit platform limit. No production mutation, SSH collector execution, key provisioning, public branch push or deployment occurred. Owner's failed v2 attempt did not execute remotely. The original final-gate package and recorded 456 tests are preserved.

## Cause and correction

v2's untyped Get-Command could resolve railway.ps1. CreateProcess with UseShellExecute=false cannot execute that PowerShell script as a native application. v3 asks for CommandType Application and prefers railway.cmd explicitly. The npm batch wrapper runs through the system cmd.exe, using /d (no AutoRun), /v:off (no delayed expansion), /s /c and a separately quoted absolute wrapper path. Percent/bang/quote/newline paths fail closed rather than expanding unpredictably. Spaces and ampersands remain quoted. No collector payload or credentials enter the command line. Fallback native candidates exclude ps1, non-exe extensions and non-MZ extensionless shell shims; a bounded railway --version verifies that the selected launcher actually runs before authentication or remote collection. This is execution-format/behavior validation, not a code-signing provenance attestation of the installed CLI.

## Complete path

| Stage | Reviewed controls / verification |
|---|---|
| Local destination/payload | Verify output directory and disposable write probe before remote work; exact embedded SHA-256; v2 remains unchanged. |
| Resolution | Application-only cmd first, native fallback; no alias/function/ExternalScript, no COMSPEC override. |
| Arguments | Allowlist only --version, whoami --json and the exact backend SSH node command. Unknown/mutating strings rejected before Start. |
| Authentication | Bounded version and whoami checks; raw stdout identity and stderr are discarded. Existing Owner CLI credentials are reused, never exported. No automatic login/install/upgrade. |
| SSH | Explicit existing project/environment/backend service IDs; no linked-project mutation. Non-PTY piped stdin. No production file creation, startup import or migration command. Existing SSH access is required; registration/auth prompts are not automatically approved. |
| Payload/remote | ASCII bootstrap over async stdin, verifies SHA again before executing the unchanged standalone collector. Unexpected db.js source is refused; source is never imported. |
| Read-only/TLS | Same accepted collector bytes: fixed metadata inventory, verified read-only transactions, bounded SQL, node-postgres certificate chain plus hostname positive/wrong-host/untrusted-CA probes. Missing trust is BLOCKED, never relabeled PASS. No peer-as-root trust. |
| Bounds/cleanup | 15s local launcher/auth calls; 90s shared stdin/process/stream deadline; remote collector 60s watchdog. Own Windows launcher tree terminated via system taskkill on incomplete execution; no global process kill. Bound output accepted at 8MiB. No raw exception/stack/transport output emitted. |
| Export | One unique begin/end record only, valid JSON/version/status/mutation=false. UTF-8 without BOM; GUID timestamp filename and exclusive CreateNew avoid overwriting earlier evidence. Incomplete evidence is saved and exits2. Failed collection/parse is not success. |
| Diagnostics | Static AEGIS_STOP code, launcher kind, verified payload hash and resulting local JSON path only. Return sanitized JSON or AEGIS_STOP code; never raw diagnostics, credentials or operational rows. |

## Verification and platform limits

16 targeted tests pass: six launcher/path/bounds/parser/output tests plus ten collector/TLS/PowerShell integration checks (TAP subtest totals). Real isolated PostgreSQL 18.7, node-postgres and certificate handshakes; synthetic CLI transport and generated test-only CA/keys. Command lookup is simulated in Windows mode to verify cmd preference and native refusal; cmd.exe itself is not available in this Linux workspace.

The script uses #requires -Version 5.1, ASCII source and APIs available in .NET Framework 4.5+: ProcessStartInfo/Arguments, StreamWriter.WriteLineAsync, StreamReader.ReadToEndAsync, Task.Wait(int), Process.WaitForExit(int), UTF8Encoding and FileMode.CreateNew. No PowerShell 7 ternary/pipeline/null-coalescing syntax, ArgumentList, WaitForExitAsync or Kill(bool) dependency. Parser and API review passed under PowerShell 7.7/Linux. **Actual Windows PowerShell 5.1/cmd execution is not yet verified** and must be established by Owner execution; it is not reported as native Windows PASS.

The version/auth preflights occur automatically in the single v3 procedure. If launch/auth/SSH fails, return its bounded AEGIS_STOP code; do not send raw error output or alter trust/configuration. No second fallback procedure or manual collector paste is needed for the current correction.

Procedure and collector SHA-256 are recorded in owner/COLLECTOR-BINDING.json. The launcher is version3; the unchanged collector payload/schema remains version2 by design. A v3 script must accept collectorVersion=2, not manufacture a schema-version upgrade.

Primary sources reviewed 25 November 2026:
- https://learn.microsoft.com/en-us/powershell/scripting/learn/shell/running-commands — PowerShell's batch execution uses cmd.exe.
- https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.useshellexecute?view=netframework-4.8 — executable-only launch versus shell associations/redirection.
- https://docs.railway.com/cli/ssh — explicit target and non-PTY piped input.
