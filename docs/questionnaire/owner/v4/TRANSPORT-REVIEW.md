# Production read-only transport v4 — diagnosis and timeout policy

No production changes executed. Original 456-test implementation, v3 16-test evidence and prior packages are preserved unchanged. v3 actually passed the Owner's Windows NPM_CMD launcher, Railway authentication and collector-hash checks; the large StandardInput.WriteLineAsync failed to complete. The remote collector was not established as executed.

## Root cause: what is and is not established

Confirmed local mechanism: the v3 caller writes the entire approximately 25KB bootstrap to an anonymous pipe before closing stdin; an upstream process that has not started reading can block that write. v3 concurrently starts ReadToEndAsync, but hides its accumulated SSH diagnostics until EOF and discards stderr. A key-registration/API wait, host-key refusal/prompt, key unlock, relay/connectivity failure or forwarding failure can therefore be masked by RAILWAY_STDIN_DEADLINE_EXCEEDED. The single timeout code does not identify which condition happened on the Owner PC. That discarded output cannot be reconstructed from the available evidence. **The exact Owner-side trigger remains unverified.** No host-trust/key-registration failure is asserted merely from the timeout.

Independent source inspection: npm @railway/cli 5.75.0 forwards stdio using execFileSync(...,{stdio:'inherit'}); Railway native SSH uses the system OpenSSH client, inherited stdio and non-PTY -T for piped commands. The target and registered-key lookup occur before the native SSH process. The installed Owner CLI version is not known from v3's exported evidence; v4 records it. Upstream code inspection is not proof of the installed version's behavior.

## Corrected execution path

1. Retain Application-only npm .cmd/native resolution and bounded --version/authentication checks. Hash-check the exact embedded collector again before any collection. Do not install, upgrade, log in, register/remove keys or mutate configuration.
2. Read `railway ssh keys list`, restrict fingerprint parsing to the actual registered section (not imported/unregistered GitHub/local keys), and match existing local public keys where available. Only counts/match booleans are exported. Agent-only identities may be used; actual strict SSH authentication is still required. No new keys are generated and no private-key bytes are read/exported by PowerShell.
3. Resolve the exact existing backend service target using `railway ssh config --dry-run` with explicit project/environment/service IDs. This prints the supported native OpenSSH target without writing configuration or invoking the CLI's interactive key-registration path. Unsupported CLI capability fails closed and reports its stage; no automatic upgrade.
4. Use native OpenSSH to the resolved service instance at ssh.railway.com:22, requiring BatchMode=yes, StrictHostKeyChecking=yes, UpdateHostKeys=no and non-PTY -T. Disable agent forwarding, local command hooks, inherited forwardings and connection multiplexing for these probes. Existing trusted known_hosts and usable registered keys are required. Never accept-new, disable host checking, use a peer/keyscan as its own trust source, or write SSH configuration. A new/mismatched host or encrypted/unavailable key stops with a specific code.
5. Supply input through a unique temporary **local regular file** opened by the OS command interpreter as stdin. The file contains only public collector code or synthetic input; it is removed after the owned process exits. The Windows cmd /d /v:off /s /c quoting retains the npm/native path and separate arguments; expansion/control characters fail closed. There is no StandardInput.WriteLineAsync and no large anonymous-pipe write. EOF is available from the already-complete file regardless of npm/Railway startup timing.
6. Gate real collection on three harmless remote proofs: a unique numeric Node -p nonce with empty input; a tiny stdin program; and an ASCII stdin program **exactly equal in byte size to the real collector bootstrap**. Each returns its own fixed expected nonce. Exit0 without that expected output is not PASS. No filesystem writes, environment inspection, alerts or database calls occur in these probes.
7. Only after those pass and sufficient overall budget remains, run the SHA-bound read-only collector. Existing read-only transactions, fixed metadata SQL, output sanitization and trusted-positive/wrong-host/untrusted-CA TLS checks remain unchanged. The collector's default/maximum watchdog is now 300 seconds, as requested. Per-query/lock/connect safeguards are retained.
8. Capture stdout/stderr incrementally in bounded memory using .NET Framework-compatible asynchronous readers. Export stage, elapsed/budget, byte/character counts, exit code, timeout flag, fixed failure classification, SSH-authenticated and host-key-matched booleans. Raw streams, paths, target/key identifiers, credentials and operational rows are not exported. Always attempt a separate sanitized diagnostic JSON, including on failure. Unique begin/end markers, record type/status/mutation=false and exclusive UTF-8 CreateNew export protect evidence integrity.

## Budgets requested by Owner

