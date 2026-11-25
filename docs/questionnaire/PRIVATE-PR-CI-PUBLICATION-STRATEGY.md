# Private source review / CI publication strategy

Status: prepared, NOT published or executed remotely. No repository creation, branch push, workflow dispatch, protection change, deployment or service purchase performed.

## Observed side effects and recommended route

All three application repositories are public. Backend GitHub push triggers its test workflow; frontend main pushes and workflow_dispatch trigger Pages; Railway watches backend main. Receiving or approving this package does not authorize any public branch or main push. Workflow files under docs are inert templates.

Recommend an Owner-approved existing private review repository (or separately authorized private repository creation) with NO Railway/Pages hosting integration and no production secrets. Import only the reviewed private artifact/source bundles, not production env files or runtime data. Private CI consumes the candidate ZIP at an independently supplied SHA-256, verifies every package/source hash, reconstructs all three Git histories and runs the actual PostgreSQL/browser tests. It needs contents:read only; no pages/id-token/environment/deployment permission. Checkout credentials are not persisted.

Prepared templates: review-ci/review-only.yml.template and run-private-review.sh. Actions are pinned to verified upstream commit identities: checkout v4.2.2 11bd71901bbe5b1630ceea73d27597364c9af683, setup-node v4.4.0 49933ea5288caeca8642d1e84afbd3f7d6820020, upload-artifact v4.6.2 ea165f8d65b6e75b540449e92b4886f43607fa02. Private evidence retention proposed 7 days; no screenshots or private key fixtures are uploaded. GitHub plan/runner cost limits must be approved before remote execution; no paid capacity is assumed.

Required private-repo layout after explicit authorization:

    .github/workflows/review-only.yml       (reviewed inert template installed deliberately)
    review-ci/run-private-review.sh
    review-input/candidate.zip              (exact independently reviewed archive)

Select workflow_dispatch and supply the independently reviewed archive SHA-256. Never use pull_request_target to run untrusted code with secrets. No repository_dispatch or automatic deployment workflow is included. If a target repository already has hosting/integration permissions or workflows, inspect them before the first push instead of assuming it is isolated.

## Production publication remains a separate gate

After private review/CI, independent acceptance and explicit Owner authorization: inspect the exact application repository integrations, protections and workflow triggers again; approve public disclosure of the reviewed source; publish only the accepted heads; create the scoped PRs; require checks; then separately authorize coordinated merge/migration/configuration/deployment. A green private CI run alone does not authorize any of these actions.

Keep backend Wait for CI/branch-protection changes in the production authorization manifest. Do not toggle them during this preparation. A frontend workflow_dispatch is a deployment trigger, not a harmless way to obtain tests.

## Runtime-secret image gate

The Dockerfile/dockerignore templates implement the recommended build/runtime trust separation but are NOT active configuration. No local Docker daemon is available here, and no cloud build was provisioned. The image build and native PDF/runtime-secret canary must run in the approved private CI context before actual key provisioning. Verify the image digest, dependencies, missing secret ARG/ENV and absence of secret material from build output/layers. Keep the normal full synthetic test matrix. This remaining external execution depends on Owner authorization of the private review target/build change; it is not recorded as PASS.

Source: Railway autodeploy documentation https://docs.railway.com/deployments/github-autodeploys ; runtime build isolation https://railway.com/guides/build-time-vs-runtime-secrets . Actual application workflow/source inspection is authoritative for this project.
