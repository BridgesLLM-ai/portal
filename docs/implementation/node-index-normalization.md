# Node/index data-environment normalization — Main-owned draft

Status: locally complete private finite-contract candidate, **not a live qualification/activation receipt**.
The ordinary updater never rewrites a service, environment, config or wrapper to
make a failed source qualifier pass. Normalize and retire this prerequisite
before creating a retained Chat owner. No automatic old-wrapper restart.

## Finite profile

The root:root 0600, regular single-link profile at
`/etc/bridgesllm/openclaw-node-index-v1.json` contains exactly these fields:

```json
{
  "schema": "node-index-data-env-v1",
  "package": "/opt/example/openclaw",
  "cli": "/usr/local/bin/openclaw",
  "node": "/usr/bin/node",
  "home": "/srv/example",
  "state": "/srv/example/.openclaw",
  "config": "/srv/example/.openclaw/openclaw.json",
  "environmentFile": "/etc/example/application.data",
  "guardHelper": "/opt/example/qualified/openclaw-migration-transaction.py",
  "port": 18789,
  "lockPath": "/srv/example/.openclaw/gateway.lock"
}
```

Paths are illustrative roles, not host evidence. The guard helper must be the
exact successor bytes shipped with this implementation. It is persistent,
root-owned, single-link, and independent of the retained owner's lifetime.
The profile cannot specify commands, hashes to trust, Node flags or library
allowances. Package/CLI resolution must agree; only 2026.9.2 is admitted here.
The explicit CLI alias and its complete link chain bind the selected package.
The direct Node/index start guard does not rediscover the CLI through service
PATH: the alias may be outside `/usr/bin:/bin`, since this route never runs it.

The service requires root/root, the same HOME/cwd, `Type=simple`,
`Restart=always`, `KillMode=control-group`, and a 330-second stop timeout.
Select only `/usr/bin/node <package>/dist/index.js gateway --port <port>
--bind loopback --verbose`. No `--force` or global process cleanup.
Require exactly one nonoptional typed EnvironmentFile, fixed
`OPENCLAW_DEFER_SHELL_ENV_FALLBACK=1`, `PATH=/usr/bin:/bin`, `LC_ALL=C`,
`OPENSSL_CONF=/dev/null`, and no additional execution controls. The fixed PATH
binds shell utility selection; locale/crypto settings exclude unqualified locale
and provider-configuration startup. Include these in equivalence review.
Keep the installer's exact migration permit condition first. Append:

```
ExecCondition=/usr/bin/python3 -B -I -S <guardHelper> node-index-start-condition
```

Do not reset ExecCondition. Both conditions precede the sole admitted existing
lock hook: `/bin/bash -c "rm -f <lockPath> || true"`. This is a finite namespace
effect, not arbitrary shell admission. If the actual existing hook differs,
this candidate refuses; do not claim that it was qualified by this document.
The lock path must be exactly `state/gateway.lock`. Python uses `-S` and `-I`
to prevent site startup hooks, plus `-B` to prevent cache writes. Debian x86-64
Python 3.11/3.12 layouts are finite; zip/venv/alternate paths refuse. Stdlib
namespace/bytes and interpreter/prehooks/shared dependencies are generation-bound.

## Data conversion implementation draft

The sealed helper exports pure `node_index_data(raw, 'export-v1')`,
`node_index_controls(values, application=True)`, and
`node_index_render(values)`. They do not execute input. Use these functions in
an explicitly authorized host-local prerequisite as follows; this is not an
updater action and has not been run against protected host inputs:

1. Open the original source with O_NOFOLLOW; require root/root 0600, one link,
   bounded size, safe parents, matching descriptor fstat-before/after and named
   lstat. Hold the protected source in memory only.
2. Parse literal exported assignments, reject unsupported syntax/duplicates and
   execution-control keys, and render systemd EnvironmentFile data. Supported
   application names end in `_API_KEY`, `_TOKEN`, `_PASSWORD`, `_PASS`, `_SECRET`, `_PROJECT_ID`,
   `_PROJECT`, `_URL`, or `_HOST`; interpreter/native control prefixes still
   refuse. This covers sanitized credential/project/endpoint categories without
   publishing host-specific key names. Unknown classes refuse, not broaden silently.
3. Create a different root/root 0600 single-link sibling with O_EXCL|O_NOFOLLOW;
   write/fsync, then compare all values in protected memory using the real
   systemd parser. The targeted test calls libsystemd-shared's load_env_file as
   an independent oracle for dollar/backtick/quote/backslash semantics.
4. Keep native state dotenv and config environment owners/precedence. The native
   managed file `home/.config/openclaw/gateway.env` must remain absent, as must
   home/package `.env` and the conservative state `gateway.env` role. The actual
   managed path is checked at admission, every owner load and queued start;
   do not mistake `state/gateway.env` for the source the native loader reads.
   Never copy
   /proc/environ wholesale or fabricate missing optional credentials. Confirm
   all required enabled-provider/channel inputs that depended on login fallback
   have explicit protected data bindings. No login-shell probe or secret output.
5. Journal old/new unit identities, protected originals, rendered-file absence
   or identity, planned activation intent and equivalence booleans. Install the
   persistent signed helper/profile and reviewed unit change under separately
   authorized host-service recovery ownership. Do not create a Chat owner yet.
6. Validate the actual typed manager properties, source/ELF identities, absence
   predicates and coherent original targets. Activate only with separate Main
   authorization, then record actual Node argv/PID/start/invocation/cgroup and
   bounded configured-provider readiness. On failure retain recovery evidence;
   never automatically execute the old wrapper.
7. Retire the prerequisite, then run ordinary signed Chat delivery under its
   single sealed owner. Credential rotation during an owner is drift. Rotation
   between owners requires fresh qualification.

## Remaining release gates

- Confirm exact host lock-path/effective-property compatibility and classify
  recording environment semantics privately: the sanitized report does not
  expose those semantics. Unknown recording controls still refuse; do not drop
  them to obtain admission.
- Python stdlib/import and fixed prehook dynamic-link closure are implemented;
  a complete isolated sealed-owner lifecycle and partial-write recovery pass.
  Scoped systemd/process/readiness doubles are explicitly documented in
  `node-index-implementation-status.md`; these are not real activation receipts.
- Main-owned normalization/effective-input equivalence and configured-provider
  readiness; actual direct Node/index activation with fallback unexecuted.
- Trusted signed artifact membership and final production gate. Source closure
  validation is not a signing or deployment receipt.

No standard TEST/native/performance/build matrix is reopened by this draft.
