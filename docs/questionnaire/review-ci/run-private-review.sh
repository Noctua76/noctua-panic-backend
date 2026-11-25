#!/usr/bin/env bash
set -euo pipefail
archive=${1:?Candidate archive required}
expected=${2:?Reviewed archive SHA-256 required}
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo INVALID_ARCHIVE_SHA256; exit 2; }
actual=$(sha256sum "$archive" | cut -d' ' -f1)
[[ "${expected,,}" == "$actual" ]] || { echo ARCHIVE_HASH_MISMATCH; exit 2; }
review_root=$(mktemp -d)
mkdir -p review-results/native
export AEGIS_TEST_ARTIFACT_DIR="$PWD/review-results/native"
export AEGIS_PWSH_PATH=$(command -v pwsh)
python3 - "$archive" "$review_root" <<'PY'
import sys,zipfile,pathlib,hashlib,json
archive,target=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
 for info in z.infolist():
  p=pathlib.PurePosixPath(info.filename)
  assert not p.is_absolute() and '..' not in p.parts and (info.external_attr>>16)&0o170000!=0o120000
 z.extractall(target)
root=pathlib.Path(target);m=json.loads((root/'PACKAGE-MANIFEST.json').read_text())
for name,h in m['files'].items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==h,name
PY
for repo in backend dashboard guard-webapp; do
  case "$repo" in
    backend) remote=noctua-panic-backend;; dashboard) remote=aegis-link-dashboard;; guard-webapp) remote=noctua-panic-webapp;;
  esac
  git clone --quiet --no-checkout "https://github.com/Noctua76/$remote.git" "$review_root/repos/$repo"
  git -C "$review_root/repos/$repo" bundle verify "$review_root/sources/$repo.bundle"
  git -C "$review_root/repos/$repo" fetch "$review_root/sources/$repo.bundle" HEAD
  head=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repositories"][sys.argv[2]]["commit"])' "$review_root/sources/SOURCE-MANIFEST.json" "$repo")
  git -C "$review_root/repos/$repo" checkout --detach "$head"
done
python3 - "$review_root" <<'PY'
import pathlib,hashlib,json,sys,subprocess
r=pathlib.Path(sys.argv[1]);m=json.loads((r/'sources/SOURCE-MANIFEST.json').read_text())
for repo,v in m['repositories'].items():
 root=r/'repos'/repo
 assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD^{tree}']).decode().strip()==v['tree']
 for name,h in v['sourceFiles'].items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==h,(repo,name)
PY
npm ci --prefix "$review_root/tooling" --ignore-scripts --no-audit --no-fund
export PATH="$review_root/tooling/node_modules/node-linux-x64/bin:$PATH"
lib="$review_root/tooling/node_modules/@embedded-postgres/linux-x64/native/lib"
for n in libicui18n libicuuc libicudata; do ln -s "$n.so.60.2" "$lib/$n.so.60"; done
curl --fail --max-time 90 --retry 2 'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-client-18_18.7-1.pgdg13%2B5_amd64.deb' -o "$review_root/tooling/pg-client.deb"
curl --fail --max-time 90 --retry 2 'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/libpq5_18.7-1.pgdg13%2B2_amd64.deb' -o "$review_root/tooling/libpq.deb"
dpkg-deb -x "$review_root/tooling/pg-client.deb" "$review_root/tooling/pg-client"
dpkg-deb -x "$review_root/tooling/libpq.deb" "$review_root/tooling/pg-client"
for repo in backend dashboard; do (cd "$review_root/repos/$repo" && npm ci --no-audit --no-fund); done
node "$review_root/repos/backend/node_modules/@puppeteer/browsers/lib/main-cli.js" install chrome-headless-shell@143.0.7499.0 --path "$review_root/tooling/chromium"
python3 - "$review_root/tooling" <<'PY'
import pathlib,json,hashlib,sys
r=pathlib.Path(sys.argv[1]);m=json.loads((r/'TOOLING-MANIFEST.json').read_text())
for name,h in m['checksums'].items():assert hashlib.sha256((r/name).read_bytes()).hexdigest()==h,name
PY
for repo in backend dashboard guard-webapp; do
  (cd "$review_root/repos/$repo" && bash "$review_root/tooling/run-isolated.sh" node --test) > "review-results/$repo.tap" 2>&1
done
(cd "$review_root/repos/backend" && bash "$review_root/tooling/run-isolated.sh" node --test security-tests/guard-engine.browser.cjs) > review-results/guard-browser.tap 2>&1
(cd "$review_root/repos/dashboard" && bash "$review_root/tooling/run-isolated.sh" node --test security-tests/*.browser.mjs) > review-results/dashboard-browser.tap 2>&1
(cd "$review_root/repos/dashboard" && timeout 90 npm run build) > review-results/dashboard-build.log 2>&1
# No production secrets, GitHub write permission, environment, deployment, merge or dispatch command exists in this job.
