# Portal updater Node.js remediation

The Portal updater deliberately does not replace the host's shared Node.js
runtime during an update. A host on Node.js `22.16.0` or `22.22.2` is valid for
older Portal 3.26.1 releases but is below the current OpenClaw-compatible floor.
The update refuses before it opens a transaction, installs a boot fence, or
stops the Portal.

Supported ranges are:

- Node.js 22: `22.22.3` or newer, but below 23
- Node.js 24: `24.15.0` or newer, but below 25
- Node.js 25: `25.9.0` or newer

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
