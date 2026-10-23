# Updating Portal and compatible AI tools

This guide describes **Portal 5.1.0**. For later releases, check [release notes](https://github.com/BridgesLLM-ai/portal/releases/latest) and the exact pins in that release's [installer](../installer/install.sh). Publication makes an update available; it does not update an existing server automatically.

## Two separate actions

| Action | Scope |
| --- | --- |
| Dashboard **Update**, or installer `--update` | Signed Portal files and owned database/schema changes; preserves existing data and AI runtime versions. A narrow compatible question-plugin repair may reconnect the gateway, as described below. |
| Dashboard **Update Compatible AI Tools**, or installer `--maintain-tools` | Explicit maintenance of the release-qualified OpenClaw/native CLI bundle, followed by supported additional harnesses. Review host prerequisites and allow a maintenance window. |

Update Portal first. Save work and verify a recoverable [data backup](BACKUP_AND_RECOVERY.md). These backups are not a host snapshot: mail, AI runtime databases/installations, and provider sign-ins are excluded. Take a VPS snapshot if you need whole-server rollback.

A Portal update stages its candidate before cutover and verifies readiness; it does not promise zero downtime. On supported OpenClaw 2026.9.1/9.2/9.3 installations with the obsolete 3.3.0 question plugin, 5.0.7 and later install the native 4.0.0 question plugin before promoting Portal. This can briefly restart the gateway, with plugin rollback if the transition fails. OpenClaw core, provider configuration, sessions, and databases are not upgraded by this repair. Already-compatible installations and the retained 2026.7.1 lane do not receive that repair.

## Compatible tool targets in 5.1.0

These are the release's installation/maintenance targets, not a claim that every existing server already runs them.

| Tool | Version |
| --- | --- |
| OpenClaw core and official plugin bundle | 2026.10.6 |
| Portal question plugin | 4.0.0 |
| Codex CLI | 0.163.0 |
| Claude Code | 2.1.309 |
| ClawHub | 0.23.3 |
| Antigravity | 1.4.3 |
| Grok Build | 1.0.62 |
| OpenCode | 1.19.4 |
| Hermes | 0.22.2 |
| Agent Zero and official host connector | 2.14 |
| Ollama | 0.40.6 |

Configured Agent Zero follows the installer's pinned image and managed lifecycle; an unconfigured instance is not installed by maintenance. Runtime availability still depends on platform, credentials, and account/model access. A package update does not sign a provider in or create an entitlement. The native DeepSeek harness remains disabled; provider-based DeepSeek API models are a different path.

The OpenClaw/Codex/Claude Code/ClawHub bundle is staged and rolled back as a tested unit. Subsequent Ollama and additional-harness updates use separate verified checkpoints. A later harness failure stops the action but does not undo every earlier successful update. Preserve the reported evidence and resolve that specific failure before retrying.

## Model suggestions after sign-in

The Portal suggests newer models only when the signed-in runtime reports the exact route ready. API-key and subscription routes are distinct. A familiar model name is not proof that an account can use it, and suggestions never silently replace your current default. Provider plans, quotas, and credit charges still apply.

## Node requirements are different

Portal-only updates retain supported Node interpreters in these ranges: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.

The pinned OpenClaw 2026.10.6 package requires `>=24.22.1 <25 || >=26.12.1`. The qualified LTS target is **Node 24.22.1**; updates converge Node before the OpenClaw package is replaced. A Node 22 or Node 25 host can therefore pass Portal-only checks but fail compatible-tools prerequisites.

The Portal updater does not silently replace the shared host interpreter. Plan a separate host-maintenance window where necessary and follow [Node runtime guidance](PORTAL_NODE_RUNTIME_REMEDIATION.md). Do not bypass the engine check or redirect a service to an unmanaged interpreter.

## Project credential refresh

The first update from a release without a Project credential generation marker creates a new egress credential root. Before update verification can succeed, all exactly recognized managed Project proxies are stopped and verified process-free, including dormant provider planes; existing proxy connections close. Ambiguous ownership or inventory blocks success without stopping unrelated containers or deleting networks. Proxy recreation on next use takes the current credential. This retirement runs even when the candidate already has generation 2; later updates preserve the root. The rotation receipt records root staging, not completed revocation. If the initial update rolls back, it restores the predecessor environment; the next update retries the rotation with a fresh root. Restoring an older data backup onto an already-updated host preserves its newer credential root.

## If an update stops

- With the current installer, use `--status` to inspect the detected installation, lock, recovery records, and log locations without starting a repair. Status is not a service health check.
- Use `--recover` to finish recovery supported by existing transaction records, then choose the next operation separately. Recovery can finish a previously authorized uninstall; it does not resume an unjournaled partial fresh installation.
- If another installer still holds the lock, return to its original terminal and inspect its log. Do not launch another writer or delete the lock. If you interrupt the original operation, let its recovery finish before rerunning status.
- Read the specific Dashboard or installer error before retrying. Do not delete transaction journals, fence markers, saved authentication, or rollback evidence.
- For Portal `updated_with_errors` or `recovery_required` status, use [update attention recovery](PORTAL_UPDATE_ATTENTION_RECOVERY.md) only after the underlying failure is repaired and verified. This does not reconcile an interrupted OpenClaw migration.
- For a previously interrupted OpenClaw migration or manually rescued gateway, consult the installed signed installer's recovery help and the [5.0.4 recovery notes](../CHANGELOG.md#504---2026-09-09). The explicit root-only recovery requires the recorded evidence; an ordinary retry cannot replace it.
- A pre-5.0.7 Dashboard may reject a current data backup using its old verifier. See the [5.0.7 upgrade notes](../CHANGELOG.md#507---2026-09-10). Do not treat bypassing backup verification as the standard update procedure.

After maintenance, check Dashboard health, provider readiness, and a real conversation using the intended harness/model. A healthy package probe is not proof of account access or a working agent turn.

## Reading installation progress

The installer names the current stage, shows elapsed time, and gives a specific next action. The Dashboard activity indicator means work is ongoing; stage checkpoints are not measured percentages or time estimates. Smaller terminals and redirected output use a compact log view.

Package steps run noninteractively so operating-system restart notices cannot wait for input in a hidden dialog. The installer does not authorize an automatic host reboot; review any required reboot separately after installation.
