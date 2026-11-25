# Consolidated Q02–Q07 execution register

Status: IMPLEMENTATION IN PROGRESS — no production acceptance or deployment.

Governing specification: Q01 architecture and the 25 November 2026 consolidated auditor instruction. D01 accepted; D02 isolated keys only; D03 destructive retention disabled; D04 real concurrency evidence required; D05 production catalog/TLS/roles/backups pending; D06 factual reproducibility, no permanent PDF subsystem.

## Verified source and dependency gate

- Backend main 8948b767febb47458d9f3ff1f2f36f78c5439246, tree 290f943a66fdbbf0e3427cd957e3aac7e101550d.
- Guard main 4d62383e4aab0d928716c84597324c5f8577aa10, tree 14c5525f641613ba46a849a0731c8192c74f2c5a.
- Dashboard main ee61e4cd0fa9a77a28f2131e9a637bead23b1478, tree 5d7c7068eb42ec35db757241a02f5c8de46647fe.
- All worktrees clean before isolated feat/incident-questionnaire-engine branches.
- Questionnaire dependency map remains Q01 sections 2–4. Additional authorized remediation surface: App.jsx report template and iframe consumed by preview/printing; new HTML helper has no operational caller beyond preview. db.js is shared by all backend functions; strict TLS changes require isolated configuration and full suites before proposed release.
- Planned critical-path edit only: same alert INSERT copies site capsule and verified session, no questionnaire query/crypto/pool acquisition before dispatch. Site creation/publication share a documented lock order. Legacy auth, timestamps, lifecycle, notification dispatch and notes remain authoritative.

## Protected evidence

Railway current metadata: backend deployment 1cfc7084-5ab6-4653-ae82-c63c41b5009c SUCCESS; PostgreSQL image postgres-ssl:18. No staged changes. OAuth variable values withheld; no SQL or agent-connector execution available. Production schema and deployed TLS trust cannot be inferred from metadata. Owner read-only inventory requested; a YES acknowledgement is not catalog evidence.

## Work started

- Extract report HTML with per-value escaping, no external images, nonce CSP and opaque sandbox preserving trusted print action.
- Implement schema/answer contracts and versioned AES-GCM/RSA-OAEP keyring with tenant-keyed integrity. Non-production keys generated only during tests.
- No physical migration finalized or added to the production migration runner pending D05.

## Diagnostics

- Container /usr/bin/chromium wrapper exists but real binary is missing. Initial actual-browser test failed launch (127); test corrected to always close its local harness. Obtaining isolated browser tooling; no claim of browser PASS.
- PostgreSQL server executable absent. Isolated test tooling preparation underway; no mocked result will be labeled real PostgreSQL.

## Restrictions retained

No production merge/migration/deploy/configuration/key creation; no historical row writes; no real panic/SMS/voice; no new AI integration; no telecom changes; no destructive retention or company inheritance.

## Subsequent verified progress

- Isolated PostgreSQL 18.7 and Chromium 143 obtained as test tooling under /tmp, with no application dependency upgrades. PostgreSQL is started and stopped inside each test invocation because exec invocations have separate network namespaces.
- Actual Chromium sandbox/CSP/parent-auth/network-canary test PASS.
- Actual TLS trusted/wrong-name/untrusted-CA handshakes PASS using ephemeral synthetic keys. Actual production trust is still unverified; strict db.js rollout remains a Q07 protected gate.
- Real PostgreSQL targeted tests cover immutable versions, exact session ownership, wrong-tenant denial, atomic/idempotent submission, lost receipt after resolution, encrypted custody, expired-session review and alert FK insertion while a site-management NO KEY UPDATE lock is held.
- Dynamic management, authorization and recovery routes implemented; route classification is explicit before broad site permissions. Module authorization re-reads actual role permissions, without extending legacy fallback grants.
- Questionnaire schema is a guarded synthetic fixture, NOT a finalized physical production migration and NOT registered in runMigrations. D05 gate remains pending.
- Existing optional AI path now allowlists the already-used generic event, removes identity/time context from external input, and redacts content/error logs. No new AI service or questionnaire transmission added.
- Native incident renderer now uses loopback for authorized internal fetch, disables JavaScript and blocks external requests. Existing renderer mocks were extended to assert the new safeguards; all existing response assertions retained.

