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

- **Portal version:** (check Dashboard → bottom of sidebar)
- **OS:** (e.g., Ubuntu 24.04)
- **Browser:** (e.g., Chrome 120)
- **Node.js version:** (`node --version`)
- **Install method:** (fresh install / update)

## Logs

If applicable, include relevant logs:

```
# Portal logs
journalctl -u bridgesllm-product --since "10 minutes ago" --no-pager

# OpenClaw gateway logs
journalctl -u openclaw-gateway --since "10 minutes ago" --no-pager
```

## Additional Context

Add any other context about the problem here.
