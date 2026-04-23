#!/bin/bash
# Configure CouchDB for Obsidian Self-hosted LiveSync.
# Idempotent — safe to re-run.  Reads COUCHDB_USER/PASSWORD from the
# couchdb container's environment.
#
# Usage: ./init.sh            (from the stack directory)
#        ./init.sh obsidian   (also create/reset the named vault DB)

set -eu

HOST=${HOST:-http://127.0.0.1:5984}
DB=${1:-obsidian}

# Pull creds from the running container so we don't duplicate them in .env logic.
USER=$(docker exec couchdb printenv COUCHDB_USER)
PASS=$(docker exec couchdb printenv COUCHDB_PASSWORD)
AUTH="-u $USER:$PASS"

exec_curl() {
  docker exec couchdb curl -sS "$@"
}

echo "Applying LiveSync config to $HOST..."

# CORS + body size + single-node setup.  Each PUT returns the previous
# value or an empty string — we don't care, just make sure it's idempotent.
put_cfg() {
  local section=$1 key=$2 val=$3
  exec_curl $AUTH -X PUT "$HOST/_node/_local/_config/$section/$key" \
    -H 'Content-Type: application/json' -d "\"$val\"" > /dev/null
}

put_cfg chttpd enable_cors true
put_cfg chttpd max_http_request_size 4294967296
put_cfg chttpd require_valid_user true
put_cfg chttpd_auth require_valid_user true
put_cfg cors credentials true
put_cfg cors origins 'app://obsidian.md,capacitor://localhost,http://localhost'
put_cfg cors headers 'accept, authorization, content-type, origin, referer'
put_cfg cors methods 'GET, PUT, POST, HEAD, DELETE'
put_cfg couchdb max_document_size 50000000

# Ensure system databases exist (single-node requirement).
for sysdb in _users _replicator; do
  exec_curl $AUTH -X PUT "$HOST/$sysdb" > /dev/null || true
done

# Create the vault DB if missing.  LiveSync expects to find it empty
# or already populated — either way is fine.
if ! exec_curl $AUTH "$HOST/$DB" | grep -q '"db_name"'; then
  echo "Creating vault database: $DB"
  exec_curl $AUTH -X PUT "$HOST/$DB" > /dev/null
else
  echo "Vault database '$DB' already exists."
fi

echo "Done.  LiveSync plugin connection URL: https://sync.agent.ojee.net/"
echo "Database:  $DB"
echo "Username:  $USER"
echo "Password:  (from stack .env COUCHDB_PASSWORD)"
