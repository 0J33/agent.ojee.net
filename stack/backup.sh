#!/bin/bash
# Backs up Open WebUI + n8n volumes + dashboard .env to /media/ojee/NVME/backups/stack/
# Keeps last 14 backups, rotates daily.
set -e
SRC_COMPOSE=/home/ojee/stack
DEST=/media/ojee/NVME/backups/stack
DATE=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST"

# Export docker volumes to tar via temp container
backup_vol () {
  local vol=$1
  docker run --rm -v "${vol}:/src:ro" -v "${DEST}:/dst" alpine \
    sh -c "cd /src && tar czf /dst/${vol}-${DATE}.tar.gz ."
}

backup_vol stack_openwebui_data
backup_vol stack_n8n_data

# config snapshot (compose + nginx + dashboard sources)
tar czf "${DEST}/config-${DATE}.tar.gz" -C "$(dirname $SRC_COMPOSE)" "$(basename $SRC_COMPOSE)"

# rotate: keep last 14 of each type
for prefix in openwebui n8n config; do
  ls -t "${DEST}"/${prefix}*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
done

echo "[$(date -Is)] backup complete -> ${DEST}"
