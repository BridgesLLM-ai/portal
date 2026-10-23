# Opt-in shared interactive browser

This is a dedicated persistent Chrome/Chromium profile for one explicitly named Portal
OWNER or SUB_ADMIN. It is not the legacy Shared Chrome profile on port 18801, a Project
App browser, an imported everyday profile, or a new profile silently substituted for one.
Signing into sites here creates cookies belonging to the commissioned Portal principal.
Release, logout, role changes and selecting another chat **never transfer those cookies**.

## Commission an installed Portal

Install the reviewed release through the normal Portal installation/update path first.
This separate operation requires root, an existing active owner account, explicit product
agent IDs, and the qualified OpenClaw runtime/configuration with `agents.entries`.
Xtigervnc, xauth, nft, systemd-tmpfiles and Chrome/Chromium must already exist; this operation
does not install missing packages. Close legacy Shared Chrome yourself before proceeding.
Obtain the owner's user UUID from Portal administration; do not substitute an email or agent ID.

```sh
sudo bash /opt/bridgesllm/portal/installer/install.sh \
  --commission-shared-browser --shared-browser-owner OWNER_USER_UUID \
  --shared-browser-agent AGENT_ID --dry-run
```

Repeat without `--dry-run` only after reviewing the read-only checks. Repeat
`--shared-browser-agent` for additional approved agents (maximum 32). Commissioning creates
an isolated `bridgesbrowser` service account, display :2 with **Unix-socket-only** VNC and
X authority, loopback CDP 18901 restricted by its own nftables table to root, and a root-only
lease broker. It creates a durable owner pin **before** Chrome starts. A different owner,
existing unowned cookies, unsafe custody, deny rules, conflicting profiles or open maintenance
fences cause refusal. No existing profile is imported or deleted.

The explicit operation uses OpenClaw's validating configuration writer (dry-run first),
starts dedicated services, restarts the product Gateway and Portal, verifies their readiness,
then retires the legacy 18801 launchers via `/etc/bridges-shared-browser.enabled`.
Ordinary installs/updates never commission this feature. Personal providers, Ollama and
Agent Zero are unchanged. Once commissioned, the built-in OpenClaw browser hook requires
explicit `target: host`, `profile: portal-shared`, and a selected owned Portal Agent Chat;
node routing, profile borrowing and browser lifecycle mutations are denied. Root execution
is trusted and can bypass this coordination gate; it is not a sandbox against root tools.

## Use and hand over

Open **Remote Desktop → Shared interactive browser**, or the OpenClaw Chat **Shared browser**
link. Select your own Agent Chat session. Selection begins in **human control** with the
private noVNC view in Portal. Sign in or complete the required interaction, then press
**Return to agent**. The human input connection closes immediately. The agent can check its
selection with `shared_browser_select` and request help with `shared_browser_handover`.

While the agent holds control, select a tab for a read-only preview. **Take control** blocks
new agent actions and drains the exact active call before enabling human input. **Decline**
clears a handover request without granting control. Stale buttons are rejected. **Release
selection** removes the session grant, not the owner's persistent logins. Role/account
revocation closes access. A missing completion or backend crash leaves admission closed;
a restart never guesses that an outstanding browser call completed.

## Disable and owner reassignment

An operator may disable the feature by setting `SHARED_INTERACTIVE_BROWSER_ENABLED=0` in
the product's root-owned environment and restarting Portal, then stopping the dedicated
browser/desktop services. The persistent profile and pin remain owned by the same principal.
Do not remove the legacy-retirement marker as an automatic fallback.

Reassignment requires explicit maintenance: stop Portal, Gateway, dedicated Chrome and
desktop; confirm no browser process, broker socket or in-flight marker remains. Source
`installer/shared-browser.sh` and invoke `shared_browser_archive_profile` as root. It archives
only the dedicated profile and owner pin into a new root-only directory; it never imports,
wipes, or reuses cookies for another principal. Clear the old owner setting only after that
archive, then commission explicitly for the new owner. Unresolved in-flight state is a
manual qualification/recovery condition, not permission to clear it blindly.

## Qualification boundary

Offline fixtures do not prove TEST commissioning, the installed OpenClaw hook/schema,
nftables enforcement, browser sandbox availability, X/VNC isolation, persistent site login,
or real human/agent handover. Qualify these on TEST, including a second admin, revoked account,
wrong agent/session, stale controls, process interruption and preservation through update.
