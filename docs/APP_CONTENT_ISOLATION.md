# Hosted and shared app origin isolation

Portal 4.0 serves user-controlled HTML, JavaScript, and full-stack app responses
from `APP_CONTENT_ORIGIN`. This origin must use a different registrable site
from the authenticated Portal. A sibling such as `apps.portal.example.com` or
an alternate port on `portal.example.com` is not sufficient: browser cookies
are scoped by host/domain rather than port, and sibling hosts can still shadow
parent-domain cookies.

The installer accepts an operator-owned hostname:

```bash
sudo bash install.sh \
  --domain portal.example.com \
  --app-content-domain apps.exampleusercontent.net
```

Before installation, create an A record for the app-content hostname pointing
to the Portal server. The installer verifies that DNS resolves to the detected
public IPv4 address before it changes Caddy. Caddy obtains a separate TLS
certificate and exposes only `/share`, `/share/*`, `/hosted`, and `/hosted/*`
on that host; every other path, including `/api`, returns 404.

When no explicit hostname is supplied, the installer derives
`app-content.<public-ip>.sslip.io`. This gives fresh installs a DNS-proven,
separate-site TLS hostname without weakening isolation.
It is an external DNS dependency. Production operators who do not want that
dependency should provide a separately registered domain with
`--app-content-domain`. The selected mode is recorded as
`APP_CONTENT_DNS_MODE=sslip`, `custom`, or `local`.

Updates preserve an existing explicit hostname, regenerate an automatic
sslip.io hostname if the public IP changes, validate the candidate Caddyfile,
replace only the marked app-content block, and roll back Caddy if reload or the
post-update TLS readiness gate fails.

## Bounded shared-App JSON responses

The shared-App API proxy validates a complete JSON document before committing
the upstream status. Its default limit is 8 MiB. Operators can raise that bound
without disabling validation:

```dotenv
# Global default for every App (bytes; clamped to 1–64 MiB)
APP_API_JSON_RESPONSE_MAX_BYTES=16777216

# One immutable App id takes precedence. Hyphens become underscores.
APP_API_JSON_RESPONSE_MAX_BYTES_67C66C1D_E8BE_4E5E_B42B_1BD0D0C9A848=33554432
```

Invalid values fall back to the safer default. Non-JSON downloads continue to
stream with backpressure. For datasets that routinely approach the configured
bound, pagination remains the correct application-level fix.

## Managed runtime-persistent App data

Project deployment replaces the complete executable/static release tree so a
deleted source file cannot survive as stale hosted code. The one product-owned
persistence boundary is the exact top-level `data/` directory:

- a first deployment may seed `data/` from Project source;
- every later deployment preserves the deployed `data/` generation instead of
  replacing it with source seed data;
- no other root is carried forward;
- `data` must be a real directory on the deployment filesystem. Symlinks,
  hard-linked files, bind mounts, filesystem crossings, and a source file that
  conflicts with the directory contract fail the deployment before promotion;
- numeric ownership and mode bits are retained with the copied data; and
- the previous release remains until the replacement starts. A failed start
  restores its code and pre-deploy data snapshot.

Promotion uses a private, identity-bound same-filesystem journal. Portal startup
quiesces the exact Project App container before converging an interrupted
promotion: non-committed evidence rolls back, while a durable `COMMITTED`
decision only removes the attested old generation. Unknown or conflicting inode
topology fails closed and preserves the evidence for operator review. Deployment
quiescence does not overwrite the App's durable running intent, so a crash before
commit restores and restarts the prior release instead of leaving it silently
stopped.