## Accepted recovery continuation — 25 November 2026

- Original recovery ZIP SHA-256 5b3637ca3a6a8d7f1a061d20f2318069db44a5399f7abbbdc5028d52c44da309 preserved unchanged; all 37 recovered source file hashes matched, including all 11 tracked reconstructions. Local heads/trees and live GitHub main matched the accepted baselines.
- All three GitHub repositories are public. No implementation branch/PR was published; durable private verified artifacts are used. Railway backend observes main; backend workflow runs on push; frontend deployment workflows run main/workflow_dispatch. No production changes or CI dispatch performed.
- Restored PostgreSQL 18.7 via pinned isolated package. Added compatible pg_dump/psql/libpq 18.7 client tooling for actual SQL restore rehearsal. Application dependency versions were not upgraded.
- Full Chrome launch hit process-singleton AF_UNIX restrictions. Supported Chromium headless-shell 143 works; no permission escalation used. This is actual Chromium emulation, not a physical Android result.
- New scoped fixes: /alert no longer logs req.body or raw error details; PDF failure responses no longer disclose raw renderer errors. Dashboard fetch is bounded, and unconfirmed publication errors require reloading actual configuration. Added explicit active-version metadata and code-only rejected-attempt auditing after rollback.
- Added actual SQL backup/restore with preserved encrypted facts and old-key recovery, first-write transaction rollback, legacy compatibility and rejection-audit tests. Browser test covers worker-pool saturation, failed quota with blocked reload, offline restart/recovery, and interrupted legacy migration that removes plaintext only after verified server custody/readback.
- Preliminary new results: targeted TLS/crypto/PostgreSQL 17/17; extended PostgreSQL/report run 54/54; actual mobile browser and editor/report frame passed. These precede the final immutable-source run and are NOT substituted for it.
- Railway OAuth values are redacted and agent connectors unavailable; actual core SQL cannot be executed through this connection. A consolidated read-only backend-shell collector was provided. Owner YES is authorization only: production catalog, roles/grants, actual certificate trust and provider backups/restore remain BLOCKED until real output arrives.
- Supabase aegis-link-storage metadata read in READ ONLY: aegis-guard-reports private (4 objects), aegis-site-sops-private private (1), legacy aegis-sop-files public (0). RLS enabled on storage buckets/objects; no storage RLS policies returned. Grants alone do not bypass RLS for ordinary roles; service_role is privileged and backend authorization remains essential. Backend environment-to-project mapping still needs production evidence; no object contents or names read.
- Final reconciliation/runbook/key-custody/API/future-AI-contract/proposed-PR documents prepared. Physical production migration intentionally not finalized or put in startup runner. Retention/key/device/CI/production gates remain explicit.

Permanent execution controls retained: periodic durable source/evidence checkpoints; bounded execution and cleanup; complete execution-path prerequisite review; safe diagnostics and recovery paths; verify readiness before protected actions; correct and retest authorized in-scope failures automatically. No real panic/SMS/voice or new AI integration. Vonage #3186747/#3186760 unchanged.


## Final-candidate gate closure continuation — 25 November 2026

