# Files, Projects & Apps

## Contents
- [File Manager](#file-manager) — Upload, browse, download files
- [Projects](#projects) — Web IDE with git, deploy
- [Apps](#apps) — Deploy projects as running applications
- [Common File Paths](#common-file-paths-for-agents) — Where to find everything

## File Manager

Portal page: `/files`. User file uploads with per-user isolation.

### Storage Layout
```
/var/portal-files/
  └── user-<uuid>/
      └── uploads/          # All uploaded files
```

- Max upload: 500MB per file
- Virus scanning on upload (ClamAV if available)
- Thumbnail generation for images
- Files tracked in PostgreSQL (`File` model) with metadata

### Backend API (`/api/files/`)
- `GET /` — List files (query: `?search=`, `?sort=`, `?order=`)
- `POST /` — Upload file (multipart, field: `file`)
- `GET /<id>/content` — Get file content (inline)
- `GET /<id>/download` — Download file
- `GET /<id>/thumbnail` — Get thumbnail (images only)
- `DELETE /<id>` — Delete file
- `POST /batch-delete` — Bulk delete (`{ids: [...]}`)
- `PATCH /<id>/rename` — Rename file (`{name}`)
- `POST /<id>/copy-to-project` — Copy file into a project
- `POST /sync` — Sync files from disk (re-scan upload dir)
- `GET /upload-config` — Get upload limits

## Projects

Portal page: `/projects`. Full web IDE with git integration.

### Storage Layout
```
/portal/projects/            # Project directories (git repos)
  └── my-project/
      ├── .git/
      ├── src/
      └── package.json
/portal/project-zips/        # Upload staging for ZIP imports
```

### Backend API (`/api/projects/`)

#### CRUD
- `GET /` — List all projects
- `POST /` — Create project (`{name, template?, description?}`)
- `POST /clone` — Clone from git URL (`{url, name?}`)
- `DELETE /<name>` — Delete project
- `PATCH /<name>/rename` — Rename (`{newName}`)

#### File Operations
- `GET /<name>/tree` — Get file tree
- `GET /<name>/file?path=<path>` — Read file content
- `PUT /<name>/file` — Update file (`{path, content}`)
- `POST /<name>/file` — Create file (`{path, content}`)
- `DELETE /<name>/file?path=<path>` — Delete file
- `GET /<name>/raw/<path>` — Raw file access (browser-viewable, auth via cookie)

#### Git Operations
- `POST /<name>/git` — Execute git operation
  - `{action: 'status'}` — Working tree status
  - `{action: 'log', limit?}` — Commit log
  - `{action: 'diff', cached?}` — Show diff
  - `{action: 'add', paths?}` — Stage files
  - `{action: 'commit', message}` — Commit
  - `{action: 'push', remote?, branch?}` — Push
  - `{action: 'pull', remote?, branch?}` — Pull
  - `{action: 'branches'}` — List branches
  - `{action: 'checkout', branch, create?}` — Switch branch
  - `{action: 'remote'}` — List remotes

#### Deployment
- `POST /<name>/check` — Detect deploy type (static, node, python)
- `GET /<name>/check-deps` — Check if dependencies installed
- `POST /<name>/install-deps` — Install dependencies (npm/pip)

#### Upload
- `POST /upload-zip` — Upload ZIP file
- `POST /create-from-upload` — Extract ZIP into project
- `POST /<name>/upload` — Upload files into project (max 50 files)

## Apps

Portal page: `/apps`. Deploy projects as running applications.

### Storage Layout
```
/portal/apps/               # Deployed app files
/var/www/bridgesllm-apps/   # Static site deployments
```

### Deploy Types
- **Static**: HTML/CSS/JS → served by Caddy at `<domain>/apps/<slug>/`
- **Node**: Node.js app → process manager allocates port, Caddy proxies
- **Python**: Python app → similar to Node

### Backend API (`/api/apps/`)
Apps are deployed from projects. The deployment process copies files, installs dependencies, and starts the process (for dynamic apps).

## Common File Paths for Agents

| Purpose | Path |
|---------|------|
| Portal source | `/opt/bridgesllm/portal/` |
| Backend source | `/opt/bridgesllm/portal/backend/src/` |
| Frontend source | `/opt/bridgesllm/portal/frontend/src/` |
| Built backend | `/opt/bridgesllm/portal/backend/dist/` |
| Built frontend | `/opt/bridgesllm/portal/frontend/dist/` |
| User uploads | `/var/portal-files/user-<uuid>/uploads/` |
| Projects | `/portal/projects/` |
| Deployed apps | `/portal/apps/` |
| Portal env | `/opt/bridgesllm/portal/backend/.env.production` |
| Caddy config | `/etc/caddy/Caddyfile` |
| Portal DB | PostgreSQL via `DATABASE_URL` in env |
| OpenClaw workspace | `/root/.openclaw/workspace-main/` |
| OpenClaw config | `/root/.openclaw/openclaw.json` |
| Portal service | `/etc/systemd/system/bridgesllm-product.service` |
| VNC service | `/etc/systemd/system/bridges-rd-xtigervnc.service` |
| Websockify service | `/etc/systemd/system/bridges-rd-websockify.service` |
