# Security Architecture

## Filesystem Sandboxing (Phase 1)

### Overview
Project agents and API consumers are restricted to their designated project directory. No API request can read, write, or traverse files outside the project sandbox.

### Incident Background
On 2026-02-10, the Solar_system project agent modified portal source files (`App.css`, `Layout.tsx`, `Dashboard.tsx`). This sandboxing prevents any recurrence.

### Protected Paths

| Path | Reason |
|------|--------|
| `/root/portal-production/` | Portal source code |
| `/root/` | Home directory, SSH keys |
| `/etc/` | System configuration |
| `/proc/`, `/sys/` | Kernel interfaces |
| `/var/log/`, `/var/run/` | System runtime |
| `/portal/files/` | User uploads (separate access control) |
| `/portal/project-zips/` | Zip staging area |
| `/tmp/` | Temp files |

### Allowed Paths
Each project agent can ONLY access:
```
/portal/projects/{userId}/{projectName}/
```

### Validation Logic
1. **Path resolution**: `path.resolve()` converts relative → absolute
2. **Prefix check**: Resolved path must start with allowed project base
3. **Symlink check**: `fs.realpathSync()` resolves symlinks, re-validates target
4. **Null byte check**: Rejects paths containing `\0`
5. **Blocked prefix check**: Explicit deny-list for system/portal directories

### Examples

| Input | Result | Reason |
|-------|--------|--------|
| `src/app.js` | ✅ Allowed | Within project |
| `../other-project/file.txt` | ❌ Blocked | Traversal escapes sandbox |
| `/etc/passwd` | ❌ Blocked | Absolute path to system dir |
| `/root/portal-production/backend/src/server.ts` | ❌ Blocked | Portal source code |
| `escape-link/secret.txt` (symlink to /tmp) | ❌ Blocked | Symlink target outside sandbox |

### Middleware Application
- `/api/projects/*` — `projectPathSandbox` middleware
- `/api/ai/*` — `aiPathSandbox` middleware

### Violation Logging
All blocked attempts are logged to `ActivityLog` with:
- `action`: `PATH_SANDBOX_VIOLATION`
- `severity`: `WARNING` (first attempts), `ERROR` (≥3 attempts in 15 min)
- `metadata`: attempted path, reason, HTTP method, URL, timestamp

### Files
- `backend/src/middleware/pathSandbox.ts` — Core validation + middleware
- `backend/src/tests/pathSandbox.test.ts` — 7-test verification suite
