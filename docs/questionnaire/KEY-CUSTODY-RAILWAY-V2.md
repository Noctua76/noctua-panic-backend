# Concrete Railway key custody, rotation, escrow and recovery proposal

Status: proposed for Owner/independent approval. No production key, service variable, Docker build, configuration or deployment has been created or changed.

## Recommended delivery: sealed variable + reviewed Docker build + memory-only keyring

1. Keep the existing Railway backend service/project/environment. Prepare a service-scoped sealed `QUESTIONNAIRE_KEYRING_BASE64` containing base64 of the validated versioned keyring JSON. Do not use a shared project variable, frontend variable, Docker ARG/ENV, repository file, image layer, command-line argument or build log for its value. Provision it only in a separately authorized protected Owner session. No value is included in this proposal.
2. Use the supplied runtime loader `Keyring.fromEnvironment`: choose exactly one provider (sealed value OR the previously accepted owner-only file), validate envelope/key IDs, RSA strength/pairs and integrity-key length, remove the process's environment copy, clear the decoded buffer, and retain keys only in backend memory. No private file is created by the sealed provider. Missing/malformed/ambiguous custody fails closed for the questionnaire; panic dispatch does not load this keyring.
3. **Sealing is not build isolation.** Railway states that sealed variables are still available to builds and deployments. Current Railpack automatically exposes variables during build. Therefore do not provision questionnaire roots into the current Railpack build plane and call them runtime-only.
4. Recommended bounded infrastructure amendment: reviewed Dockerfile build with NO `ARG` or `ENV` for ANY secret; runtime variables are injected only at container startup. Templates are stored below docs, not at the repository root, so they cannot activate a builder change. A `.dockerignore` excludes env/key/runtime artifacts. The template's synthetic canary check must fail if the build can see the keyring variable. Before actual production key provisioning, the Owner must approve this builder/startup change and the image must pass the complete PDF/regression/runtime-secret CI test. Current deployment remains unchanged.
5. The host/provider and anyone with privileged backend shell access remain trusted. Deleting a JavaScript environment property does not guarantee erasure from OS process memory, crash dumps or all immutable strings. Keep shell access least-privileged and audited; no crash/core dump containing key material may be exported. The shared wrapping root's cross-tenant blast radius is acknowledged; per-checkpoint AES keys, tenant-bound AAD and derived tenant integrity remain enforced.

This uses existing hosting plus a free offline encryption utility; no paid KMS/HSM or extra service/volume is proposed. Incremental KMS subscription: zero. Existing compute, CI and encrypted-backup storage remain subject to the actual plan; no plan change or unlimited-cost assumption is authorized.

## Two-phase rotation without a mixed-version outage

A. After separate key-generation approval, generate v2 on the trusted Owner device, update encrypted escrow, and stage a keyring containing v1 + v2 with ACTIVE=v1. Deploy only after authorization. Verify every active instance/compatibility-floor reader has both key IDs and historical decrypt succeeds. Do not print keyring objects.

B. Stage the same key set with ACTIVE=v2; authorize the coordinated deployment. Nodes still writing v1 can read v2 because phase A installed it everywhere. New writes use v2; old outbox/public wrapping keys and original receipts remain recoverable via v1. On a problem, restore ACTIVE=v1 while retaining both keys; never return to a reader without v2 access.

C. Key removal is a separate destructive disposition. Require zero references across versions, snapshots, answers, drafts, receipts, restore candidates, offline escrow copies and legal holds. Calendar age alone is insufficient. Shared roots cannot be removed tenant by tenant while other tenants still reference them.

## Offline escrow and access policy

Use age v1-format encryption with TWO dedicated Owner-approved recipients whose private identities are stored separately from Railway and from the encrypted database backup. Do not reuse the operational SSH authentication key for long-lived evidence escrow. The Owner may control both independent offline recovery paths or designate a second custodian; no person is silently granted access.

Future protected-device commands, after separate authorization and tool/recipient verification:

    age.exe -r <PRIMARY_PUBLIC_AGE_RECIPIENT> -r <OFFLINE_BACKUP_PUBLIC_AGE_RECIPIENT> -o keyring-v2.json.age keyring-v2.json
    age.exe -d -i <OFFLINE_IDENTITY_FILE> -o <OWNER_ONLY_TEMP_PATH> keyring-v2.json.age

Place ciphertext in two independent existing durable stores. The decrypt identity must not be in the same account/storage plane, image, repository, CI secret or Railway variable as the database/keyring it protects. Retain a content-free inventory: escrow ciphertext SHA-256, key IDs, creation time, custody owner and last restore rehearsal. Do not publish an unkeyed hash of raw keyring plaintext.

age is an offline utility, not a new external recipient/service. No production escrow or recovery identity was generated here. Public utility documentation supports multiple recipients and stable v1 recovery; actual recipient custody requires Owner acceptance.

## Recovery rehearsal and compromise response

Isolated rehearsal already exercises SQL dump/restore with retained historical keys loaded through the same sealed-provider abstraction, wrong/missing key rejection and exact candidate readers. A real provider backup, matching encrypted escrow and Owner-held identities are still required for production acceptance.

Production DR procedure (not executed): preserve the affected deployment/ciphertext; verify the selected database backup identity and encrypted escrow hash; obtain the correct approved offline identity; restore into an authorized isolated target; load keys in memory through a protected channel; verify original snapshots, receipts and held/unsubmitted evidence; reconcile tombstones/holds before access; obtain independent acceptance before any traffic/activation change. Do not restore over the current production service as a test.

On compromise, contain access, retain evidence and historical roots, rotate via the two phases, inventory affected key IDs/scopes, and coordinate separately authorized rewrapping if required. Escrow loss, invalid recipient identity or missing historical keys is a blocked recovery, not permission to recreate answers or silently discard ciphertext.

## Primary sources reviewed 25 November 2026

- Railway variables: https://docs.railway.com/variables — sealing controls visibility, not build availability.
- Railway build/runtime isolation: https://railway.com/guides/build-time-vs-runtime-secrets — Railpack exposure versus Docker ARG opt-in; runtime variables need no secret Dockerfile instruction.
- Railway security/backups: https://docs.railway.com/enterprise/security — platform encryption differs from independent key custody and demonstrated restoration.
- age manual: https://github.com/FiloSottile/age/blob/main/doc/age.1.ronn — multi-recipient offline encryption/recovery.
