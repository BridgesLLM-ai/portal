# DEPLOYMENT.md

## Canonical Public Portal
- **Public URL:** `https://bridgesllm.com`
- **Reverse proxy:** Caddy (`/etc/caddy/Caddyfile`)
- **Public upstream:** `127.0.0.1:4001`
- **Live service:** `bridgesllm-product.service`
- **Live working directory:** `/root/bridgesllm-product/backend`
- **Live command:** `/usr/bin/node dist/server.js`

## Important Reality Check
The public site is **not** served from the Docker backend on port `3002`.
It is served by the systemd service above on port `4001`.

Before changing the portal, verify all four:
1. `systemctl status bridgesllm-product.service`
2. `ss -ltnp | grep ':4001'`
3. `readlink -f /proc/$(ss -ltnp | sed -n 's/.*pid=\([0-9]\+\).*:4001.*/\1/p' | head -1)/cwd`
4. `curl -k https://bridgesllm.com | head`

## Docker Stacks Also Present
These exist on the machine and can confuse changes if you assume they are public prod:
- `/root/portal-production`
- `/root/bridgesllm-product` docker-compose stack (`3001`, extra containers)

Treat them as **non-canonical** unless/until the public reverse proxy is explicitly moved to them.

## Safe Deployment Procedure
### Frontend changes
1. Edit files in `/root/bridgesllm-product/frontend`
2. Run: `npm run build` in `/root/bridgesllm-product/frontend`
3. Restart: `systemctl restart bridgesllm-product.service`
4. Verify asset hash changed in `https://bridgesllm.com`

### Backend changes
1. Edit files in `/root/bridgesllm-product/backend/src`
2. Run: `npm run build` in `/root/bridgesllm-product/backend`
3. Restart: `systemctl restart bridgesllm-product.service`
4. Verify logs: `journalctl -u bridgesllm-product.service -n 100 --no-pager`

## Recovery Plan
- File snapshots: `/root/portal-recovery/2026-03-12/`
- Git rollback: `git -C /root/bridgesllm-product log --oneline -n 10`
- Service rollback: rebuild previous commit, then `systemctl restart bridgesllm-product.service`
- Caddy rollback: restore `/root/portal-recovery/2026-03-12/Caddyfile.before` to `/etc/caddy/Caddyfile`, then `systemctl reload caddy`

## Recommendation
Long term, retire or archive the duplicate portal stacks so only one repo is treated as real production.
