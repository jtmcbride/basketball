# Hosting on Oracle Cloud (Oracle Linux 9)

`cloud-init.yaml` turns a fresh OL9 instance into a running site: uv + Python 3.13,
Node 24 (or 22), the repo checked out at `/opt/basketball/app`, the UI built
same-origin, uvicorn behind Caddy (`/` = UI, `/api/*` = API), and automatic HTTPS
when a domain is set.

## 1. Create the instance

- Image: **Oracle Linux 9**. Shape: `VM.Standard.A1.Flex` (Ampere, arm64) works
  well — 1 OCPU / 6 GB is plenty. x86 shapes work too. Smaller than 4 GB RAM
  gets a 4 GB swapfile automatically.
- Boot volume: the default ~47 GB is fine. The data is ~100 MB; `.venv`,
  `node_modules` and the uv Python cache add a few GB.
- Edit the `deploy.env` block at the top of `cloud-init.yaml` (`REPO_URL`,
  `GIT_TOKEN` for a private repo, `DOMAIN`), then paste it into
  *Show advanced options → Management → Paste cloud-init script*.
- **Networking:** in the VCN's security list (or an NSG), add stateful ingress
  rules for TCP **80** and **443** from `0.0.0.0/0`. The script opens firewalld
  on the host, but OCI blocks these ports at the VCN until you allow them.
- If `DOMAIN` is set, point its A record at the instance's public IP *before*
  booting, or Caddy's certificate request fails (it retries, so fixing DNS
  later also works).

Boot takes ~5–10 minutes. Follow it with
`ssh opc@<ip> sudo tail -f /var/log/cloud-init-output.log`.

## 2. Ship the data

The DuckDB catalogs and model are not in git. Build them locally (`make audit`,
`make atlas`, `make actions`, `make lineups`, `make shot-model`), then push:

```sh
deploy/oci/push-data.sh opc@<public-ip>
```

This rsyncs `data/{db,models}` and restarts the API. `data/raw`, `data/lake`,
`data/exports` and `data/inspection` stay local — the API never reads them.

Alternatively, `deploy/oci/push-data.sh --tar data.tar.gz`, upload it to an
Object Storage bucket, create a pre-authenticated request, and set
`DATA_TARBALL_URL` before first boot.

## 3. Updating

```sh
ssh opc@<ip> sudo basketball-deploy          # pull main, uv sync, npm build, restart
deploy/oci/push-data.sh opc@<ip>             # after a local rebuild
```

## Notes

- The actions, lineups and shot-model stores record the SHA-256 of the module
  that built them and refuse to load if the server's code differs. After changing
  `actions.py`, `lineups.py` or `shot_model.py`, rebuild locally and push the data
  in the same go as `basketball-deploy`.
- The API opens every DuckDB file read-only, so pushing data while it runs is
  safe; the restart picks up new metadata.
- Logs: `journalctl -u basketball-api -f`, `journalctl -u caddy -f`.
  Health: `curl localhost:8007/health` on the box, or `https://<domain>/api/health`.
- `GIT_TOKEN` stays readable via the instance metadata endpoint for the life of
  the instance, and is stored in `/opt/basketball/.git-credentials`. Use a
  fine-grained, read-only token scoped to this repo.
