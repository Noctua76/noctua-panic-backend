# Q07 coordinated release preparation — CONDITIONAL / NOT EXECUTED

## Entry gate

No production merge, migration, deploy, configuration/feature change, key creation or operational dispatch is authorized. Q06 complete readiness is BLOCKED until the missing evidence below is accepted. Local synthetic results do not authorize customer activation.

1. Verify exact source manifests/commit and tree identities for backend, Dashboard and Guard; assess all diffs and required CI. The repositories are public. Do not publish this private implementation checkpoint as a development branch without separately resolving visibility. Backend push triggers tests; frontend main/workflow_dispatch triggers Pages; Railway backend watches main. No branch publication or CI dispatch was performed in this cycle.
2. Obtain actual Railway metadata using the SHA-bound owner/AEGIS-Production-Readonly-v4.ps1 procedure. The standalone collector reads and verifies deployed db.js bytes without importing it; never import db.js/server.js or run migration code. Return only marked sanitized JSON. Verify actual migration history, column types, timestamps, PK/FK/index/trigger dependencies, runtime ownership/grants/memberships/privileges/RLS and deployed connection identity.
3. Positive pg_stat_ssl is encryption only. Require an independent trusted CA and hostname verification over the actual backend connection; record invalid-chain/wrong-host negative tests. Do not use the peer certificate as its own authority. db.js candidate is strict and MUST NOT be rolled out before trust prerequisites are proven; configuration changes require Owner authorization.
4. Verify provider backup encryption/access, schedule/retention, restore rehearsal and key escrow. Confirm the live backend Supabase project/bucket mapping matches inspected aegis-link-storage metadata; private buckets alone do not prove end-user authorization. The legacy public bucket was empty at inspection. Do not change it as part of this release.
5. Approve key custody, reviewers, retention/holds and trusted-device migration policy. No production keys exist from this work. Destructive cleanup remains disabled.

## Migration strategy — physical DDL BLOCKED on D05

The guarded development-schema.sql is a synthetic fixture, NOT a deployable migration. Do not register it in database/run-migrations.js. After actual catalog review, prepare a separately reviewed additive migration: preserve actual key types and naive timestamps; add nullable routing/binding/session columns; create scoped encrypted version/assignment/snapshot/custody/fact/audit structures and integrity constraints; define module permissions with least runtime grants. Analyze real table sizes and locks. Rehearse the exact migration, interruption and rollback at accepted server version and representative cardinality before approval. Use measured lock/statement abort budgets and separately planned nontransactional index steps if required. Do not invent thresholds from synthetic timing alone.

## Proposed deployment order, after independent acceptance and explicit authorization

1. Freeze signed/hashed source, build artifacts and compatibility-floor copies; verify production restore and key-custody readiness. Inventory trusted devices/pending plaintext/active old PWAs; Owner involvement only where physical devices or credentials are required.
2. Deploy backward-compatible backend expansion/readers, secure custody and key delivery with engine/custom publication disabled. Execute only the independently accepted additive migration in its approved window. Verify schema/capabilities/tenant authorization/no-store/TLS and recoverable failures without dispatch.
3. Deploy Dashboard editor/report compatibility; then Guard dynamic secure storage/capability-aware logic. Check build/runtime/service-worker/controller identities. Already-open code is not replaced merely because a worker claimed control. Wait for pending alert responses and local sealed commits; quota failure prevents reload readiness.
4. Migrate each relevant trusted device's legacy drafts under real original ownership. Verify sealed custody plus authenticated readback BEFORE deleting plaintext. Keep failed/expired-session evidence for explicit reviewer workflow. Do not clear storage or reassign drafts to another session. Block custom activation until incompatible old clients and unresolved plaintext risks are reconciled.
5. Initialize approved default routing under a separate authorized transaction, then enable a limited synthetic-data canary. Verify immutable binding/assignment snapshots, history, report rendering, rejection paths, custody and receipts. New publications affect future incidents only.
6. Owner-controlled real panic/SMS/voice acceptance remains a separate action with explicit scope. No such action was executed here. Preserve Vonage investigations #3186747 and #3186760.

## Compatibility floor and rollback

See KEY-CUSTODY-RAILWAY-V2.md, RETENTION-RECOVERY-POLICY-PROPOSAL.md, PRIVATE-PR-CI-PUBLICATION-STRATEGY.md and PHYSICAL-DEVICE-ACCEPTANCE.md for concrete pending decisions/procedures. No template is installed as an active workflow, Dockerfile or policy.

The coordinated candidate heads retain legacy readers plus dynamic readers, key-version access, custody, receipts and immutable history. Preserve these exact binaries/source as the compatibility floor. After encrypted evidence exists, returning to the pre-engine accepted main commits is not an approved rollback.

On failure: pause custom configuration writes/activation under separately authorized control, preserve all tables, keys, sealed packets, assignment/version/snapshot records and receipts. Redeploy only the accepted compatibility-floor artifacts in backend → Dashboard → Guard order as applicable. Already captured incidents must keep their version. Restore Default is not a rewrite of existing incidents. No destructive down migration, key deletion, storage clear, fabricated answer or replay of a real notification.

Worker/key outage: preserve ciphertext and explicit recoverable state; critical panic dispatch has no questionnaire crypto/read/pool dependency before notification attempts. Core PostgreSQL outages still affect incident creation. Lost production keys/backup mismatch remains a blocked recovery, never a successful restoration claim.

## Required release output

Proposed PR descriptions/immutable local heads, source/bundle and manifest, exact tests/commands/runtime versions, browser/native PDF evidence, D01–D06/T01–T16 matrix, production inventory and TLS trust decisions, finalized catalog-grounded migration, CI links, approved key/retention/device policy, coordinated artifacts and postdeploy checks. Until D05 and the other entry gates close, release status is CONDITIONAL, not Q06 ACCEPTANCE READY.
