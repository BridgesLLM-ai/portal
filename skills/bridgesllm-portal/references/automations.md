# Automations

Scheduled agent tasks via OpenClaw cron. Managed from Agent Tools → Automations tab.

## How It Works

Portal creates OpenClaw cron jobs that run agent prompts on a schedule. Each automation:
1. Fires at the configured time/interval
2. Sends a prompt to an isolated agent session
3. Agent executes the task independently
4. Results delivered via configured channel (or stored in run history)

## Backend API (`/api/automations/`)

All routes require admin auth.

- `GET /` — List all automations (calls `openclaw cron list --json`)
- `POST /` — Create automation
- `PUT /<id>` — Update automation
- `DELETE /<id>` — Delete automation
- `POST /<id>/run` — Trigger immediately
- `GET /<id>/runs` — Get run history

### Create/Update Payload

```json
{
  "name": "Daily email summary",
  "message": "Check for new emails and summarize anything important",
  "agent": "main",
  "model": "haiku",
  "thinking": "none",
  "scheduleType": "daily",
  "time": "09:00",
  "tz": "America/New_York",
  "disabled": false
}
```

**Schedule types:**
- `interval` — Every N minutes/hours (`interval: "30m"` or `"2h"`)
- `hourly` — Every hour at :00
- `daily` — Once per day at specified `time`
- `weekly` — Once per week at specified `time` + `dayOfWeek` (0=Sun)
- `custom` — Raw cron expression (`schedule: "*/15 * * * *"`)

## OpenClaw Cron Integration

Portal wraps the OpenClaw cron system. Under the hood:
- `scheduleType: "interval"` → `schedule.kind: "every"` with `everyMs`
- `scheduleType: "daily"` → `schedule.kind: "cron"` with `expr: "0 9 * * *"`
- `scheduleType: "custom"` → `schedule.kind: "cron"` with raw expression
- All jobs use `sessionTarget: "isolated"` + `payload.kind: "agentTurn"`

## Transient Error Handling

The backend retries OpenClaw cron commands up to 3 times on transient gateway errors (connect failures, socket hang up, ECONNREFUSED). This handles brief gateway restarts.

## Tips

- Use `model: "haiku"` for lightweight periodic checks (saves tokens)
- Use specific, actionable prompts — the agent runs in isolation without conversation context
- Check run history to verify automations are working
- Automations appear in the OpenClaw cron list and can also be managed via `openclaw cron` CLI