| Boundary | Cap |
|---|---:|
| Overall procedure, including preflights | 600 seconds shared |
| Remote collector watchdog | 300 seconds |
| Collector SSH transport | 330 seconds, within remaining overall budget |
| Harmless full-size stdin proof | 75 seconds |
| Remote Node / small stdin proof | 45 seconds each |
| Auth | 30 seconds |
| Registered inventory / dry-run target | 45 seconds each |
| CLI/OpenSSH version | 15 seconds |
| Local stdin-file preparation | 15 seconds measured; no pipe-write wait exists |
| Overall reserved cleanup/export margin | 10 seconds |

Every process uses the smaller of its stage cap and remaining overall budget. The procedure refuses to start the collector with less than 340 seconds remaining. Caps are not additive grants beyond 600 seconds. A stalled local filesystem cannot be proven to obey a hard wall-clock cap by these process controls; inputs/exports are small local files, with explicit measured preparation bounds. No timeout was increased to conceal a failed prerequisite.

## Diagnostic classes

SSH_REGISTERED_KEY_REQUIRED, SSH_REGISTERED_LOCAL_KEY_REQUIRED, SSH_HOST_TRUST_REQUIRED, SSH_HOST_KEY_CHANGED, SSH_KEY_AUTHENTICATION_DENIED, SSH_KEY_UNLOCK_REQUIRED, SSH_LOCAL_CONFIGURATION_REJECTED, SSH_DNS_FAILED, SSH_CONNECT_FAILED, REMOTE_NODE_UNAVAILABLE, CLI_CAPABILITY_UNAVAILABLE, REMOTE_SENTINEL_MISSING_OR_CHANGED, TRANSPORT_DEADLINE_EXCEEDED, INSUFFICIENT_REMAINING_COLLECTOR_BUDGET and TOTAL_BUDGET_EXHAUSTED. A stage plus fixed class replaces the ambiguous stdin timeout; inconclusive failures remain inconclusive, never fabricated as a particular cause.

## Actual verification and limits

23 targeted tests PASS on the final immutable backend source: v4 transport/procedure tests plus existing launcher and real PostgreSQL/node-postgres TLS collector regression. Actual isolated OpenSSH server and native client verify key authentication, strict host trust, remote Node nonce, tiny/full-size file-backed stdin, unknown-host rejection and wrong-key rejection. Full v4 script runs through a simulated Railway API/target CLI with npm-style execFileSync/inherited stdio, actual local SSH/Node and intentionally unavailable production catalog; it exports valid INCOMPLETE evidence after all harmless probes. A stalled reader with a partial SSH error proves bounded cleanup and safe classification without raw-output disclosure. Synthetic keys/sshd live only in disposable isolated test fixtures and are excluded from artifacts.

Windows-mode quoting/resolution and PowerShell 5.1/.NET Framework syntax/API compatibility are reviewed; actual v4 Windows/cmd and Owner Railway relay are unavailable here and **not claimed PASS**. The already observed v3 Windows launcher/auth PASS remains valid historical evidence, not a substitute for this transport's platform acceptance. The next Owner run performs the staged proofs itself before collection; return its diagnostic JSON even if it stops. Do not send raw output or approve blind SSH trust to get past a gate.

## Source references (read-only inspection)

- https://docs.railway.com/cli/ssh — supported non-PTY piped input/native target/key commands.
- https://github.com/railwayapp/cli/blob/master/src/commands/ssh/native.rs — inherited stdio, key lookup before SSH, retrieved source text SHA-256 2c457f45742b456ccffc77f5cbca17417fba1bc9860b6106c1b0936fcedeba08.
- https://github.com/railwayapp/cli/blob/master/src/commands/ssh/config.rs — dry-run prints without upsert; retrieved source text SHA-256 3950b6fb0f3028261c39788ee6771a6fdf53024acc5c1e0ffbf22c3f553702d0.
- https://github.com/railwayapp/cli/blob/master/src/commands/ssh/keys.rs — read-only registered/local/GitHub distinction; retrieved source text SHA-256 0080f9f6ced171ef05872449605a29d64446d6bef9f70e05eda4c220a7d9b5b1.
- npm @railway/cli@5.75.0 archive SHA-256 f19241231f23dbe0bd12bd4cb692c9ba53f692315cdbfcc38087b4235f1e604b; bin/railway.js inherits stdio. No global CLI installation or application dependency upgrade performed.

Provider issue reports about similar symptoms are not used as proof of this Owner's root cause. Actual production inventory/TLS/backup gates remain BLOCKED until evidence is returned and reviewed.
