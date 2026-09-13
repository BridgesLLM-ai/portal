---
name: Bug Report
about: Report something that isn't working correctly
title: "[Bug] "
labels: bug
assignees: ''
---

## Description

A clear description of what the bug is.

## Steps to Reproduce

1. Go to '...'
2. Click on '...'
3. See error

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened. Include error messages or screenshots if available.

## Environment

- **Portal version:** (copy the installed version from Dashboard)
- **OS:** (e.g., Ubuntu 24.04)
- **Browser:** (browser name, version, and desktop/mobile)
- **Node.js version:** (`node --version`)
- **Install method:** (fresh install / Portal update / compatible-tools maintenance)
- **Affected surface:** (Main Agent Chat / Project Work / shared browser / other)
- **Harness and model, if relevant:** (OpenClaw / Codex / Claude Code / other)
- **Runtime version and readiness message, if relevant:**
- **Does it persist after reload or reconnect?**
- **Previous version, for update regressions:**

## Logs

Include only the relevant, redacted error excerpt. Review logs and screenshots before posting: remove credentials, private prompts/files, email addresses, and setup links. Do not upload backups or authentication files. Report suspected vulnerabilities privately using [SECURITY.md](https://github.com/BridgesLLM-ai/portal/blob/main/SECURITY.md).

For a systemd installation, collect logs locally with:

```
# Portal logs
journalctl -u bridgesllm-product --since "10 minutes ago" --no-pager

# OpenClaw gateway logs
journalctl -u openclaw-gateway --since "10 minutes ago" --no-pager
```

## Additional Context

Add any other context about the problem here.
