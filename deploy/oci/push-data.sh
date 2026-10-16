#!/usr/bin/env bash
# Ship the locally built data (duckdb catalogs + models, ~100 MB) to the server.
# data/raw, data/lake, data/exports and data/inspection are NOT sent: the API
# only reads data/db/*.duckdb and data/models/; the rest is only needed to rebuild.
#
#   deploy/oci/push-data.sh opc@<public-ip>   rsync straight to the instance
#   deploy/oci/push-data.sh --tar out.tar.gz  build a tarball for DATA_TARBALL_URL
#                                             (upload to Object Storage, make a PAR)
set -euo pipefail
cd "$(dirname "$0")/../.."
DIRS=(db models)

if [ "${1:-}" = "--tar" ]; then
  out=${2:?usage: push-data.sh --tar out.tar.gz}
  COPYFILE_DISABLE=1 tar -czf "$out" --exclude .DS_Store -C data "${DIRS[@]}"
  ls -lh "$out"
  exit 0
fi

host=${1:?usage: push-data.sh opc@<host> | --tar out.tar.gz}
# Writes land as the `basketball` user. Copy while no local build (`make audit`,
# `make atlas`, ...) is writing to the duckdb files.
rsync -az --delete --progress --exclude .DS_Store \
  --rsync-path="sudo -u basketball rsync" \
  "${DIRS[@]/#/data/}" "$host:/opt/basketball/app/data/"
# The API caches catalog metadata at startup; restart to pick up new files.
ssh "$host" sudo systemctl restart basketball-api
