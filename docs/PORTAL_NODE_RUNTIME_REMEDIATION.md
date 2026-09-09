# Portal updater Node.js remediation

The Portal updater deliberately does not replace the host's shared Node.js
runtime during an update. A host on Node.js `22.16.0` or `22.22.2` is valid for
older Portal 3.26.1 releases but is below the current OpenClaw-compatible floor.
The update refuses before it opens a transaction, installs a boot fence, or
stops the Portal.

## Portal-only updates

Portal-only updates retain the existing host interpreter and support these
previously qualified ranges: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
Installing Portal 5.0.1 does **not** require replacing a supported Node 22
interpreter and does not upgrade OpenClaw in the same action.

## OpenClaw 2026.9.3 and compatible-tools maintenance

The pinned upstream package requires `>=24.16.0 <25 || >=26.1.0`.
The qualified LTS target is **Node 24.20.0**. Node 22 and Node 25 cannot run this
OpenClaw release, even when they remain usable for Portal-only updates.

The compatible-tools action checks this prerequisite before stopping services
or staging packages. It never replaces the host interpreter under an unrelated
OpenClaw rollback journal. On existing Node 22 hosts, upgrade Node in a separate
host-maintenance window, preserving the installed package for rollback, then
verify Portal, native module loading, and the retained gateway before running
compatible-tools maintenance. Do not point a service at an unmanaged second
interpreter or bypass the engine check. Fresh installation uses the Node 24 LTS
lane before installing the pinned OpenClaw package.

## Repair the Node 22 lane

Run these commands as a root operator while the current Portal is still online:

```bash
node --version
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-22-setup.sh
bash /tmp/nodesource-22-setup.sh
apt-get update
apt-get install -y --allow-downgrades nodejs
node --version
```

The final version must be at least `v22.22.3` and remain below `v23.0.0`.
Remove the downloaded setup script after reviewing the successful result, then
rerun the signed Portal updater. The updater will recheck Node.js before release
staging or downtime. Do not edit the Portal systemd unit to point at a second,
unmanaged Node binary; the canonical service and recovery path must use the same
`/usr/bin/node` runtime.

## Remaining chat harnesses

After the OpenClaw, Codex, Claude Code, and ClawHub bundle commits, the same
compatible-tools action updates Ollama and the supported native chat harnesses
(Antigravity, Grok Build, OpenCode, and Hermes on Linux x86-64). Each uses its
own pinned acquisition and verification helper. Configured Agent Zero uses
its managed container and host-bridge lifecycle, preserving its persistent
data. Unconfigured Agent Zero is not installed and no provider login is created.

These additional runtimes are not a single atomic bundle with OpenClaw. A later
failure stops the action and retains earlier verified updates. Resolve the
reported tool error and retry; do not clear recovery records or authentication
files. Pause chat activity for the maintenance window and verify account/model
access after runtime maintenance.
