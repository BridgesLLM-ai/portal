# Updating Portal and AI tools

Publication makes an update available; it does not update an existing server automatically. Check the [release notes](https://github.com/BridgesLLM-ai/portal/releases/latest) for what a release changes.

## Two separate actions

| Action | Scope |
| --- | --- |
| Dashboard **Update**, or installer `--update` | Signed Portal files and owned database/schema changes. OpenClaw, the AI tools, their versions and their data stay as they are, apart from the narrow question-plugin repair described below. |
| **Admin > Maintenance**, one card per AI tool | Updates one AI tool at a time: Codex CLI, Claude Code, ClawHub, OpenCode, Hermes, Grok Build, Antigravity, Ollama and a configured Agent Zero. OpenClaw shows its versions; updating it from Maintenance comes in a later release. |

Update Portal first. Save work and verify a recoverable [data backup](BACKUP_AND_RECOVERY.md). These backups are not a host snapshot: mail, AI runtime databases/installations, and provider sign-ins are excluded. Take a VPS snapshot if you need whole-server rollback.

A Portal update stages its candidate before cutover and verifies readiness; it does not promise zero downtime. On supported OpenClaw 2026.9.1/9.2/9.3 installations with the obsolete 3.3.0 question plugin, the update installs the native 4.0.0 question plugin before promoting Portal. This can briefly restart the gateway, with plugin rollback if the transition fails. Nothing else in OpenClaw changes.

## Updating AI tools from Maintenance

Each card shows the installed version and the version this Portal release recommends; Codex CLI, Claude Code and ClawHub also show the newest published version, which you can choose to install. Other tools update only to the recommended version. A recommended version marked "(not yet qualified)" has not yet passed the release's qualification checks.

- **Owner only, one tool per run.** Only the Owner can start a run. Every update and repair asks for confirmation; a Re-check installs nothing and starts at once.
- **Verified and reversible.** A run verifies what it downloads before installing it, keeps the previous version so a failed check can undo the update, and shows the result and its report on the page.
- **OpenClaw is not updated from Maintenance in this release.** OpenClaw keeps working, and this Portal works with OpenClaw 2026.9.1 and newer. The OpenClaw card shows **Needs a later Portal release** and offers no update; a later Portal release adds the OpenClaw update.
- **Other tools never restart OpenClaw.** Codex CLI, Claude Code, ClawHub and the other harnesses are replaced without touching the gateway. Ollama restarts only its own model server.

If an OpenClaw run is interrupted, or OpenClaw cannot confirm a safe return, the page shows "Recovery required" with a repair button, and no other update is offered until the repair is done. The repair finishes or safely undoes the interrupted update; it never installs a new version. For any other tool the button is that tool's Re-check, which confirms what is installed now, and if the updater's background service stopped during a run, the button is Check interrupted update. Do not delete run records, fence markers, or saved authentication to make a retry pass.

Fresh installations start on the AI tool versions the release was tested with. Update them later from Maintenance. When Codex CLI, Claude Code, ClawHub, Ollama, OpenCode, Hermes, Grok Build or Antigravity is not installed, its card offers the Owner **Install** with the version this Portal recommends, using the same download checks as an update; if a check fails after installing, what was installed is removed again. Agent Zero needs its own setup first.

Servers first installed with Portal 5.0.x keep their older AI tool versions through later Portal updates. After updating to this release, Maintenance marks the tools below its minimum versions "Update required" and offers their updates. OpenClaw keeps its version. OpenCode and Hermes installed under `/opt/bridgesllm/tools` move to the current layout with their update, and the old copy is removed once the new version passes its checks.

On servers with the per-tool updater, the legacy installer option `--maintain-tools` no longer updates the tools together. It changes nothing and points to the Maintenance page.

## Model suggestions after sign-in

The Portal suggests newer models only when the signed-in runtime reports the exact route ready. API-key and subscription routes are distinct. A familiar model name is not proof that an account can use it, and suggestions never silently replace your current default. Provider plans, quotas, and credit charges still apply.

## Node requirements are different

Portal-only updates retain supported Node interpreters in these ranges: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.

OpenClaw sets its own Node.js requirement, which can be stricter, so a host can pass Portal-only checks and still need a newer Node.js for a newer OpenClaw. If you update OpenClaw yourself, follow the [Node runtime guidance](PORTAL_NODE_RUNTIME_REMEDIATION.md). Do not bypass the engine check or redirect a service to an unmanaged interpreter.

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

After an update, check Dashboard health, provider readiness, and a real conversation using the intended harness/model. A healthy package probe is not proof of account access or a working agent turn.

## Reading installation progress

The installer names the current stage, shows elapsed time, and gives a specific next action. The Dashboard activity indicator means work is ongoing; stage checkpoints are not measured percentages or time estimates. Smaller terminals and redirected output use a compact log view.

Package steps run noninteractively so operating-system restart notices cannot wait for input in a hidden dialog. The installer does not authorize an automatic host reboot; review any required reboot separately after installation.
