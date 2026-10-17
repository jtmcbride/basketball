#!/usr/bin/env bash
# Ship the locally built data (duckdb catalogs + models + the arcs export,
# ~100 MB) to the server. data/raw, data/lake, data/inspection and the rest of
# data/exports are NOT sent: the API only reads data/db/*.duckdb, data/models/
# and data/exports/arcs-v1.json; the rest is only needed to rebuild.
#
#   deploy/oci/push-data.sh opc@<public-ip>   rsync straight to the instance
#   deploy/oci/push-data.sh --tar out.tar.gz  build a tarball for DATA_TARBALL_URL
#                                             (upload to Object Storage, make a PAR)
set -euo pipefail
cd "$(dirname "$0")/../.."
# The arcs export records the SHA-256 of basketball.duckdb and refuses to load
# against any other catalog, so it must travel with db/ every time.
DIRS=(db models)
FILES=(exports/arcs-v1.json)
PATHS=("${DIRS[@]}" "${FILES[@]}")

for p in "${PATHS[@]}"; do
  if [ ! -e "data/$p" ]; then
    echo "push-data: data/$p is missing; build it first (see README: make audit, make arcs, ...)" >&2
    exit 1
  fi
done

if [ "${1:-}" = "--tar" ]; then
  out=${2:?usage: push-data.sh --tar out.tar.gz}
  COPYFILE_DISABLE=1 tar -czf "$out" --exclude .DS_Store -C data "${PATHS[@]}"
  ls -lh "$out"
  exit 0
fi

host=${1:?usage: push-data.sh opc@<host> | --tar out.tar.gz}
# Writes land as the `basketball` user. Copy while no local build (`make audit`,
# `make atlas`, ...) is writing to the duckdb files. Run from inside data/ so
# --relative keeps exports/ and creates it on the server (not the data/./
# marker: macOS's openrsync ignores it and nests data/data/). Two calls because
# openrsync's --delete also prunes the siblings of a single file sent with
# --relative, which would wipe the rest of the server's exports/.
rsync_bk() { rsync -az --relative --progress --exclude .DS_Store \
  --rsync-path="sudo -u basketball rsync" "$@"; }
(cd data && rsync_bk --delete "${DIRS[@]}" "$host:/opt/basketball/app/data/" \
  && rsync_bk "${FILES[@]}" "$host:/opt/basketball/app/data/")
# The API caches catalog metadata at startup; restart to pick up new files.
ssh "$host" sudo systemctl restart basketball-api
