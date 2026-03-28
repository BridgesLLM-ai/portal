# Administration

Portal admin features. Page: `/admin`. Requires admin or owner role.

## User Management

### Roles
- **owner**: Full access, can transfer ownership, manage all settings
- **admin**: Most admin functions, can manage users and agents
- **user**: Standard access — chat, files, projects, mail
- **viewer**: Read-only access to dashboard

### Registration Flow
1. User registers at `/login` (register tab)
2. Request goes to pending state
3. Admin/owner approves or denies at `/admin` → Registration Requests
4. Approved users get mail account auto-created in Stalwart

### API (`/api/admin/`)
- `GET /users` — List all users
- `GET /users/<id>` — Get user details
- `PATCH /users/<id>` — Update user (role, status)
- `DELETE /users/<id>` — Delete user (owner only)
- `POST /users/<id>/transfer-ownership` — Transfer owner role
- `GET /registration-requests` — List pending registrations
- `POST /registration-requests/<id>/approve` — Approve with optional role
- `POST /registration-requests/<id>/deny` — Deny with optional reason

## System Updates

- `GET /update-status` — Check for available updates
- `POST /check-updates` — Trigger update check
- `POST /self-update` — Run self-update (pulls latest, rebuilds, restarts)
- `GET /self-update/log` — Stream update progress

## Settings

- `GET /settings` — Get system settings (appearance, notifications, etc.)
- `PUT /settings` — Update settings
- `POST /settings/test-email` — Send test email
- `POST /appearance/logo` — Upload custom logo
- `DELETE /appearance/logo` — Remove custom logo
- `POST /appearance/agent-avatar/<provider>` — Upload agent avatar
- `GET /search-visibility` — Search engine indexing setting
- `PUT /search-visibility` — Toggle search visibility

## Setup Wizard

First-run wizard at `/setup`. Steps:
1. **Domain**: Configure domain and HTTPS (Caddy)
2. **Email**: Set up Stalwart mail (DNS records, accounts)
3. **OpenClaw**: Connect to OpenClaw gateway (install agent, configure)
4. **Remote Desktop**: Set up VNC + shared browser
5. **Admin Account**: Create first admin user

The wizard writes to `.env.production` and configures all services. After completion, the `/setup` endpoint is permanently locked.

## Caddy (Reverse Proxy)

Config: `/etc/caddy/Caddyfile`

```
<domain> {
  reverse_proxy /api/* localhost:3000
  reverse_proxy /novnc/* localhost:6080
  reverse_proxy /apps/* localhost:{app_port}
  file_server { root /opt/bridgesllm/portal/frontend/dist }
}
```

Caddy auto-provisions Let's Encrypt SSL. Managed via `systemctl restart caddy`.

## Backups

- `POST /api/backups/create` — Create full backup (DB + files + config)
- `GET /api/backups/` — List available backups
- `POST /api/backups/restore` — Restore from backup

## Security Notes

- All API routes require JWT auth (httpOnly cookie, 24h expiry)
- File uploads virus-scanned (ClamAV when available)
- Path traversal prevented on all file operations
- Rate limiting on auth and send endpoints
- HTML sanitized before rendering (mail, chat)
