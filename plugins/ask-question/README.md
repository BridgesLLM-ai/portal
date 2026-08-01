# BridgesLLM Ask Question plugin

Holds an agent run open while the user answers the ask-question tool.

## Why it exists

`ask_user_question` otherwise self-resolves as unanswered, so the run continues
before anyone can reply and the Portal's answer card has nothing to resolve.
`before_tool_call` + `requireApproval` pauses the run and delivers a pending
approval to every connected approval surface, including the Portal.

## Optional by design

Portal renders and submits the answer card with or without this plugin. Without
it, the answer arrives as the user's next message instead of as the tool's
resolution. Both paths work. The plugin is never a hard dependency of an
install, because a plugin failure must not be able to break an upgrade.

## Bounds

- Title capped at 80 characters, description at 256 (Gateway limits).
- Timeout requested at the Gateway's 600000 ms ceiling, `timeoutBehavior: deny`,
  so an ignored question cannot strand a run.
- `allow-always` is deliberately not offered: every question differs, so
  persistent trust would silently skip future prompts.
