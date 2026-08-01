# Automations and durable Tasks

## Automations

Automations are OpenClaw cron jobs managed through /api/automations and Agent Tools. They run outside the current conversation, so each job needs complete instructions and an explicit delivery plan.

Before creating:

1. Read /api/automations/status and the current job list.
2. Resolve the desired agent and exact model from live capability/catalog data.
3. Confirm timezone and whether the schedule is interval, hourly, daily, weekly, one-shot, or custom cron.
4. Make the prompt self-contained and idempotent.
5. Decide where results should go and whether delivery failure is fatal.

Do not embed a hardcoded “cheap” model alias. Model availability and pricing change; use a currently supported exact ID or let the configured agent default apply.

Useful routes:

- GET /api/automations
- POST /api/automations
- GET /api/automations/:id
- PUT /api/automations/:id
- POST /api/automations/:id/toggle
- POST /api/automations/:id/run
- GET /api/automations/:id/runs
- DELETE /api/automations/:id

Creation/update validates schedule shape, timezone, prompt, delivery URL, timeout, model, and thinking fields. Re-read the stored job after mutation.

A manual run is a real external action. Do not repeat it merely because the response or delivery is slow. Inspect run history first.

## Durable Tasks/jobs

Operator jobs live under /api/agent-jobs. They back installs, maintenance, and long host commands.

- POST /api/agent-jobs starts an approved tool/command.
- GET /api/agent-jobs lists visible jobs.
- GET /api/agent-jobs/:id/status reads durable state.
- GET /api/agent-jobs/:id/transcript reads bounded output.
- POST /api/agent-jobs/:id/input sends input to that job only.
- POST /api/agent-jobs/:id/kill requests termination.

Do not identify a job by display text alone. Keep its durable ID, verify toolId/owner/status, and avoid concurrent jobs for a serialized maintenance tool.

A task may survive browser disconnect or Portal restart. Reconnect to the existing job before creating another. Kill is idempotent but still disruptive; request it once and verify descendant cleanup.

## Scheduling guidance

- Use timezone-aware schedules; never assume the server timezone.
- Prefer a one-shot test run before enabling a recurring external mutation.
- Include deduplication keys or “check before acting” language for sends, deploys, deletes, and purchases.
- Bound runtime and output.
- Review run history after the first scheduled execution.
- If the gateway is temporarily unavailable, preserve the job and expose the failure; do not silently claim success.