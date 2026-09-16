# Updating Portal and compatible AI tools

This guide describes **Portal 5.0.8**, released September 13, 2026. For later releases, check [release notes](https://github.com/BridgesLLM-ai/portal/releases/latest) and the exact pins in that release's [installer](../installer/install.sh). Publication makes an update available; it does not update an existing server automatically.

## Two separate actions

| Action | Scope |
| --- | --- |
| Dashboard **Update**, or installer `--update` | Signed Portal files and owned database/schema changes; preserves existing data and AI runtime versions. A narrow compatible question-plugin repair may reconnect the gateway, as described below. |
| Dashboard **Update Compatible AI Tools**, or installer `--maintain-tools` | Explicit maintenance of the release-qualified OpenClaw/native CLI bundle, followed by supported additional harnesses. Review host prerequisites and allow a maintenance window. |

Update Portal first. Save work and verify a recoverable [data backup](BACKUP_AND_RECOVERY.md). These backups are not a host snapshot: mail, AI runtime databases/installations, and provider sign-ins are excluded. Take a VPS snapshot if you need whole-server rollback.

A Portal update stages its candidate before cutover and verifies readiness; it does not promise zero downtime. On supported OpenClaw 2026.9.1/9.2/9.3 installations with the obsolete 3.3.0 question plugin, 5.0.7 and later install the native 4.0.0 question plugin before promoting Portal. This can briefly restart the gateway, with plugin rollback if the transition fails. OpenClaw core, provider configuration, sessions, and databases are not upgraded by this repair. Already-compatible installations and the retained 2026.7.1 lane do not receive that repair.

## Qualified versions in 5.0.8

These are the release's installation/maintenance targets, not a claim that every existing server already runs them.

| Tool | Version |
| --- | --- |
| OpenClaw core and official plugin bundle | 2026.9.3 |
| Portal question plugin | 4.0.0 |
| Codex CLI | 0.153.4 |
| Claude Code | 2.1.263 |
| ClawHub | 0.23.3 |
| Antigravity | 1.1.27 |
| Grok Build | 1.0.13 |
| OpenCode | 1.18.29 |
| Hermes | 0.21.1 |
| Ollama | 0.33.3 |

Configured Agent Zero follows the installer's pinned image and managed lifecycle; an unconfigured instance is not installed by maintenance. Runtime availability still depends on platform, credentials, and account/model access. A package update does not sign a provider in or create an entitlement. The native DeepSeek harness remains disabled; provider-based DeepSeek API models are a different path.

The OpenClaw/Codex/Claude Code/ClawHub bundle is staged and rolled back as a tested unit. Subsequent Ollama and additional-harness updates use separate verified checkpoints. A later harness failure stops the action but does not undo every earlier successful update. Preserve the reported evidence and resolve that specific failure before retrying.

## Node requirements are different

Portal-only updates retain supported Node interpreters in these ranges: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.

The pinned OpenClaw 2026.9.3 package requires `>=24.16.0 <25 || >=26.1.0`. The qualified LTS target is **Node 24.20.0**. A Node 22 or Node 25 host can therefore pass Portal-only checks but fail compatible-tools prerequisites.

The Portal updater does not silently replace the shared host interpreter. Plan a separate host-maintenance window where necessary and follow [Node runtime guidance](PORTAL_NODE_RUNTIME_REMEDIATION.md). Do not bypass the engine check or redirect a service to an unmanaged interpreter.

## If an update stops

- With the 5.0.9 installer, use `--status` to inspect the detected installation, lock, recovery records, and log locations without starting a repair. Status is not a service health check.
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