- Accepted original candidate ZIP preserved unchanged (SHA-256 d3b9a64893e7487d63ea3968f73e8a153d2a2411ce83ef5b0820d85139ba6843). Local-only successor branches; no public publication or remote CI.
- Standalone production collector never imports deployed db.js; approved legacy profile is hash-checked before connection. Fixed read-only SQL, bounded execution, migration/runtime grant completeness and sanitized output. Actual node-postgres TLS positives and wrong-host/untrusted-CA negatives plus PowerShell transport harness verified with synthetic PostgreSQL. Windows 5.1 syntax targeted; actual Windows/production execution remains pending.
- Mixed-version HTTP rehearsal discovered old-client custom questionnaires returned 500. Corrected to explicit upgrade-required 409 and retested. Exact prior accepted engine reader can read final snapshots and replay receipts; floor guard refuses pre-engine or missing historical keys.
- Recovery now requires explicit questionnaire grant even for wildcard/System Owner. Held redundant drafts and unsubmitted evidence preservation tested.
- Removed diagnostic content from relevant backend/shared routes, Dashboard and Guard/PWA; access logs omit paths/query/identity; authenticated/sensitive APIs no-store; parser/unhandled errors return bounded codes. Existing business notification/audit records and dispatch adapters remain intact.
- Added sealed environment keyring provider, historical restore through same provider, and concrete Railway Docker runtime-isolation/rotation/age escrow proposal. No production root or escrow identity created.
- Retention/recovery/legal-hold, private-review CI templates and physical-device acceptance procedure prepared as proposals. No destructive cleanup enabled, private repository created, CI run, image build or physical-device PASS claimed.
- Final evidence must bind exact final commit/tree identities; preliminary targeted logs do not substitute for that run. Production schema/TLS/backups, Owner policy/custody, physical devices and authorized private CI remain explicit pending gates.


## Windows launcher correction v3 — 25 November 2026

Owner reported Windows PowerShell 5.1 with npm railway.ps1 (ExternalScript), railway.cmd (Application) and extensionless railway (Application). v2 hash verified, but Process.Start failed before remote execution. No production evidence was collected. Original Final Gate Closure ZIP SHA-256 408ff38a7813057f880aea90de98d141e71dfa308373261b9bf2ee911ad16941 and its 456/456 evidence are preserved unchanged.

Corrected launcher prefers Application railway.cmd via system cmd.exe /d /v:off /s /c; never starts the PowerShell shim. Fallback native executable must pass MZ validation and actual bounded --version before auth/SSH. Arguments are a fixed read-only allowlist; payload travels over redirected stdin, not cmd quoting. Stdin, process and stream completion share bounded deadlines; failures trigger cleanup and emit static codes. JSON requires unique markers, valid collector version/status/no mutation, with UTF-8 exclusive CreateNew export. No deployed collector or application runtime implementation changed.

Targeted v3 tests cover Windows-mode command resolution/quoting/refusal, bounded blocked stdin/process, parser/API compatibility review, authentication and sanitized diagnostics, malformed/duplicate/incomplete JSON, and actual PostgreSQL/node-postgres TLS/readonly/output. These run on PowerShell 7.7/Linux; there is no Windows host/Windows PowerShell 5.1 execution surface here. Native Windows/cmd execution and actual production collection remain pending the supplied single Owner command; no Windows-native PASS is claimed. See WINDOWS-LAUNCHER-V3-REVIEW.md.


## v4 stdin transport diagnosis and Owner timeout amendment — 25 November 2026

Owner confirmed v3 Windows NPM_CMD/auth/hash PASS, then RAILWAY_STDIN_DEADLINE_EXCEEDED; no confirmed remote collector execution. The exact host trigger remains unverified because v3 discarded partial SSH diagnostics. Confirmed wrapper defect: large pipe write before EOF can block while upstream startup/auth/SSH is not reading, hiding useful errors.

Replaced the large WriteLineAsync pipe path with OS file-backed stdin, staged harmless Node/small/exact-size probes, bounded partial stream capture and fixed diagnostic classes. Read-only key inventory and config --dry-run resolve native SSH without auto-registration; strict batch SSH preserves trusted host verification, denies unknown/changed hosts and disables forwarding/hooks. No production config/trust/key changes.

Owner explicitly amended timing to overall600s/collector300s. v4 applies shared remaining-budget controls,330s collection transport,75s full-size probe,45s Node/small probes and15s measured local input preparation, with cleanup/export reserve and readiness refusal if insufficient time remains. Fixed SQL/query/lock/TLS controls remain.

23 targeted tests include actual isolated OpenSSH/Node, strict host/key negatives, collector-sized stdin, full v4 synthetic API/SSH execution, bounded stalled reader diagnostics and real PostgreSQL/TLS/earlier launcher regressions. No claim of native v4 Windows or production relay PASS. Original456-test package and v3 evidence remain unchanged. Exact source/evidence recorded in v4 addendum.
