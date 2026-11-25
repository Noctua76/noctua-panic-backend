#!/usr/bin/env bash
# Run in the existing PostgreSQL service. No operational row or credential is printed.
set -Eeuo pipefail
umask 077
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}" PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-railway}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
AegisBackupRoot="${AEGIS_BACKUP_ROOT:-/var/lib/postgresql/data/aegis-release-backups}"
AegisStep=PRECHECK; AegisRestoreDb=''; AegisOk=false; AegisRestoreClosed=null
AegisStamp="$(date -u +%Y%m%dT%H%M%SZ)_$(openssl rand -hex 4)"
AegisDir="$AegisBackupRoot/$AegisStamp"
finish(){
 local status=$?
 if [[ -n "$AegisRestoreDb" ]]; then
  if timeout 10 psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "REVOKE CONNECT ON DATABASE \"$AegisRestoreDb\" FROM PUBLIC; ALTER DATABASE \"$AegisRestoreDb\" ALLOW_CONNECTIONS false" >/dev/null 2>&1; then AegisRestoreClosed=true; else AegisRestoreClosed=false; AegisOk=false; status=1; fi
 fi
 printf '\nAEGIS_BACKUP_RECEIPT_BEGIN\n'
 printf '{"version":1,"success":%s,"lastStep":"%s","exitCode":%s,"archivePath":"%s/production.dump","restoreDatabase":"%s","productionIncidentWrites":0,"restoreConnectionsDisabled":%s}\n' "$AegisOk" "$AegisStep" "$status" "$AegisDir" "$AegisRestoreDb" "$AegisRestoreClosed"
 printf 'AEGIS_BACKUP_RECEIPT_END\n'
 trap - EXIT
 exit "$status"
}
trap finish EXIT
for tool in pg_dump pg_restore psql createdb timeout sha256sum awk sort cmp openssl; do command -v "$tool" >/dev/null; done
[[ "$PGDATABASE" =~ ^[a-zA-Z0-9_]+$ && "$AegisBackupRoot" =~ ^/[a-zA-Z0-9_./-]+$ ]]
mkdir -p "$AegisBackupRoot"; chmod 700 "$AegisBackupRoot"; mkdir "$AegisDir"
AegisSize="$(timeout 10 psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT pg_database_size(current_database())')"
AegisFreeKb="$(df -Pk "$AegisDir" | awk 'NR==2 {print $4}')"
[[ "$AegisSize" =~ ^[0-9]+$ && "$AegisFreeKb" =~ ^[0-9]+$ ]]
(( AegisFreeKb*1024 > AegisSize*2+134217728 ))
AegisStep=DUMP
# A consistent native archive, kept owner-only on the existing persistent volume.
timeout --kill-after=5 180 pg_dump --format=custom --compress=6 --no-owner --no-acl --file "$AegisDir/production.dump" 2>"$AegisDir/dump-diagnostics.log"
chmod 600 "$AegisDir/production.dump"
sha256sum "$AegisDir/production.dump" > "$AegisDir/production.dump.sha256"
timeout 30 pg_restore --list "$AegisDir/production.dump" > "$AegisDir/archive-index.txt"
AegisStep=ARCHIVE_ROW_INVENTORY
# Only table names/counts survive the local stream; COPY data is never printed or exported.
timeout 60 pg_restore --data-only --file=- "$AegisDir/production.dump" 2>"$AegisDir/archive-inventory.log" | awk '
 /^COPY public\./ {t=$2;n=0;copy=1;next}
 copy && /^\\\.$/ {print t "\t" n;copy=0;next}
 copy {n++}
' | sort > "$AegisDir/archive-counts.tsv"
AegisRestoreDb="aegis_release_restore_${AegisStamp,,}"
[[ "$AegisRestoreDb" =~ ^aegis_release_restore_[a-z0-9_]+$ ]]
AegisStep=RESTORE
# This clone has no app deployment, workers, or notification listeners.
timeout 20 createdb --template=template0 --owner="$PGUSER" "$AegisRestoreDb" 2>"$AegisDir/create-restore.log"
timeout --kill-after=5 180 pg_restore --exit-on-error --no-owner --no-privileges --dbname="$AegisRestoreDb" "$AegisDir/production.dump" >"$AegisDir/restore.log" 2>&1
AegisStep=VERIFY_RESTORED_ROWS
# Output contains counts only, never row values.
timeout 30 psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -d "$AegisRestoreDb" > "$AegisDir/restored-counts.tsv" <<'SQL'
SELECT format('SELECT %L, count(*)::bigint FROM %I.%I;', 'public.'||tablename,'public',tablename)
FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
SQL
sort -o "$AegisDir/restored-counts.tsv" "$AegisDir/restored-counts.tsv"
cmp --silent "$AegisDir/archive-counts.tsv" "$AegisDir/restored-counts.tsv"
sha256sum --check --status "$AegisDir/production.dump.sha256"
AegisStep=VERIFIED_BACKUP_AND_RESTORE
AegisOk=true
printf 'AEGIS_BACKUP_HASH_BEGIN\n'; cat "$AegisDir/production.dump.sha256"; printf 'AEGIS_BACKUP_HASH_END\n'
