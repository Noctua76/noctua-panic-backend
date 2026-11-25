# Proposed pull requests — prepared, not published

The repositories are public. Branch publication is not used for private recovery. Exact candidate heads/trees and complete diffs are in the acceptance archive; no PR number or CI result is invented.

## Backend: Add immutable site questionnaire engine and authenticated encrypted custody

Incidents capture the applicable site assignment and authenticated Guard session in their creation statement, then initialize their snapshot after notification dispatch. The new module provides immutable publication/history, revisioned encrypted draft custody, original-session recovery, idempotent finalization and report adapters with fresh tenant/RBAC checks. Legacy three-question handling is retained only for compatible captured versions.

Report rendering and affected error paths prevent untrusted HTML, outbound requests and raw operational diagnostics. PostgreSQL connection options require certificate/hostname verification; this configuration must not reach production before D05 trust evidence and explicit rollout authorization. No production questionnaire migration is registered: physical DDL remains blocked on the actual catalog.

Validation: final manifest-bound full regression, real PostgreSQL concurrency/rollback/backup-restore and crypto/TLS tests, browser security and native PDF evidence. Explicit release conditions are in RELEASE-RUNBOOK.md and ACCEPTANCE-MATRIX.md.

## Dashboard: Manage per-site questionnaire versions and isolate report previews

Settings → Sites gains a scoped questionnaire editor with draft/publish/restore, required/optional text questions, stable ordering, synthetic preview, history and audit metadata. Company changes fence late responses. Report HTML escapes untrusted values and runs in an opaque sandbox with a nonce-based print action. Unconfirmed mutations instruct the user to reload current configuration before retry.

Validation: final full regression/build and actual Chromium editor/report-frame tests. No menu redesign or public deployment performed.

## Guard: Add incident-bound questionnaires with encrypted outbox and session recovery

Each captured incident has its own dynamic questionnaire, checkpoint and final receipt. IndexedDB stores sealed envelopes; online original-session authorization is required after restart. Session changes clear sensitive UI and leave unresolved original ciphertext intact. Legacy plaintext is removed only after authenticated custody and readback; quota/connectivity failures do not fall back to new plaintext storage.

Validation: final Guard suite, mobile Chromium with real PostgreSQL, multiple synthetic alerts, lost receipts, session switch, offline restart, quota failure and interrupted legacy migration. Physical Android/device fleet cutover remains a release gate. No real notifications were dispatched.
