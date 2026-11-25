# Recommended policy for Owner approval — no destructive jobs activated

These are operational recommendations, not assertions of a mandatory Greek/EU retention period. The controller must justify necessity against each tenant's purpose, contract, legal obligations and legal claims. Approval of a recommendation does not authorize production configuration/deletion; those require a separate accepted rollout/disposition.

| Data class | Recommended policy | Protection / disposition |
|---|---|---|
| Final incident answers/snapshots | Review necessity 12 months after closure; proposed default maximum 12 months only where tenant contract/legal assessment supports it. | Keep the complete incident record together; legal hold/ongoing claim overrides expiry. No independent questionnaire deletion. |
| Published versions referenced by incidents | Retain while ANY retained incident/backup/hold references them. | Never overwrite/remove an old version because a new one was published. |
| Unreferenced configuration drafts | Review after 90 days inactivity. | Owner/tenant-approved disposition only; never confuse with unsubmitted incident evidence. |
| Unsubmitted incident drafts | Flag after 72 hours inactivity; escalate for designated review after 30 days. | These are review deadlines, NOT deletion deadlines. No silent deletion or reassignment. |
| Redundant server draft after verified final commit | Eligible 24 hours after verified final receipt AND canonical submission validation. | Purge redundant payload only under approved policy and absent hold; preserve committed facts/receipt. Default cleanup remains disabled. |
| Local sealed outbox | Remove only after verified final receipt and durable server custody/readback as applicable. | A lost receipt/offline restart/expired session is not authority to clear storage. |
| Minimal receipt/tombstone metadata | Proposed 7 days after verified disposition, extended for replay/hold obligations. | No answer/question plaintext; do not remove metadata needed to prevent evidence resurrection. |
| Content-free security audit | Proposed 12 months. | Tenant-scoped access, bounded reason codes, no prompts/answers/tokens/keys. |
| Application/access diagnostics | Proposed 7 days, content-free only. | Record event/status/SQLSTATE; no URL/query/body, location, IDs, names, phones, raw exceptions or tokens. Verify actual plan retention; no subscription upgrade implied. |
| Backups | Recommended existing Railway daily + weekly + monthly schedules, subject to actual plan/volume/cost review. Provider defaults documented as 6/27/89 days. | Verify actual enabled schedules and encryption/restore; documentation alone is not execution evidence. Legal hold needs an explicit preserved recovery copy. |
| Encryption roots and escrow | Until the final decryptable reference and protected backup/hold expire safely. | No timer-based key destruction. Rotation does not permit deletion of prior roots. |

## Recovery authority recommendation

Create a designated tenant Evidence Reviewer role/capability, assigned only to named Owner-approved people. Required conjunction: `incidents.manage` AND **explicit** `questionnaires.recover`, active authenticated session, correct effective company and valid mutating tenant context. Generic `*` and System Owner status alone do not grant evidence recovery. The implementation now enforces this exception and re-reads/revocation-locks grants before decryption.

- A Guard can restore only the original still-valid incident/site/Guard/session. A later session of the same Guard cannot inherit authorship.
- Expired/revoked-session evidence goes to the designated reviewer with `SESSION_EXPIRED_REVIEW` or `OPERATIONAL_EVIDENCE_REVIEW`, a mandatory reason and content-free audit record.
- Review returns visibly UNSUBMITTED_EVIDENCE. The reviewer cannot impersonate the original Guard, insert a final Guard statement or rewrite a captured snapshot.
- Platform Owner recovery requires the same explicit capability plus an authorized effective-tenant context/elevation. No home-platform unscoped access.
- Recovery permission does not grant private-key export, global configuration publication, automatic retention approval or notification dispatch.

## Legal holds and controlled disposition

Recommend case-level holds over the incident, snapshot/answers, unsubmitted/committed custody, relevant audit and matching recovery material. The hold record should identify tenant, case reference, approver, reason category, scope, placed/reviewed/released times and next review (90 days proposed). Case text and evidence remain in authorized storage, not logs.

Only designated tenant legal/incident authority plus Owner-approved disposition can release a hold. An application administrator, reviewer, crypto-key rotation or elapsed time must not release one implicitly. A hold blocks redundant cleanup and any final evidence/key disposition. Synthetic database tests prove held redundant drafts remain, while unsubmitted drafts are never destroyed by cleanup.

Current code has legal-hold-aware storage and cleanup default OFF; a production hold-administration UI/job and exact policy/grants are not activated by this proposal. Before activating a destructive policy, the approved audited hold/disposition procedure must be implemented/reviewed against the actual catalog. No ad-hoc direct SQL deletion is authorized.

After a backup restore, reconcile all subsequent holds, explicit dispositions and tombstones before reopening access; restoring an old snapshot must not silently resurrect data already lawfully disposed of or drop a newer hold.

## Decisions requested when reviewing this proposal

Approve/amend the periods and purpose per tenant; designate actual recovery/hold decision-makers; confirm escrow custodians and acceptable RPO/RTO; authorize any provider retention adjustment separately. Recommended starting recovery targets for approval: RPO <=24h only if daily backups are verified, and RTO <=4h only after a timed Owner-controlled restore rehearsal. These targets have not been demonstrated in production.

Sources: European Commission storage-limitation guidance https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/principles-gdpr_en ; Railway backup defaults https://docs.railway.com/volumes/backups . No source supplies a universal incident-retention period; the proposed 12-month review/maximum requires the controller's justification.
