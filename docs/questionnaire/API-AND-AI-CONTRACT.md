# Questionnaire contract and extension boundary

Protocol 2: immutable incident/snapshot/digest identity; UUID question IDs; 1–12 SHORT_TEXT/LONG_TEXT questions; explicit required flags and code-point limits; 64 KiB canonical plaintext / 96 KiB envelope bound. Authoritative validation lives in questionnaire/contract.js. All sensitive module responses are private,no-store. No operational plaintext belongs in logs or telemetry.

| Resource | Methods / required capability |
|---|---|
| /settings/sites/:siteId/incident-questionnaire | GET sites.view AND questionnaires.view |
| .../draft | GET as above; PUT sites.manage AND questionnaires.draft |
| .../publish | POST sites.manage AND questionnaires.publish |
| .../restore-default | POST sites.manage AND questionnaires.restore |
| .../versions/:versionId | GET sites.view AND questionnaires.view; assignment history must prove site ownership |
| .../audit | GET sites.view AND questionnaires.view AND audit_logs.view |
| /settings/incident-questionnaire-default | GET sites.view AND questionnaires.view |
| /admin/incident-questionnaire-defaults | GET/POST fresh system owner, platform_questionnaires.manage, home platform context |
| /settings/incidents/:incidentId/(legacy-)questionnaire-recovery | POST incidents.manage AND questionnaires.recover; scoped original authorship and audited reason |
| /guard/questionnaire-capabilities | GET authenticated Guard; protocol/feature negotiation, no sensitive content |
| /guard/questionnaire-storage-key | GET original authenticated Guard context, public wrapping key only |
| /guard/questionnaire-pending | GET same original authenticated session |
| /guard/incidents/:incidentId/questionnaire | GET exact incident/company/site/Guard/original active session |
| .../questionnaire-draft | GET/PUT same identity; encrypted revisioned custody packet |
| .../legacy-questionnaire-draft | GET/PUT accepted legacy temporal ownership; never fabricate a version |
| .../questionnaire-submission | POST exact snapshot, canonical answers/omissions and client submission UUID |
| .../questionnaire-receipt-recovery | POST sealed packet; exact committed-fact verification, including resolved replay |

Definition write = {expectedRevision,content:{title,questions:[{id,prompt,help?,type,required,maxLength}]}}. Publish = {expectedDraftRevision,expectedAssignmentRevision}. Restore = {expectedAssignmentRevision,reason}. Client-supplied provenance/published-state/ownership fields are rejected.

Custody write = {draftId,expectedRevision,revision,envelope}. Envelope v1 = {version,algorithm,keyId,aad,iv,wrappedKey,ciphertext,tag}. AAD binds scope/purpose and complete original flow identity and revision. Decrypted dynamic checkpoint = {protocolVersion:2,snapshotId,snapshotDigest,answers:[{questionId,value}]}; partial/empty drafts remain explicitly unsubmitted. Receipt binds original session, draft/revision, payload fingerprint and authenticated envelope digest. Browser only claims local durability after IndexedDB transaction completion, and server custody after receipt verification. Offline restart cannot decrypt previous content without online original-session authorization.

Final write = {protocolVersion:2,snapshotId,snapshotDigest,clientSubmissionId,answers,omittedOptionalQuestionIds}. Final receipt binds server submission UUID, incident/snapshot/digest, canonical fingerprint, answered count and omissions. Identical replay returns the stored receipt even after incident resolution; conflicting content fails. A first finalization after closure does not manufacture Guard statements; checkpoint custody is retained for review.

Errors = {status:'error',code,recoverable,responsesSaved:false} for module failures. 401/403 reject identity/permissions; 404 hides foreign resources; 409 signals revisions, conflicts, closed incidents or required client upgrade; 413 bounds payload; 422 rejects malformed fields/types; 503 preserves an explicit recoverable subsystem failure. Raw database/key/browser diagnostics never go to module clients. Audit rejection uses a separate transaction and bounded code-only reason; audit failure cannot block panic dispatch.

## Future AI extension — inactive contract, no integration

PLATFORM_DEFAULT and COMPANY_CUSTOM are supported published origins. AI_GENERATED is reserved for a separate incident-linked proposed extension, not a valid way to mutate a published definition or historical snapshot. No provider call, new credential, AI endpoint or automatic publication is implemented or enabled.

A future proposal must include an opaque proposal ID, current tenant/site/incident and actor authorization context supplied by the server, immutable base snapshot ID/digest, stable proposed question IDs and validated text/type/required/length/order. Its own immutable extension ID and provenance record must remain separate from base questions and final Guard facts. Only narrowly authorized context may be retrieved. Treat every retrieved SOP, prompt and response as untrusted data; their text cannot grant tools or permissions. Reauthorize before every retrieval or mutation; require a designated human decision before permanent publication. Reject requests to elevate privileges, overwrite history, transmit unrestricted content or dispatch notifications. This is a contract to guide a separately approved future implementation, not currently operational functionality.
