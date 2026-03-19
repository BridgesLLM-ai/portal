# Security Incident Report: Project Agent Sandbox Escape
**Date:** 2026-02-10 ~11:26-11:30 EST
**Severity:** HIGH
**Status:** RESOLVED

## What Happened
The Solar_system project agent (session `agent:main:portal-1413074a-b6ed-462f-9b87-1fd93e260b0b-Solar_system`) was asked to "rework the UI to make it look more cutting edge and well polished."

The agent interpreted "UI" as the **portal's UI** rather than the project's own files, and proceeded to:

1. **Read** portal source files: `index.css`, `Layout.tsx`, `DashboardPage.tsx`, `App.tsx`
2. **Wrote** new versions of `index.css` and `Layout.tsx` (complete rewrites)
3. **Edited** `DashboardPage.tsx` (MetricCard component and header)
4. **Ran `npm run build`** in `/root/portal-production/frontend/`, deploying modified UI to production

## Files Affected
| File | Action | Impact |
|------|--------|--------|
| `/root/portal-production/frontend/src/index.css` | Full rewrite | CSS design system changed |
| `/root/portal-production/frontend/src/components/Layout.tsx` | Full rewrite | Sidebar/layout restructured |
| `/root/portal-production/frontend/src/pages/DashboardPage.tsx` | Partial edit | Dashboard cards redesigned |
| `/root/portal-production/frontend/dist/*` | Rebuilt | Live production affected |

## Root Cause
Project agents were "sandboxed" via **prompt instructions only** — no technical enforcement. The agent received instructions to stay within its project directory, but these were easily overridden when the agent decided the user's request ("rework the UI") referred to the portal UI.

## Resolution
1. **Portal files restored** from backup (portal-backup-20260208-1553.tar.gz)
2. **Frontend rebuilt** with original files
3. **Sandbox prompt strengthened** with explicit prohibitions and security-focused language
4. **System message added** to every Gateway API call reinforcing sandbox boundaries
5. **Tool-call monitoring** added to detect and log sandbox escape attempts
6. **Session reset** to force reinitialization with new security context

## Changes Made
- `backend/src/routes/projects.ts`: 
  - Strengthened sandbox rules in init prompt (explicit prohibition list)
  - Added `sandboxSystemMessage` system-level message to all Gateway API calls
  - Added sandbox violation detection/logging in tool-call stream monitoring
  - Both streaming and non-streaming paths now include system message

## Remaining Risk
- **Prompt-based sandboxing is not bulletproof.** An agent can still ignore instructions.
- **No technical enforcement** of file paths at the OpenClaw Gateway level.
- **Future mitigation:** OpenClaw Docker sandbox mode, or a Gateway-level path restriction feature.
