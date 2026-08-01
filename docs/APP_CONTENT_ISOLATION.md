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
