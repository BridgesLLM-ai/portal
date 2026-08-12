# Changelog

All notable changes to BridgesLLM Portal are documented here.

## [4.0.17] - 2026-08-12

### Fixed
- **Sign-in remains stable across browser tabs, and revoked sessions stay
  revoked.** Concurrent refresh requests now converge on the winning
  credentials instead of deleting them from the shared browser cookie jar.
  Deleted or expired durable sessions—including sessions revoked by a password
  reset—fail closed, cannot return after a reload, and immediately retire their
  live Portal transports. Project dependency installation re-attests the exact
  durable sign-in at its promotion boundary: revocation that wins leaves the
  live Project unchanged, while an already-authorized promotion converges to
  one complete generation after interruption instead of stranding mixed
  artifacts.

- **Agent Chat steering now reaches the exact run shown in the browser.**
  Steering works through Codex and provider-neutral OpenClaw runs, including
  Anthropic-backed turns. Retries join the original in-flight delivery instead
  of queuing duplicate text, a replacement run cannot receive a delayed steer,
  and a pending clarification remains authoritative. Readiness now attests the
  actual provider-neutral active-run bridge, and replaced stream subscriptions
  retire their keepalives instead of leaking server timers.

- **Updates stop before downtime when the candidate cannot restart cleanly.**
  The signed candidate audits App and Project continuity, persisted App
  runtimes, and App API bindings before opening the update transaction. Exactly
  identified stale links can be quarantined and re-attested while the current
  Portal remains online; ambiguous state and unsupported Node.js versions
  produce actionable failures before the boot fence. An ordinary reboot now
  contains one unsafe App instead of taking down the entire Portal, and
  Dashboard attention states expose the failed phase, operation, versions, and
  recovery procedure. Startup recovery now distinguishes stable promotion
  evidence from timestamp-only Project-directory churn, so harmless namespace
  metadata changes cannot quarantine an otherwise clean Portal. Once 4.0.17 is
  installed, Dashboard updates authenticate
  the exact installer bytes with a detached release signature before Bash can
  execute them; the first 4.0.16-to-4.0.17 hop remains rooted in the existing
  updater's pinned HTTPS origin because new code cannot retroactively change an
  older launcher's trust boundary. OpenClaw question-bridge updates now attest
  the replacement tool and settlement methods before activating compatibility,
  then require the complete active-run bridge before committing, so an
  unpatched 4.0.16 runtime cannot deadlock its own upgrade.

- **Legacy Projects can enter Project Chat without losing their deployed App or
  share URLs.** Adoption can rebind one eligible stopped App to the exact
  current Project identity while retaining its App ID and existing share
  tokens. Conflicting identities, ambiguous paths, or a running Portal-managed
  App are refused instead of guessed through. The rebind now shares the Project
  lifecycle lock and converges after interruption instead of stranding a copied
  deployment or pairing a new database identity with an old live runtime.

- **A contained Project dependency update has one supported Owner recovery
  path.** Portal can force-forward only the exact staged generation recorded by
  the original promotion decision, after a new authenticated Complete
  comprehensive backup passes strict restore verification. The Project remains
  fenced through writer shutdown, crash-resumable promotion, all-new
  verification, backup revalidation, and evidence cleanup. Lost browser
  responses and reloads rediscover and reconcile the same durable receipt. If
  live continuation loses its exact exclusion proof or exhausts bounded
  retries, Portal stops current-process polling and hands the exact operation
  or committed receipt to controlled startup recovery instead of inviting a
  second mutation. Conflicting identities, stale backups, mixed files, and
  attempts to preserve or abandon the staged generation fail closed.

- **Backups now distinguish recovery archives from salvage files.** Backup
  Settings shows authenticated Complete, Salvage only, and Unclassified states,
  names omitted components, warns after repeated incomplete runs, and confirms
  before downloading an archive that is not restore-ready. When an operator
  chooses an existing current backup for an update or guarded maintenance, it
  must be fresh, comprehensive, and pass strict restore verification; the
  existing explicit confirmation to proceed without a fresh backup remains
  available. Project captures accept ordinary virtual-environment interpreter
  links, live agent SQLite databases are snapshotted safely, and degraded
  archives cannot rotate away complete recovery evidence.

- **Shared App logins and API failures report what actually happened.**
  Password-protected shares use a native form that works without JavaScript and
  keeps authentication errors visible. App API responses preserve real upstream
  authentication statuses only after complete JSON validation; truncated,
  malformed, or JSON responses larger than 8 MiB return a truthful failure,
  while missing configuration, timeout, and upstream outage remain distinct
  cases.

## [4.0.16] - 2026-08-11

### Fixed
- **Servers running 4.0.15 can update again.** The update path attests the
  scheduled Portal backup helper (`backup-full.sh`) against a list of helpers
  that shipped in a signed release, and refuses to continue when it finds one
  it cannot vouch for. 4.0.15 shipped a rewritten helper — the degraded-backup
  work — without adding it to that list, so 4.0.15's own guard rejected the
  helper 4.0.15 installs. Every server that reached 4.0.15 was blocked from
  updating with `Unsafe Docker prune guard: scheduled Portal backup helper does
  not match a known shipped BridgesLLM release`. The helper is now attested and
  the update proceeds normally. No action is required beyond updating; the
  guard itself was working correctly and is unchanged.

### Changed
- **A release can no longer ship a backup helper its own installer would
  reject.** The guard reads the helper that is already installed, before the
  update replaces it, so changing the helper passes every gate on the release
  that introduces it and only fails on the *next* update. The release build now
  hashes the helper it is about to ship and fails closed unless the installer
  attests those exact bytes.

## [4.0.15] - 2026-08-10

### Fixed
- **Fresh and expired sessions can sign in again.** A missing or expired session could make its own recovery attempt look stale, leave the login form permanently disabled, and display “Signing in…” even though no request was still running. Superseded recovery now releases the loading state without allowing an older response to overwrite a genuinely newer session. A regression test drives the real `/auth/me` 401 → `/auth/refresh` 401 → local logout path that caused the lockout rather than simulating an unrelated external generation change.

  **Locked out on 4.0.14?** The Dashboard update button is unreachable from the disabled login screen. Connect to the VPS over SSH and run the signed terminal updater (omit `sudo` only when already logged in as root):

  ```bash
  curl -fsSL https://bridgesllm.ai/install.sh | sudo bash -s -- --update
  ```

- **Long Agent Chat runs remain a readable timeline after the browser has been away.** OpenClaw's cumulative and bounded sliding reasoning snapshots are projected into only the new thought at each tool or text boundary, while history scans continue to the real run boundary instead of stopping at an arbitrary page timestamp. Tool-heavy and multi-file session pagination no longer drops the initiating prompt or duplicates the final answer, one foreground reconciliation replaces two racing reloads, accepted user messages remain visible during durable-history lag, and encrypted Anthropic reasoning reports honest transient token progress without inventing hidden chain-of-thought.
- **Project Chat preserves the same reasoning/tool chronology.** Attested OpenClaw preambles and raw reasoning use independent cumulative-snapshot lanes in both live replay and durable history, replay sequence wins over skewed timestamps, text and segment boundaries graduate the active thought, and transient token counters stay out of saved reasoning. If a safety cap genuinely omits earlier activity, the saved presentation is marked and the UI says so instead of silently pretending the turn is complete.
- **A comprehensive backup can publish an honest degraded archive instead of destroying all recovery evidence.** Component capture records exact complete, degraded, and failed outcomes; a nonzero degraded run keeps its sealed archive and manifest, refuses strict restore verification, and cannot rotate away older complete backups. The runner snapshots mutable SQLite state online, excludes volatile sidecars, and verifies restore fixtures under active-host failure rather than treating an idle daily run as evidence.

## [4.0.14] - 2026-08-10

### Added
- **Dashboard updates now report real server-owned progress.** The update dialog shows completed installer checkpoints, a determinate percentage, concise phase detail, recent milestones, elapsed time, and an explicit reconnecting state while Portal restarts. The operation survives navigation, page reloads, lost admission responses, and backend replacement; success appears only after the protected updater exits cleanly and the exact target Portal reports ready health.

### Fixed
- **Ordinary scheduler state no longer makes the Portal effectively uninstallable.** The Docker-prune guard recognizes the exact legacy cron job with normal `/dev/null` redirection, ignores non-loadable unit backups and non-command path tokens, understands wrapped and tab-stripping heredocs, handles NUL or non-UTF-8 scheduled script sources without making an unrelated update fatal, and treats scan-budget exhaustion as bounded warning state. A full aged-Ubuntu fixture proves the six production failures while controls still reject literal unsafe prune commands, suffix injection, and helpers hidden after the work budget.
- **Updater failure and recovery outcomes remain honest across every restart boundary.** Root-owned atomic receipts distinguish stopped-before-change, rollback, post-commit host errors, and manual recovery. Systemd exit finalization, authenticated postflight health, operation-bound unit identity, bounded downloads and runtime, orphan reconciliation, clock rollback, and immutable historical receipts close the races that previously produced endless spinners, early success, hidden failure, or a permanently busy updater.

### Security
- **Update telemetry is observable without becoming recovery authority.** Operation identifiers, phases, text, percentages, state files, current pointers, helper code, and bounded log tails are strictly validated and protected against symlinks, hardlinks, ownership or mode drift, path escape, control characters, and stale identity. The progress observer cannot alter the installer's transaction journals, and attention blocks require an explicit root repair acknowledgement rather than a browser bypass.

## [4.0.13] - 2026-08-10

### Added
- **Share links can enforce their own request throttle.** A share link can now carry an owner-selected request cap and window, enforced on the server against the link itself rather than against a visitor IP. Exceeding it returns `429` with `Retry-After`; if the throttle cannot be evaluated the request is refused rather than waved through, and throttle responses are never cached.
- **Embeddable origins are managed in one owner-controlled allowlist.** Portal keeps a persisted, versioned policy for which external origins may be framed and which of those may be delegated camera or microphone access, replacing hand-maintained per-app CSP overrides. YouTube ships as a removable default, private and special-use namespaces are rejected outright, and the policy is capped in both entry count and size.
- **Project deployments declare who owns the runtime.** A deployed Project now records whether Portal manages its runtime or an external service does, and the Runtime panel exposes honest Refresh, Start, and Restart with visible in-progress state. Externally owned workloads are no longer silently adopted or sandboxed by a deploy.

### Changed
- **Portal branding is consistent on every surface.** The bundled high-resolution mark is now the default across auth, the mobile header, Settings preview, every favicon and Apple touch icon candidate, the privacy curtain, first-response OG/Twitter metadata, notification email, and mail signatures, while a tenant logo still overrides all of them. Deleting a custom logo restores the bundled default instead of reviving a legacy file, and a committed appearance change invalidates the in-process email branding cache immediately. `/landing` and `/docs` stay vendor-branded.
- **Project Chat opens as a conversation instead of a provisioning screen.** The saved transcript loads before provider preparation, an unprepared provider remains readable, and the composer keeps an editable project-scoped draft while Portal checks or prepares the sandbox. Preparation has one explicit action, visible progress, safe background dismissal, bounded retry guidance, and no duplicate global error alarm.

### Fixed
- **A gateway restart no longer destroys the Agent Chat turn you were watching.** A live run is now recovered across a gateway restart instead of being abandoned until it finishes: the browser reattaches to the existing run rather than replacing or cancelling it, the assistant's identity is preserved through recovery, and replayed history is de-duplicated so recovery does not produce a second copy of the turn. Activity that arrived through another OpenClaw channel while the run was live reconciles into the Portal timeline instead of staying invisible until completion.
- **Mid-turn steering survives a tool call.** An active steer is no longer dropped when the run yields to a tool, so a steering message either visibly steers or visibly fails rather than disappearing. This ships as part of the pinned OpenClaw runtime patch applied by the installer.
- **Stuck provider sign-ins can be recovered from the wizard.** Pasting a Claude code no longer leaves a blank screen with no result, a cleanly rejected save no longer parks the provider domain for fifteen minutes, and a retained lifecycle fence no longer disables a provider permanently. Both the OAuth and Claude wizards expose a visible reset, and a refused login now reports the real reason instead of a bare exit code.
- **Cancelling a native sign-in settles instead of wedging the provider.** A cancelled Antigravity or Gemini handoff releases the google domain without waiting for a restart, and a retry can immediately acquire a fresh lifecycle lease.
- **Updating no longer trips over a native database engine.** The installer removes the native Prisma runtime crash path and pins the attested JavaScript driver, and refuses to start if the database environment has been overridden in a way that would silently swap engines or disable TLS verification.
- **Several installer failures that only appeared on real upgrades are fixed.** Dangling systemd activation links are resolved rather than inherited, the scheduled Portal backup helper is attested before it is trusted, scheduled helper budgets are calibrated so slow hosts stop timing out, and the Agent Zero bridge runtime is published without leaving a partially written target behind.
- **Switching Agent Chat sessions no longer stops another in-flight run.** Session navigation now detaches and hands off the browser stream without sending a provider Stop/abort frame. Explicit Stop remains the only action that cancels a run, including when two named sessions are active at once.
- **Grok subscription sign-in can recover cleanly after cancelling xAI OAuth.** Slow, fail-closed OpenClaw credential checks continue through one shared background reconciliation instead of timing out the browser and retaining stale setup ownership. The setup screen follows that accepted cleanup to a confirmed result, while a credential commit or disappearing auth session still fails closed.
- **An interrupted Project egress teardown no longer bricks every later update.** The installer can reclaim a fully labelled pair of empty, parentless Project egress networks after matching immutable snapshots and a final race barrier. Any attached, incomplete, relabelled, or changing topology remains fatal and now identifies the exact Docker resources and inspection commands needed to recover safely.
- **Claude Code clarification cards wait for an answer instead of immediately declining.** Headless Claude sessions now use Portal's bound `ask_user_question` bridge after both fresh and resumed configuration merges, with an eleven-minute MCP request window. Historical native auto-declines render as unanswered rather than green success, and compatibility fallback application attests the live plugin and RPC before and after restart.
- **Project chats survive ambiguous sends, provider restarts, and Portal restarts without inventing a second turn.** Actor/project/provider-scoped delivery IDs, durable leases, dispatch admission fences, restart quiescence, terminal replay hydration, and exact state-version checks preserve one conversation across reloads while stale or uncertain runtime state remains visibly blocked.
- **Projects remain usable when one workspace needs repair.** Project inventory preserves healthy entries when another directory races a lifecycle operation, and identity or lifecycle residue becomes a disabled project card with a bounded recovery state instead of a page-wide error. Git, file, deployment, and agent writes now converge on the confined runtime owner without recurring permission failures.

### Security
- **Project Chat authority is bound to the signed-in actor and immutable project on every path.** Sub-admin workspace compatibility can no longer bleed into the sandbox principal; transcript responses are schema-checked and rejected on immutable-identity mismatch; workspace adoption, memory, file replacement, and restart cleanup use descriptor-bound containment and fail closed on path or runtime drift.
- **Tenant branding values are validated at every rendering boundary.** The accent colour must be an exact six-digit hex value and a logo URL must be a same-origin path or a credential-free HTTP(S) URL, so a stored appearance row cannot inject markup, script, or style into first-response HTML or email. Every injection site additionally escapes the value it renders.
- **A misconfigured App API target now fails closed.** An invalid per-App API target is treated as a distinct error state instead of reading as "not configured", which previously allowed a request to be proxied to — or a runtime to be started as — the wrong Portal-managed workload.
- **Directory ownership changes cannot be raced.** Contained directory creation opens each component with `O_NOFOLLOW`, verifies device and inode identity both before and after ownership is applied, and re-checks containment, so a symlink swapped in mid-operation cannot redirect a privileged `chown`.
- **All known frontend dependency advisories are resolved.** `npm audit` reports zero vulnerabilities for both packages. None of the advisories were reachable through Portal's usage, and the fixes were applied without downgrading the bundled editor.

## [4.0.12] - 2026-08-04

### Fixed
- **OpenClaw Project qualification can apply its confined agent policy again.** Portal intentionally replaces the complete id-keyed `agents.list` entry for a Project so stale deny policy cannot survive, but OpenClaw 2026.7.1 refuses a patch that removes nested array entries unless the caller names each exact affected path in `replacePaths`. Portal now authorizes `agents.list[].tools.deny` and `agents.list[].tools.sandbox.tools.deny`, preserves the gateway's structured failure through both RPC transports, and shows Owners and Sub Admins a bounded, credential-redacted diagnostic when a different host policy fault still blocks qualification. Regular users continue to receive only the safe maintenance message.
- **Comprehensive backups support the Portal's containerized PostgreSQL topology.** If the existing host peer-socket fence is unavailable, the runner now admits exactly one Docker container published on the configured literal loopback endpoint, binds its immutable container and image identity, persistent writable `PGDATA` mount, internal PostgreSQL peer socket, server identity, database owner, and original connection policy, then fences Portal connections without persisting a database password. The fence is recorded in the existing crash-recovery transaction, asserted through capture, and restores the exact role and database access policy on success, failure, interruption, or the next guarded run.
- **OpenClaw state backups no longer race live Codex goal and memory databases.** Each discovered `goals_*.sqlite` and `memories_*.sqlite` database is captured through SQLite's online backup API, checked independently, and overlaid at its original recovery path while the mutable live database and WAL sidecars stay out of the tar stream. Discovery is compared before and after capture, so a changing database set still fails closed instead of silently omitting state.
- **Manual backups no longer pin the Settings page or hide what the job will do.** The global Settings mutation claim ends as soon as systemd accepts the durable background job; local polling continues, automatically reattaches after navigation or refresh, and now renders the runner's real phase and phase count. Standard capture can run while the Owner uses the rest of Portal. Comprehensive capture still has to quiesce Portal and agent services for recovery consistency, so its selector now warns that Portal will be temporarily unavailable and live progress will reconnect after services return. A failed run shows the bounded sanitized reason recorded by the backup service instead of only an exit code.
- **The managed BridgesLLM skill stays current and produces usable file links.** Every normal Portal backend start reconciles the signed skill bundle into the active OpenClaw workspace, independent of Remote Desktop setup and without a Gateway restart. The skill now tells agents to use verified absolute Agent-workspace paths, provider-visible absolute Project paths, or an actual Portal Files `portal_url` in standard Markdown, and to fail closed rather than guess a root, storage path, or file ID.

### Security
- **Container database fencing fails closed on authority drift.** The Docker command boundary, container identity, endpoint binding, image, storage mount, PostgreSQL major, system identifier, database and role OIDs, privilege profile, prepared transactions, active clients, and guard token are re-attested before privileged actions. Ambiguity, a recreated container, unsafe storage, changed policy, or an incomplete service recovery prevents publication.

## [4.0.11] - 2026-08-03

### Added
- **Ask Questions now works through every embedded provider, not only native Codex.** When an agent needs a decision in the middle of a run it can raise a clarification card in Project Chat whatever model is driving that run. Project Chat admits the single named clarification tool without exposing the rest of the plugin surface, and every question stays bound to the authenticated user, session, run, and tool call. A provider that reuses a tool-call ID across overlapping runs fails closed rather than letting one run consume another run's answer, and a question already answered in another browser reconciles quietly instead of surfacing a generic failure.
- **Files an Agent links to now open somewhere useful.** Links to Portal-managed uploads navigate to Files and select the exact file. Links to real files in that Agent's own workspace, or in a Project generation, are copied into a private bounded Remote Desktop handoff, opened in the appropriate desktop viewer, and the Portal switches to Remote Desktop to show them. Traversal, symlinks, authority changes, oversized files, and cross-Agent or cross-Project paths all fail closed, and each handoff copy expires on a managed lifetime.

### Changed
- **The workspace refresh screen now belongs to the Portal.** The opaque privacy curtain uses the installation's uploaded logo as a desaturated translucent mark, layers a restrained radial dot matrix and a slow light sweep over Portal colors, and presents status in a glass pill. It scales down to mobile, degrades cleanly when no logo has been uploaded, and becomes static under reduced-motion preferences. Its first frame is fully opaque, so the workspace behind it is never briefly legible.

### Fixed
- **Agent Chat recovers when a provider stream drops.** The visible amber reconnect control now exercises the same real socket-recovery path the tests cover, a manual refresh reloads history and reconnects, and a run that finishes while the browser is offline leaves an authoritative terminal snapshot so the yellow rail clears without a hard page reload.
- **Agent Chat shows the right sessions and an honest account of what a run is doing.** Provider and agent sessions are restored on return instead of collapsing into another agent's history, live activity reflects the actual state of a turn rather than an optimistic guess, a final reply split across several frames is reassembled instead of being truncated, a stale replay from an earlier run is fenced off rather than replacing current output, and a gap in the runtime event sequence quarantines that stream instead of rendering a silently incomplete conversation.
- **Codex sign-in finishes cleanly and no longer puts an existing login at risk.** The OAuth wizard completes finalization instead of stalling at the last step, credentials are attested before they are committed so a partial or malformed grant cannot be written, and a setup attempt that does not complete leaves any Codex login already on the box untouched.
- **OpenClaw state backups are smaller and internally consistent under live use.** Reproducible Codex sessions, caches, shell snapshots, operational state databases, and logs no longer churn the recovery archive, while Codex configuration, memories, and goals remain included. The live OpenClaw SQLite database is captured through SQLite's online backup API, so committed write-ahead data lands in one standalone database at the original restore path; stale outbound delivery rows are removed so a restore cannot replay them, and linked, replaced, or otherwise unsafe WAL, SHM, and journal sidecars are refused.

### Security
- **Dependency advisories are patched on the shipped backend and frontend graphs.** Undici, `ip-address`, PostCSS, `socket.io-parser`, and `brace-expansion` are updated to fixed releases. The remaining React Router advisory is limited to React Server Components, which this client-only Vite build neither imports nor bundles and which the release gate proves unreachable.

## [4.0.10] - 2026-08-03

### Fixed
- **Backups run again when Portal Files and OpenClaw share stored media.** OpenClaw hard links its media directory to Portal Files uploads, so a single file is reachable from two directories that the backup captures as separate components. The runner required every link of a file to be found inside the component being archived, treated the perfectly normal second link as evidence that the capture was incomplete, and refused the entire backup — daily, weekly, and monthly alike. Both components now accept a link that lives in another backed-up tree. The file's contents are still captured in full in each archive; only the link relationship between the two copies is not preserved through a restore. A link count that is impossible, or one that disagrees with itself, still fails the backup closed, and every other component keeps the original strict check so a hard link cannot smuggle excluded data into an archive.

## [4.0.9] - 2026-08-02

### Fixed
- **A comprehensive backup no longer stops the Portal to discover it cannot run.** The check that decided whether to quiesce the host only *derived* what the database's peer socket, operating-system user, and roles would be; it never opened a connection. The first code that actually connected ran after the Portal and the OpenClaw gateway had already been stopped. On an installation whose database is reached over TCP — a container, or any remote server — there is no peer socket to open, so that step could only ever fail, and the outage bought an archive that was never possible. Admission now proves a live peer connection before anything is stopped: the host is refused immediately, the message names the cause, and it confirms that no services were stopped. Daily, weekly, and monthly backups do not use this fence and are unaffected.
- **Agent Chat shows the main agent's sessions again after returning from a sub-agent.** The session list asked the server for a specific agent only when a sub-agent was selected. Switching back to the main agent sent no agent at all, so the server answered for every agent at once and the main agent's history came back mixed with other agents' chats. The selected agent is now always named, including the default one.
- **Returning to the main agent is no longer a silent no-op.** The main agent's row was disabled whenever its provider availability was still being rechecked, while the sub-agent rows below it were always selectable. Clicking it during a routine recheck did nothing, so the selector appeared to respond only to sub-agents. The row now follows the same rule as its sub-agents, and the status label still reports availability.

## [4.0.8] - 2026-08-02

### Fixed
- **A new project can start Project Chat again.** The panel claimed its 15-minute automatic-qualification backoff before sending the qualification request, and a first qualification on a new project takes far longer than a person will wait. Reloading or switching projects during that window left the backoff behind for an attempt that never returned a verdict, so the project came back permanently unqualified with no retry and no failure to explain it. Only a real qualification failure records a backoff now.
- **Stop actually stops an Agent Chat run.** The abort route treated any response that was not an explicit refusal as a successful cancellation, so a missing or unexpected payload cleared the composer while the run kept going. Portal now requires a confirmed abort, reports which runs were cancelled, and says the run may still be active instead of reporting a cancellation that did not happen.
- **Opening Agent Chat session settings no longer mutates or interrupts the active session.** The settings panel now reads canonical OpenClaw metadata without silently patching thinking or reasoning defaults, avoids an unrelated command-catalog request, and stays disabled while a turn or model transition owns the session.
- **Portal-created OpenClaw chats have recognizable names.** New Portal sessions receive a stable agent label and the first prompt upgrades it to a concise conversation title. Naming now also covers sessions Portal's own records show you own, which previously displayed Portal's internal gateway client identity instead of a title and made conversations impossible to tell apart. Existing chats created outside Portal keep their own labels, and chats that already exist are not renamed retroactively.
- **One chat action creates one session.** Selecting or reconnecting to an existing `new-*` OpenClaw chat no longer triggers a second background `session-create` call after the explicit creation path already completed.
- **Expired idle tabs stop hammering the server.** A failed refresh now clears falsely persisted login state, including the browser-only WebSocket-upgrade `1006` case, and gateway question polling backs off to 30 seconds during restart windows.
- **New Project Chat waits for verified OpenClaw model readiness.** The browser no longer asks for an embedded model catalog before automatic provider qualification completes, and a transient empty catalog cannot poison the server cache.
- **Legacy projects can enter Project Chat without unsafe in-place promotion.** Portal makes a manifest-verified copy under a new Portal 4 identity, proves the copy remained stable, and leaves the legacy inode, older agent state, shares, apps, and deployment untouched.
- **Project deletion recovers cleanly after an OpenClaw runtime was prepared.** A first Project agent can no longer capture default routing on a fresh installation, and Portal removes a large sandbox policy in verified stages so OpenClaw's config-size guard cannot strand the project in `DELETING`.
- **Backups run again on a PostgreSQL server that is behind on patches.** The backup runner applied its client security floor to the *database server* as well, so a supported server one patch release below that floor was refused outright and no backup could be taken at all. The floor now governs the client toolchain that Portal runs, while any supported server major is still backed up — the archive is the prerequisite for safely patching the server, so refusing it left an installation with neither. Portal also omits only OpenClaw's reproducible managed npm runtime, retries bounded live-state capture races, and preserves durable sessions, config, and extensions.
- **Native provider sign-in is no longer blocked by its own credential attestation.** A symlink inside an attested directory is recorded by its target instead of refused, so a provider CLI that rewrites a log file on every run can still sign in. An attested path that is itself a symlink still fails closed.
- **A failed xAI sign-in no longer locks the provider until the Portal restarts.** The operation gate expires, and Cancel waits for the login process to exit before judging the credential instead of failing with a conflict and leaving the gate held.
- **A successful sign-in is reported as connected.** Authorization profiles that OpenClaw keeps in its own auth store now count as provider configuration, instead of being reported as credentials with a missing provider config.
- **Provider setup failures name the cause.** A missing CLI says which tool to install and how to install it; an unreadable credential file says which path to check.
- **App pages that load from a directory URL open again.** The App API proxy treats a trailing slash as a legitimate upstream path rather than an empty segment, so a request like `/api/<app>/app/` reaches the app instead of failing with a misleading "App API backend is not configured". Traversal, backslash, null-byte, and internal empty-segment rejection are unchanged, and a doubled trailing slash is still refused rather than silently collapsed into a different path.

## [4.0.7] - 2026-08-02

### Fixed
- **Codex progress no longer explodes into one thinking card per token.**
  OpenClaw sends `item.preamble` progress as a growing cumulative snapshot.
  Agent Chat treated every newly appended tail as a separate thinking title,
  which turned a normal sentence into hundreds of durable cards and crowded
  the real conversation out of the history window. Preamble snapshots now
  replace one live status, and both the live cache and durable event journal
  collapse the intermediate frames.
- **Agent history survives OpenClaw and Fable session recovery.** OpenClaw can
  rotate a conversation onto a new physical transcript after a CLI restart
  while retaining the earlier transcript IDs in `usageFamilySessionIds`.
  Agent Chat read only the newest file, so the conversation appeared to have
  lost everything before the restart. History now follows and chronologically
  merges the complete registry lineage.
- **Final answers stay at the bottom of long turns.** If an agent emitted its
  eventual answer before late tool or sub-agent activity and repeated it in the
  terminal frame, replay classified the answer as an early activity segment.
  The terminal frame is now authoritative and re-anchors that exact answer
  after the activity timeline.
- **Expired access cookies self-heal across every Agent Chat fetch path.** The
  shared fetch wrapper stamped actor authorization correctly but, unlike the
  Axios client, never refreshed an expired cookie. Session lists, history,
  heartbeat, approvals, and streamed sends could all begin returning 401s
  until a full login cycle. Authenticated requests now share one refresh and
  retry once under the original actor-generation lease.
- **Brief OpenClaw restart windows no longer cascade into Portal failures.**
  Throwaway gateway RPC connections retry only when the method provably was
  never written. A timeout or disconnect after dispatch is still never
  repeated, preserving at-most-once behavior for `chat.send` and mutations.

## [4.0.6] - 2026-08-02

### Fixed
- **Agent Chat shows the conversations that already exist on your server.**
  Only sessions the Portal itself created were ever listed. A chat started from
  the OpenClaw web UI, the command line, or any other lane on the same host had
  no ownership record in the Portal database, so it was invisible in Agent Chat
  — permanently, and with no way to recover it from the interface. The Portal
  Owner is the operator of that host, so their own sessions are now listed
  alongside Portal-created ones. Sessions scoped to a different Portal user are
  still hidden from everybody, and automation lanes (cron runs, sub-agent runs)
  stay out of the chat list.
- **Opening one of those chats shows its transcript instead of an empty room.**
  A session named `new-<timestamp>` is the Portal's own alias for "start a new
  chat", so the server rewrote it into the requesting user's namespace. OpenClaw
  names host-created chats exactly the same way, so opening a real conversation
  silently redirected to an empty one that had never been used. The rewrite now
  applies only when the key is not already an existing session belonging to the
  caller. A key owned by another user still never resolves to their transcript.

## [4.0.5] - 2026-08-01

### Fixed
- **Updates no longer abort because the Portal restarted the OpenClaw gateway.**
  Before replacing the pinned OpenClaw core package, the installer proves the
  running gateway is healthy so it has a rollback baseline to return to. It
  sampled that state instantly. The Portal, however, restarts the gateway from
  its own startup path when it reconciles visible-browser agent defaults, and
  the installer reaches this step seconds after it restarts the Portal — so on
  any host with Remote Desktop or a visible-browser agent configured, the
  gateway was reliably mid-restart at exactly the moment it was measured. A
  healthy machine was reported as `The existing OpenClaw gateway is not stably
  ready in the standard state layout` and the update failed after the Portal had
  already been upgraded, leaving the Dashboard offering the same update again.
  The installer now waits for the unit to settle before sampling it, and retries
  the baseline probe rather than condemning the host on a single miss. A gateway
  that has genuinely failed is still refused immediately, and an unstable one
  still fails closed, so the rollback guarantee is unchanged.

## [4.0.4] - 2026-08-01

### Fixed
- **The in-Portal update button can apply releases again.** The Dashboard runs
  the signed installer as a systemd transient unit. systemd starts root units
  with `USER` set but `HOME` unset, and the installer runs under `set -u` while
  reading `${HOME}` to locate root-owned agent state. Every update started from
  the Dashboard therefore aborted with `HOME: unbound variable` after building
  the candidate but before it was ever swapped in, leaving the Portal running
  its previous version. The installer now resolves `HOME` from the password
  database before anything references it, and the updater passes `HOME` through
  to the transient unit explicitly. Portals on 4.0.0, 4.0.1, 4.0.2, and 4.0.3
  are unblocked by this release with no manual step, because the updater fetches
  its installer from the release it is moving to.

## [4.0.3] - 2026-08-01

### Fixed
- **Portals installed before the 4.0 migration baseline can now update.** The
  update candidate verified the database by requiring the applied migration
  history to exactly equal the migrations bundled with the release. Databases
  created before the baseline was squashed legitimately retain their original
  pre-baseline rows, so that comparison could never balance and the update
  aborted with `Database migration inventory does not match the bundled Portal
  runtime`. The candidate now proves that every bundled migration is applied,
  in order, with a matching checksum, and that nothing unknown was applied from
  the baseline onward. Fresh installs are unaffected, and tampered, missing,
  rolled-back, or drifted schemas are still rejected.
- **HTTPS readiness now probes the addresses Caddy actually serves.** The
  readiness probes pinned themselves to `127.0.0.1:443`. When Caddy is bound to
  specific addresses, nothing listens on loopback, so the probe could never
  connect and every update and rollback stalled for the full 90-second timeout
  before failing. Probes now try loopback and each address Caddy is listening
  on. Certificate and hostname validation are unchanged.
- **A failed verification no longer stops a healthy Portal.** If verification
  failed after a rollback had already restored and started the previous Portal,
  recovery re-fenced the service and killed it, leaving the machine with no
  Portal running at all. Recovery now leaves a Portal that is running and
  serving the previous version in service, and only fences when nothing is
  serving.
- **Portals whose Caddy site was customised by hand can now update.** The
  managed Caddy converger only recognised a Portal site that still carried its
  installer ownership marker. On any host where that marker had been edited
  away — commonly while adding webhook routes, static asset handling, or custom
  security headers — the converger appended a *second* site block for the same
  hostname, Caddy rejected the whole file with `ambiguous site definition`, and
  the update aborted before it could start. The converger now detects that the
  hostname is already served, and if that site already proxies the Portal on
  `127.0.0.1:4001` it adopts the site untouched and reports that Portal routing
  is operator-managed on that host. Hand-written routes, headers, and matchers
  are preserved byte for byte. If the hostname is claimed by a site that does
  *not* serve the Portal, or by more than one site, the update stops with an
  explicit message instead of an opaque Caddy parse error.
- The isolated app-content hostname is checked the same way, so a colliding
  hostname is reported directly rather than producing an invalid Caddyfile.

### Withdrawn
- **4.0.1 and 4.0.2 are withdrawn and should not be installed.** Both carried
  the update fixes above, but were built from a branch cut before the final
  4.0.0 assembly, so their runtime omitted code that shipped in 4.0.0 —
  including the ask-a-question broker and plugin route, Project Chat restart
  recovery, and legacy Project continuity adoption. Installing either would
  have moved a 4.0.0 Portal backwards. 4.0.3 carries the same fixes on top of
  the complete 4.0.0 source and supersedes both.

## [4.0.0] - 2026-08-01

Portal 4.0 is a foundation release. It replaces several loosely connected feature paths with explicit ownership, isolation, recovery, and verification contracts across Agent Chat, Projects, providers, updates, backups, and the host workstation.

### Upgrade notes

- **Every user signs in again once.** The 4.0 identity migration invalidates existing session records because their stored hashes cannot be safely moved into the new authorization model. Accounts, roles, projects, files, apps, and managed data are retained, subject to the legacy Project safety boundary below.
- **Long-lived 3.x Projects are preserved, not auto-promoted.** Their files, exactly associated Apps, and App running/stopped intent are retained. Startup enrolls each exact old Project root as legacy `NONE`, never as 4.0-current. A Project with preserved 3.x OpenClaw lineage remains visible, but Project Chat and destructive Project-level operations stay unavailable until that lineage can be reconciled safely.
- **Use the Dashboard update path and take the backup preflight seriously.** The updater is operator-triggered; it does not install releases silently. It requires a fresh verified backup, displays signed release details, and rolls back a candidate that cannot pass migration and health checks.
- **Project Chat now requires an attestable container host.** Compatible kernel, Docker, and AppArmor behavior is required for confined Project runtimes. Unsupported nested-container hosts can use `--skip-project-runtimes`; the Portal installs, but Project Chat remains explicitly disabled.
- **Complete wipe has a stated boundary.** It verifies that each recorded managed path is gone. A copy moved elsewhere before uninstall is outside that record and can remain; review the host directly when it held sensitive data.
- **Fresh setup enables limited operational telemetry by default.** The Owner can turn it off during setup or later in Settings, and existing installations keep their saved choice. The Portal reports shortly after startup and then about every 24 hours while it remains running. Turning it off stops that operational report only: the separate Owner-Dashboard version lookup and manual refresh remain available, and the installer separately reports limited install and update lifecycle milestones regardless of the Portal setting.
- **Windows/WSL remains an experimental local preview.** The supported production targets are Ubuntu 22.04+ and Debian 12+ VPS hosts.
- **Multi-user account retirement is not in 4.0.** Destructive user removal remains disabled until sessions, projects, files, apps, shares, and runtime state can be removed or reassigned as one provable transaction. That work is planned for 4.1.

### Agent Chat and pending questions

- **Answer agents from anywhere in the Portal.** A waiting Agent Chat or Project Chat question now opens as a persistent, expandable notification. The existing question card supports choices, free text, Send, and Skip without navigating away from the current page.
- **Waiting questions have their own alert sound.** It respects the Portal sound and volume settings and degrades to a silent notification until the browser has allowed audio. Dismissing the notification means “not now”; it does not answer or skip the question.
- **Native pending input is tied to the exact user, request, run, and conversation.** Cross-user and cross-run answers are rejected, duplicate delivery is idempotent, and accepted answers carry bounded receipts rather than being guessed from chat text.
- **Active turns can be steered deliberately.** The composer stays available during supported active runs, targets the exact run, and distinguishes steering from a new message or explicit cancellation.
- **Long-running conversations use bounded durable event history.** Reconnect replay, restart-aware cancellation, transcript windowing, stable stream handlers, and bounded tool/thought timelines keep multi-hour work usable without unbounded browser growth.
- **Tool, approval, thought, maintenance, and completion events keep their shape across reloads.** Pre-tool text, paired tool results, compaction rails, visible reasoning, and finished assistant replies are preserved without replaying transient placeholders as conversation content.
- **Provider and model changes are explicit.** Incompatible launch-bound changes start a clean provider session instead of pretending to mutate a running harness, and model application is verified rather than silently falling back.

### Projects, Project Chat, and Apps

- **Project Chat is a separate execution boundary from host-operator Agent Chat.** Server-owned actor and project identity, one writable project mount, non-root/read-only containers, dropped capabilities, pinned images, and synchronous policy/runtime attestation are required before fresh and resumed turns.
- **Controlled public egress is Portal-owned.** Supported public web, Git, package, and asset traffic can leave a Project runtime while loopback, host, Docker peers, private ranges, metadata/link-local ranges, mixed DNS answers, rebinding, and public-to-private redirects are denied.
- **Providers qualify against the complete Project contract.** A provider remains unavailable when filesystem, identity, network, runtime, or live-container evidence is absent or stale; there is no fallback to the host workspace.
- **Project conversations have durable coordination.** Active-turn leases, provider switching, replay, abort/completion idempotency, transcript handoff cursors, exact pending-input ownership, and runtime cleanup survive ordinary reconnect and service-boundary races.
- **3.x Project continuity is conservative and fail-closed.** Startup attests and enrolls each exact existing Project root as legacy `NONE`, restores only an App whose owner, name, managed deployment path, and directory identity prove the association, leaves every other App standalone, and preserves the recorded running/stopped intent. It does not infer a 4.0-current identity from an old path. Projects with preserved 3.x OpenClaw lineage keep their files and exact App relationship, while Project Chat, rename, delete, and other destructive Project-level operations remain unavailable until safe reconciliation succeeds. Interrupted lifecycle work for 4.0-current Projects still resumes from leases instead of guessing at cleanup.
- **App deployment is transactional.** Source staging, dependency work, process promotion, proxying, and rollback preserve the last known-good deployment when a candidate cannot become healthy.
- **Standalone app sources are now part of backup and restore.** Update overlays preserve their source trees, and startup reconciles the full-stack apps that were marked running before maintenance.
- **Hosted-app and share boundaries are tighter.** Share tokens, passwords, expiry/use limits, active-content routing, API capabilities, bearer forwarding, request sizes, timeouts, and project-scoped activity are enforced by server-owned records.

### Providers and models

- **Provider setup now uses backend-owned capability and model catalogs.** Settings, Agent Chat, Project Chat, readiness checks, and removal controls read the same provider identities and exact model IDs.
- **Agent Zero is a first-class optional provider path.** OAuth lifecycle, connected-model discovery, exact-model validation, remote application, rollback, and project bridge admission fail closed when no usable account model exists.
- **Claude, Codex, Google, and xAI paths are separated by how they really authenticate.** Authenticated Claude CLI reuse is preferred with setup-token fallback; Codex account auth stays distinct from OpenAI API keys; Google IDs are canonical; xAI subscription OAuth, xAI API keys, and native Grok Build are not presented as interchangeable.
- **Provider versions are checked against the tested release.** OpenClaw core and the Codex plugin retain exact parity and rollback; external CLIs and optional tools report drift and use explicit maintenance paths instead of changing during every Portal update.
- **Credential removal is intentionally narrow.** Self-service transactional removal is limited to Portal-owned API-key rows whose ownership can be proven. Shared aliases, environment or secret references, OAuth/native-CLI credentials, local models, cloud chains, and unknown ownership require reviewed maintenance.
- **Ollama can run locally or on an identity-bound Tailnet GPU.** Remote setup uses a stable Tailscale identity and native Serve route rather than an arbitrary URL, with inventory, model pulls, byte progress, cancellation, diagnostics, bounded test inference, exact-digest checks, and no silent fallback to local compute.

### Setup, updates, backups, and recovery

- **Fresh setup starts with a secure Owner.** Public plaintext setup is denied, domainless setup uses an explicit localhost tunnel, HTTPS handoff is verified, and bootstrap credentials are origin-bound, expiring, single-use, and replay-resistant.
- **Optional readiness cards replace the old all-or-nothing wizard.** Domain/TLS, mail, providers, local models, Remote Desktop, and other capabilities can be completed with specific readiness evidence after the minimum secure launch path.
- **Signed artifacts bind source lineage to exact contents.** Release metadata, per-file hashes, migrations, runtime helpers, managed skills, and post-deploy provenance are checked before an update can report success.
- **Dashboard updates are serialized transactions.** Backup freshness, optional fresh-backup creation, maintenance ownership, database migration, OpenClaw/plugin compatibility, service startup, authenticated postflight, and rollback share one visible lifecycle.
- **OpenClaw and plugin compatibility changes roll back atomically.** Failed package, hotfix, syntax, version-parity, gateway, or readiness checks restore the exact prior package and preserved state before the updater exits.
- **ES-module validation now checks files in their real package context.** Piping an ES module through Node’s CommonJS stdin parser can reject both a valid candidate and its untouched backup; every install and rollback call site now validates the file path directly.
- **Reverse-proxy ownership is conservative.** Managed Portal/app blocks can be updated, a single compatible operator-owned Portal block is preserved, and ambiguous hostname ownership fails closed instead of overwriting custom routes.
- **Backups cover the managed recovery domains.** PostgreSQL, projects, standalone app sources, uploads, Portal state, mail state, OpenClaw state, manifests, and restore ordering are verified before a comprehensive backup authorizes maintenance.
- **Keep-Data reinstall reconnects retained state.** Reinstall and restore paths use the configured database, preserve app/project sources, remove stale runtime files safely, and recover transactionally from interrupted overlays. For a preserved 3.x Project, that continuity does not bypass the legacy lineage boundary or auto-enable Project Chat and destructive Project-level operations.
- **Telemetry is disclosed and controllable.** Fresh setup defaults limited Portal telemetry to enabled, shows that choice before completion, and lets the Owner turn it off there or later in Settings. The Portal reports shortly after startup and then about every 24 hours while it remains running. Its payload is limited to a random install ID, Portal/dependency versions, Portal user count, uptime, Node version, OS, and architecture; messages, prompts, project files, credentials, usernames, and email addresses are excluded. Turning it off stops that operational report only. The separate Owner-Dashboard version lookup and manual refresh send no operational telemetry payload but still create normal request metadata, and the installer independently reports install and update lifecycle milestones with the event type, Portal version, OS name/version, and the random install ID.

### Workstation and interface

- **Terminal now reflects the actual host.** Live capability discovery, reviewed actions, service-aware autocomplete, multiline-paste review, risk classification, reconnect, and bounded buffers replace a stale hard-coded command catalog.
- **Remote Desktop has a verifiable service contract.** Xauthority, session ownership, loopback listeners, clipboard, audio, browser control, launcher versions, deploy provenance, keep-awake behavior, and the real desktop session are checked; a rate-limited watchdog repairs eligible drift.
- **Files and uploads are bounded and recoverable.** Resumable parallel uploads, streaming downloads, archive limits, canonical paths, library/project transactions, chunk cleanup, previews, animated images, and protected active content share server-side containment.
- **Mail handles content and account state more defensively.** Scoped attachments, malware scanning, remote-content blocking, bounded upstream responses, durable mailbox reconciliation, forwarding, unread counts, and primary-account rules fail visibly.
- **Dashboard metrics are truthful.** Network throughput comes from an event-loop-safe collector and reports unavailable gaps rather than manufactured zeroes; expensive readiness and maintenance checks run independently with bounded refresh.
- **Settings and Admin follow runtime ownership.** Typed settings replace broad writes, elevated mutations use current account state, maintenance actions serialize, recovery controls remain available during outages, and role visibility matches backend authorization.
- **Light mode and accessibility are release-gated.** Editors, dialogs, previews, provider setup, chat, projects, maintenance, and administrative surfaces use one semantic palette with rendered component coverage and automated label/control checks.
- **Tasks, Tools, Skills, and Automations use durable jobs.** Operator-only mutations, typed confirmations, restart-aware state, replayable completion/cancellation, canonical skill identity, and bounded output replace untracked background work.

### Security

- **Authorization changes invalidate every relevant access path.** Browser sessions, API requests, Socket.IO, raw WebSockets, history/cache reads, attachments, and file capabilities follow a durable authorization generation; removed access triggers a privacy curtain and client-state purge.
- **Operator surfaces reload current role state.** Alerts, OpenClaw status, runtime inventory, Tools, Skills, jobs, host changes, and maintenance no longer trust a stale login-time role.
- **Content and network handling are fail-closed where ambiguity crosses a security boundary.** Paths, symlinks, archives, uploads, thumbnails, proxy destinations, app content, attachments, and supported account/workspace mutations use canonical containment, bounded parsing, and recoverable ordering.
- **Dependency audit disclosure:** the backend audit is clean. The frontend scanner reports `GHSA-qwww-vcr4-c8h2` against `react-router-dom@7.18.1`. That advisory affects React Server Components APIs; Portal is a React 18 Vite SPA and does not use RSC mode or the unstable RSC APIs. The tested routing version is retained for 4.0, and this release does not claim a zero-finding full dependency audit.

### Validation

- The complete backend regression run passed **276 suites / 3,426 tests**, with **1 additional suite intentionally skipped** (277 total). The complete frontend run passed **146 files / 1,151 tests** with no unhandled React errors.
- Backend and frontend production builds, type checks, zero-warning lint, accessibility checks, bundle budgets, PostgreSQL 16 pristine migration deployment, packaging, inventory, data-safety, restore, compatibility, update-transaction, plugin/hotfix rollback, and privacy gates passed on the release candidate.
- Upgrade validation covered both newly imported and long-lived 3.x Project/App shapes. It verified file and application continuity, exact Project↔App association, standalone App preservation, recorded process intent, idempotent replay, service health, and fail-closed behavior without treating an imported Project as proof of the legacy path.
- The update rehearsal surfaced the ES-module validation defect before release. The rejected candidate left the existing Portal and project state healthy, and the corrected updater then completed successfully.
- Release artifacts are built only from a clean commit and must pass exact inventory, public-origin, signature, content-hash, migration, privacy, and authenticated postflight checks before publication.

### Known limitations and 4.1 roadmap

- Browser audio can be silent until the tab receives a user interaction; the pending-question notification remains visible and answerable.
- The collapsed-rail waiting count opens the correct Portal section, not an exact conversation. The expandable notification is the answer-in-place path; exact-conversation navigation and durable notification history remain roadmap work.
- Project Chat is unavailable when the host cannot prove the required container isolation, and individual providers remain unavailable until they pass the complete qualification matrix.
- A Project with preserved 3.x OpenClaw lineage remains visible with its files and any exact App association, but Project Chat and destructive Project-level operations remain unavailable until safe reconciliation succeeds.
- Windows/WSL is experimental and does not replace the supported VPS deployment profiles.
- Complete wipe cannot discover data copied or moved beyond its recorded managed paths. Positive residue proof is planned for 4.1.
- Transactional multi-user account retirement is deferred to 4.1 rather than shipping a partial destructive flow.

## [3.26.1] - 2026-07-15

### Fixed
- **OpenClaw 2026.7.1 upgrades are safe on long-lived installs**: before the first upgraded gateway start, the updater now detects legacy state and plugin metadata that the new migration preflight can treat as fatal. Proven-obsolete artifacts are preserved in recoverable quarantine; unique or ambiguous records are left untouched and the upgrade fails closed.
- **Failed OpenClaw upgrades roll back automatically**: the updater preserves a local reinstallable copy of the exact previous OpenClaw package and restores any prepared legacy artifacts if package installation, gateway startup, version parity, or readiness verification fails.
- **Already-failed 2026.7.1 upgrades can recover through the normal updater**: an unready restart loop is stopped safely, the updater waits for OpenClaw's own startup-migration lease to expire, and then retries without deleting or bypassing the lease.
- **Gateway readiness checks now prove stability instead of sampling a crash loop**: completion requires HTTP readiness, authenticated RPC, matching pinned CLI/gateway versions, a stable PID and restart count, a clean current-start journal, and the expected startup-migration checkpoint.

### Maintenance
- **OpenClaw state repair remains deliberately narrow**: the updater never runs `openclaw doctor --fix`, never mutates unverified custom state layouts, and keeps provider credential cleanup outside this emergency compatibility patch.

## [3.26.0] - 2026-07-15

### Added
- **New recommended models**: Anthropic setup now recommends Claude Fable 5 alongside Opus 4.8. ChatGPT/Codex subscription setup now offers the GPT-5.6 suite (Sol, Terra, Luna) with GPT-5.5 as the compatibility choice for accounts without GPT-5.6 access.
- **Live reasoning for Claude models**: Agent Chat streams Claude's thinking in real time on OpenClaw 2026.7.1's native thinking lane for models that stream reasoning (e.g. Sonnet 4.6). Fable 5 turns run fully; their thought text is not streamed by the current upstream runtime.
- **Remote Desktop clipboard that actually works**: new "Send clipboard" and "Get clipboard" buttons on the Desktop page move text between your computer's clipboard and the remote desktop in one click, with clear success and error feedback. The in-session VNC clipboard bridge now starts automatically, so the classic VNC clipboard panel works too.

### Changed
- **OpenClaw runtime updated to 2026.7.1** (Codex plugin pinned to match). Includes upstream fixes for Claude CLI streamed replies, silent maintenance runs, and startup recovery.
- **Canonical Codex model route is now `openai/*`**: legacy `codex/*` and `openai-codex/*` references keep working and are migrated automatically during update.
- **Fast mode** is now available on all GPT (openai/*) Codex-runtime models, not just GPT-5.5.

### Fixed
- **Dashboard gauges no longer stall behind background scans**: OpenClaw, update, and maintenance checks run independently in a dedicated "System checks" section with per-check progress, and maintenance results are served from a short cache with background refresh.
- **Agent Tools is fast**: provider availability probes, skills and plugin listings no longer block the server while they run (async + cached) — the section opens in milliseconds instead of many seconds.
- **Automations no longer flag successful runs as errors**: portal-created jobs use no-target delivery, so run history reflects the actual agent turn result.
- **Codex Fast Mode** now applies to every supporting GPT model and is hidden entirely for models that do not support it.
- **Remote Desktop black screen fixed**: display power/screensaver blanking is disabled durably (a desktop component was re-enabling a 10-minute blank timer after startup), with a keep-awake guard for the session's lifetime.
- **Remote Desktop windows now stay reachable after resizes**: a window-fit watcher clamps any window stranded outside the new screen bounds back into view when the desktop resolution changes.
- **Session switching is dramatically faster**: chat history loading no longer rescans every session log on each request. Multi-second switch delays drop to near-instant on installs with long histories.
- **Session Controls are model-aware and fast**: the thinking slider now reads each model's supported levels from OpenClaw (including the new Ultra and Max levels for GPT-5.6 and Max/Adaptive for Claude models), the panel no longer takes many seconds to load, and thinking changes are validated against the session's own model instead of the global default.
- **Thinking-level changes no longer fail portal-wide when the default model has a restricted thinking profile**; unusable Claude 5 defaults are automatically demoted to a working model during update repair.
- **OpenClaw CLI recovery**: guards a 2026.7.1 crash in `openclaw models list` triggered by declared models without catalog pricing metadata.
- **Duplicated or fragmented thought bubbles**: cumulative reasoning snapshots are deduplicated and merged in place, in both live streaming and reloaded history.
- **Reasoning history growth**: streamed thinking no longer bloats the on-disk turn-event history during long thoughts.
- **Compatibility hotfix hardening**: per-patch isolation so one inapplicable patch can no longer block the remaining compatibility fixes; patches ported to OpenClaw 2026.7.1 bundles.
- **Long quiet turns no longer die with "CLI produced no output for 180s and was terminated"**: the CLI runtime's no-output watchdog window is raised so long silent reasoning stretches and slow tool calls complete instead of being killed mid-turn.
- **Assistant text written before a tool call no longer disappears on reload**: pre-tool message segments are preserved in durable history and render in their correct position in the timeline.
- **Tool calls and their results now pair correctly** instead of occasionally rendering as two separate entries.
- **Tool activity pills recognize the full current tool vocabulary** (CamelCase and MCP-prefixed tool names included), so actions show as styled, descriptive pills instead of a generic "Tool" badge.
- **Command approval popups no longer lock up**: approval dialogs reset cleanly between queued requests, a stuck submission can no longer freeze the page, failures show a clear retry/deny message, and approvals that already expired are dismissed automatically instead of lingering as dead popups.
- **Stale "Thinking…" bubbles purged**: transient status placeholders are no longer replayed into chat history as thought bubbles.
- **Reconnecting to a running chat no longer reports a false interruption**: coming back mid-turn re-attaches to the live stream instead of showing "interrupted by steering message" while the agent is still working, and sending a message to a session that is actually mid-turn now delivers it as a graceful steering message instead of interrupting the run.
- **Updates no longer erase chat runtime history**: persisted turn events (thinking segments, tool cards, stream recovery state) now survive portal updates.
- **Fresh installs and reinstalls hardened**: the generated web server config no longer references assets that do not exist on customer machines (which made the front page a 404 for logged-out visitors), the configured domain is preserved into the environment on reinstalls, and reinstalling over an existing account no longer resurrects the setup wizard in place of the login page.

### Security
- **Portal binds to loopback by default**: external access is served exclusively through the HTTPS reverse proxy. Existing installs are repaired during update; set HOST explicitly if you intentionally need a wider bind.
- **Persisted chat runtime data is now root-only** (0700 directories, 0600 files), with an update-time repair for existing installs.
- **Dependency security updates**: all non-breaking fixes applied, including axios (SSRF/auth bypass advisories), ws, form-data, lodash, path-to-regexp, http-proxy-middleware, and undici.

## [3.25.27] - 2026-07-08

### Fixed
- **Mail auto-forwarding is now true delivery-time forwarding**: Portal mail forwarding config installs a Stalwart Sieve `redirect :copy` rule, so incoming mail forwards as it arrives instead of waiting for someone to open or poll the Mail page.
- **Agent Chat preserves whitespace and live turn state during long OpenClaw runs**: runtime deltas keep exact chunk whitespace, long silent reasoning/tool gaps have wider stale windows, and recovery clears preserve visible thinking/tool bubbles instead of wiping them mid-turn.
- **OpenClaw update parity now targets the current stable runtime**: the installer and Codex plugin pin move to OpenClaw `2026.6.11`, with narrower config repair for current auth-store and Claude CLI provider metadata.
- **Various security improvements**: hosted apps, shared links, update packaging, and runtime configuration paths now apply stricter public/private boundaries.

### Maintenance
- **Release artifact building is stricter**: update artifacts now rebuild from fresh backend/frontend output and apply the same private-file exclusions consistently.
- **Regression coverage now guards mail forwarding, app file blocking, OpenClaw config repair, runtime history reassembly, and persistent gateway whitespace preservation.**

## [3.25.26] - 2026-06-22

### Fixed
- **Agent Chat reconnects now fail visible instead of hanging silently**: stale live-stream reconnect states have a recovery fuse that clears dead running/tool UI, restores durable history, and shows an interruption notice instead of leaving users stuck on a ghost bash/tool bubble.
- **Project Agent Chat works on domain-based installs with stale CORS settings**: WebSocket origin checks now allow authenticated same-origin upgrades by request host, so installs reached through Caddy HTTPS domains do not reject `/api/gateway/ws` with 403 just because `CORS_ORIGIN` still names an old IP.
- **Project Agent Chat preserves visible turn continuity during history catch-up**: local user/assistant bubbles survive short history refresh races until durable history catches up, preventing the user prompt from disappearing mid-turn.
- **OpenClaw runtime-only model catalogs no longer poison project-agent setup**: Gemini CLI and Antigravity runtime catalog entries are kept out of strict OpenClaw provider config unless they include a real provider endpoint, and stale invalid entries are cleaned before project-agent config patches.
- **OpenClaw agent session selection is more stable**: selected agents now persist concrete `agent:<agentId>:main` session keys, and stale `agent-chat-agentId=main` state self-heals instead of drifting back to the wrong session.

### Validation
- Live validation covered websocket auth probes, Project Agent Chat send/reload/history recovery, main Agent Chat rail/tool/thought streaming, and concurrent Project Chat + Agent Chat stress runs.

## [3.25.25] - 2026-06-21

### Fixed
- **Dashboard updates now restart the Portal if OpenClaw prep fails**: the installer keeps its recovery trap armed until after `bridgesllm-product` starts and `/health` passes, so a failed OpenClaw compatibility step cannot leave a customer portal stopped.
- **Switching Agent Chat providers or OpenClaw agents no longer aborts the active run**: changing the visible agent now detaches the UI from the current stream instead of sending `chat.abort`; explicit Stop and New Chat still cancel intentionally.

## [3.25.24] - 2026-06-21

### Fixed
- **OpenClaw compatibility hotfixes are now idempotent on current runtimes**: the bundled hotfix repairs duplicate Gemini streaming helper definitions left by earlier update attempts, validates OpenClaw bundles as ES modules, and refuses to report success if duplicate parser/dispatcher functions remain.
- **Portal updates now fail loudly if OpenClaw cannot boot**: the installer no longer ignores a failed OpenClaw gateway boot check after compatibility preparation, preventing updates from leaving Agent Chat broken while reporting success.
- **Agent Chat model loading no longer blocks the Portal backend**: OpenClaw model discovery now uses the gateway catalog first and only falls back to a short async CLI probe, so a slow `openclaw models list` cannot freeze the Portal health endpoint or UI.
- **OpenClaw model IDs remain provider-qualified**: gateway catalog rows that report bare model IDs plus provider metadata are normalized back to `provider/model`, preserving Codex, Claude, Gemini CLI, and Antigravity routing clarity.

### Validation
- Repaired an OpenClaw bundle that failed ES-module parsing with duplicate Gemini helper definitions, then verified a Codex smoke turn completed through `codex/gpt-5.4-mini`.

## [3.25.23] - 2026-06-21

### Fixed
- **The public installer now updates existing installs safely**: running the standard one-line installer on an existing Portal now routes into the update flow instead of silently rsyncing the install directory onto itself.
- **Caddy HTTPS config is preserved during updates and reinstalls**: normal updates no longer touch Caddy, and forced reinstalls recover the existing domain before writing proxy config so a blank `DOMAIN` cannot downgrade a working HTTPS site.
- **OpenClaw/Codex package parity is enforced after updates**: the installer pins OpenClaw and the Codex plugin to `2026.6.9`, restarts the gateway when the package changes, and verifies the running gateway version before reporting success.

### Improved
- **Agent Chat now uses OpenClaw's live model catalog**: OpenClaw model pickers include the currently reported Codex/OpenAI, Gemini CLI, and Antigravity models instead of relying on a maintained shortlist.
- **Google Gemini CLI setup reports credential state more honestly**: empty OAuth profiles no longer appear configured, and the setup flow includes a smoke check that distinguishes missing credentials from runtime model issues.

## [3.25.22] - 2026-06-20

### Fixed
- **Dashboard updates now harden Codex plugin compatibility, not just auth order**: the updater removes stale legacy `@openclaw/codex` install records, quarantines old global Codex plugin directories, and installs the compatible `@openclaw/codex@2026.6.8` plugin when inspection shows an unsafe source/version.
- **Codex auth repair is protected against stale plugin resurrection**: regression coverage now reproduces the legacy `plugins/installs.json` plus global `npm/node_modules/@openclaw/codex` state that caused OpenClaw to reject `openai:codex-cli` profiles.

## [3.25.21] - 2026-06-20

### Fixed
- **Dashboard updates now repair existing Codex/OpenClaw auth drift before restart**: the installer/update prep path bridges a usable native Codex CLI OAuth file into OpenClaw's current `openai:codex-cli` profile, removes stale `openai-codex:*` auth-order entries through the Portal helper, and then validates the gateway. This makes existing machines recover the same way fresh Settings-based Codex setup does.
- **OpenClaw repair remains scoped**: the updater still avoids `openclaw doctor --fix` and Caddy auto-upgrades; the new repair step only touches the Codex auth bridge managed by the Portal.

## [3.25.20] - 2026-06-20

### Fixed
- **Portal updates no longer run broad OpenClaw state repair**: installer/update runs now skip `openclaw doctor --fix` entirely, avoiding root-owned auth/profile rewrites, CLI relinking, and state migration side effects during a normal Portal update.
- **Caddy is protected during Portal updates**: the installer now reports the installed Caddy version but does not auto-upgrade it, keeping reverse-proxy/beta-site changes behind manual compatibility review.
- **Codex setup matches OpenClaw 2026.6 auth semantics**: the Portal uses the native Codex device-login flow, syncs the Codex auth file into OpenClaw's agent Codex home, and pins OpenClaw to a dedicated `openai:codex-cli` bridge profile instead of stale `openai-codex:*` auth-order entries.
- **OpenAI API keys and Codex subscription auth no longer collide**: provider status and auth pinning keep OpenAI API-key profiles separate from ChatGPT/Codex OAuth profiles so setting up one does not silently break the other.

### Maintenance
- **Regression coverage now guards the Codex auth bridge**: tests verify that Codex login preserves existing OpenAI API-key profiles, removes stale `openai-codex` auth order, and copies usable Codex credentials for OpenClaw runtime use.

## [3.25.19] - 2026-06-20

### Fixed
- **Agent Chat keeps pace with current OpenClaw model IDs**: Codex OAuth now uses the current `codex/...` model family, Claude recommendations include the current Opus option exposed by OpenClaw, and stale fallback IDs are repaired more consistently.
- **Google subscription setup no longer points users at the retired Gemini CLI path**: Google Antigravity is treated as the native Gemini coding-agent path, with old Gemini CLI model IDs mapped away from dead selections.
- **OpenClaw model pickers are smaller and less misleading**: unsupported Google/Gemini rows are hidden from the OpenClaw catalogue while Antigravity shows only the Gemini models reported by the native Antigravity CLI.

### Improved
- **Provider setup copy is more honest**: Antigravity carries a temporary “not fully supported for now” warning for OpenClaw-native OAuth while the Portal-native Antigravity flow remains available.
- **Backup and OpenClaw compatibility maintenance are safer on updates**: backup runner/timer setup and OpenClaw long-run relay compatibility checks handle already-current runtimes more defensively.

## [3.25.18] - 2026-05-31

### Fixed
- **OpenClaw compatibility hotfix checks no longer warn on already-current runtimes**: the updater now treats missing legacy relay patch blocks as “not needed” instead of reporting a failed hotfix when the installed OpenClaw bundle has already moved past that patch shape.

## [3.25.17] - 2026-05-31

### Fixed
- **Portal backups are installed and scheduled again**: the release artifact now includes the canonical `backup-full.sh` runner, installer/update paths enable daily, weekly comprehensive, and monthly systemd backup timers, and stale cron entries pointing at old source-checkout paths are removed automatically.
- **Manual normal and comprehensive backups work from Settings**: the backup API now calls the installed backup runner directly, preserves the `comprehensive` backup type instead of mapping it to weekly, and reports a clear install error if the runner is missing.
- **Codex terminal-event false failures are handled more defensively**: if OpenClaw reports that Codex stopped before confirming `turn/completed` after assistant text is already visible, the Portal completes the turn instead of surfacing a misleading failure.
- **Maintenance status ignores held package drift**: apt-held packages such as locally held `cloud-init` no longer keep the dashboard/Admin Maintenance view stuck on actionable package updates after real maintenance is complete.

### Improved
- **Backup schedule visibility now covers systemd timers**: the backups endpoint reports both legacy cron entries and the current `bridgesllm-backup*` timer/unit state.
- **OpenClaw Codex harness defaults are less brittle for long turns**: installer/update configuration sets a longer Codex app-server completion idle window for supported OpenClaw installs.

## [3.25.16] — 2026-05-31

### Added
- **Admin Maintenance is now the control center for server drift**: admins get a guarded Maintenance tab with current OS/kernel/update/backup/service state, compatibility guardrails, action risk labels, impact/recovery notes, recent job history, and themed action confirmations.
- **Dashboard maintenance alerts are useful without becoming the cockpit**: the Dashboard now surfaces maintenance/security drift as a dismissible notification and routes action to Admin Maintenance instead of exposing broad server controls in the daily dashboard.
- **Safe maintenance actions run as background jobs**: owner-approved actions can generate a read-only maintenance plan, prepare a reboot checklist, refresh apt metadata, create a maintenance backup, or run guarded security-only updates.

### Fixed
- **Full-stack app stops now terminate the real listener**: full-stack app processes run in their own process group, and `stopApp()` signals that group, waits for the port to close, and falls back to SIGKILL when needed so `npm start` child processes cannot keep serving after the portal reports the app stopped.
- **Agent Chat status/thought messages survive refreshes better**: assistant status events are now persisted and replayed with runtime history so refreshes no longer drop important progress/status context from active or recent turns.
- **Codex app-server idle timeouts are handled more defensively**: if Codex reports a `turn/completed` idle timeout after visible assistant output already reached the portal, the turn is completed cleanly; otherwise the UI shows a recoverable delayed-completion status before failing.

### Improved
- **Maintenance automation respects Portal compatibility boundaries**: broad upgrades remain review-only, reboot remains scheduled/manual, and security automation now blocks when protected Portal-managed packages such as `bridgesllm*`, `openclaw*`, `stalwart*`, `stalwart-mail`, or `caddy` need compatibility review first.
- **Background task discovery is cleaner**: maintenance jobs remain reachable from Admin Maintenance and job history, while the global sidebar avoids a Background Tasks destination that users do not need during normal portal work.

### Maintenance
- **Release validation now covers the real maintenance and app-process failure modes**: automated and live checks cover maintenance UI/action flows, Codex idle-timeout handling, status-history replay, and full-stack app start/stop/start behavior through the Portal API.

## [3.25.15] — 2026-05-30

### Fixed
- **Agent Chat is compatible with current OpenClaw runtime releases again**: live turns now keep thinking, tool activity, final replies, and completion state aligned across active streams, reconnects, and refreshes instead of dropping completed messages or replaying runtime bookkeeping as chat text.
- **Project agents use the same reliable chat path as the main Agent Chat surface**: project chat now restores live progress, replies, model labels, and persisted history cleanly after reloads, while avoiding stray tool artifacts and stale reconnect warnings in the project Agent panel.
- **OpenClaw provider setup keeps pace with current CLI and config formats**: Codex, Gemini, and Claude setup flows handle newer OAuth/setup-token prompt shapes, register provider model catalogs in the runtime config OpenClaw now validates, and clean stale provider auth/model state more completely.
- **Native Claude Code approvals now work from the browser**: when Claude Code asks for permission to read files or run shell commands, the portal surfaces the existing approval popup, resolves the decision, and retries the turn with the approved one-turn tool/path scope.
- **Native Codex CLI approvals now recover from sandbox blocks**: Codex starts in a workspace-write sandbox, detects permission/read-only failures, asks for approval through the portal, and retries once with the approved execution scope instead of leaving the user stuck with a failed tool attempt.
- **Native Gemini CLI tool execution is approval-gated**: prompts that look like file, shell, or tool work now request approval before enabling Gemini headless tool execution; denied turns continue in read-only plan mode.
- **Native Codex and Gemini tool activity now streams visibly**: shell/tool starts and completions are shown in the same chat rail as other providers, including command output where available.
- **Long tool-heavy histories keep the real conversation**: enhanced history now merges runtime turn events through a wider recovery window, preserves thinking/tool segments after refresh, and prevents duplicate tool-only records from pushing the user prompt and final answer out of view.

### Improved
- **Provider capability reporting is more honest**: OpenClaw, Claude Code, Codex CLI, Gemini CLI, and project agents now advertise their history, model-selection, follow-up, and approval capabilities more accurately to the UI.
- **Model patching is more compatible with OpenClaw runtime families**: the portal now maps selected provider models to the runtime-specific form OpenClaw expects before patching sessions, reducing stale-model and unsupported-model errors.
- **Live status rails are quieter and more deliberate**: command approvals, context maintenance, memory flushes, compaction, and reconnect states are filtered into status rails only when they are actual runtime notices.

### Maintenance
- **Release validation now covers the real browser flows**: bundled validation harnesses exercise normal Agent Chat and project Agent panel sends against a deployed portal, including live progress, reload persistence, enhanced history, and artifact filtering.
- **Regression coverage was extended around native adapters and runtime history**: tests now protect Claude/Codex/Gemini adapter behavior, provider capability metadata, OpenClaw CLI parsing, AI setup registration, stream rail filtering, and runtime event history recovery.
- **Public export checks were re-run for this release**: the export scanner checks sensitive-file patterns and beta/staging contamination before publishing the source tree.

## [3.25.14] — 2026-05-11

### Fixed
- **Remote Desktop clipboard tools now repair existing installs during updates**: Remote Desktop setup now idempotently installs missing VNC/XFCE clipboard packages, including `xclip` and `xsel`, even when reached from the update path instead of a fresh install.

## [3.25.13] — 2026-05-11

### Fixed
- **Remote Desktop clipboard works on fresh installs**: the installer now includes `xclip` and `xsel`, matching the backend clipboard bridge requirements so copy/paste setup does not fail after provisioning.
- **Mobile app-mode browser navigation stops fighting the keyboard**: the shared browser and OpenClaw UI app-mode address bars now preserve focused/manual URL edits instead of refreshing over typed text every few seconds.

### Improved
- **Remote Desktop copy/paste labels are clearer**: the clipboard panel now uses direction-based names like “Get Remote”, “Copy to Me”, “Get from Me”, “Set Remote”, and “Paste Remote” instead of internal bridge terminology.
- **Shared browser nav injection is more reliable**: the launcher now waits for nav script injection confirmation instead of racing ahead immediately after navigation.

## [3.25.12] — 2026-05-10

### Fixed
- **OpenClaw refresh and reconnect recovery is boring again**: Agent Chat and project chat now subscribe to live session events, preserve context-maintenance markers across reloads, and avoid reporting stale active streams after a run has already finished.
- **Compaction and memory-maintenance notices no longer masquerade as assistant prose**: compaction, memory flush, heartbeat, and skipped-maintenance markers are recognized only when they match anchored runtime notices, so ordinary chat text stays visible as normal conversation.
- **Project chat avoids duplicate sends during gateway reconnect pressure**: accepted persistent gateway RPC calls now fail visibly instead of retrying non-idempotent sends through a second socket that can disrupt the active stream.
- **AI provider setup no longer writes unsupported OpenClaw model metadata**: provider discovery now strips portal-only runtime fields before saving model config, preventing gateway restart failures on current OpenClaw builds.
- **Codex/Gemini/Claude OAuth handoffs are more tolerant of terminal prompt changes**: callback-paste prompts are detected even when the CLI renders them one character per line or with newer wording.
- **Fresh installs require a Node.js version new enough for current OpenClaw**: the installer now repairs old Node 22 minors and verifies Node.js 22.16+ before continuing.

### Improved
- **Dashboard health now detects stale OpenClaw gateway processes**: admins get a clear version-mismatch warning and a controlled restart action when the installed OpenClaw package and running gateway listener diverge.
- **Session and provider pickers stay usable while refreshing**: Agent Chat keeps the current selection visible, shows inline loading states, and avoids replacing the whole control with a generic spinner.
- **Remote Desktop launchers fit shared browser windows more reliably**: bundled shared-browser and OpenClaw UI launch scripts now adapt to the VNC work area and preserve in-page navigation controls on compact desktops.
- **Release packaging keeps the visual assets together**: the tarball and hosted artifacts include the current favicon, logo, provider icons, Remote Desktop icons, noVNC icons, and portal branding assets.

### Maintenance
- **Regression coverage was extended for provider setup and OAuth prompt parsing**: tests now protect model-config cleanup and callback prompt detection paths that previously depended on fragile CLI output shapes.
- **Public release metadata was refreshed**: README, changelog, hosted installer metadata, and LLM-facing product summaries now point at v3.25.12 without private deployment notes.

## [3.25.11] — 2026-05-08

### Fixed
- **Project chat no longer risks duplicate sends after gateway reconnect pressure**: backend gateway RPC calls now surface persistent WebSocket failures directly instead of retrying non-idempotent requests over a throwaway `gateway-client` connection that could evict the live stream.
- **Explicit project model switches now actually patch stale gateway sessions**: when a user requests a model, the portal compares against the live gateway model instead of trusting stale `.agent-session.json` state, so the UI and runtime model stay aligned after gateway refreshes.

## [3.25.10] — 2026-05-08

### Fixed
- **Project chat now shows Gemini CLI-backed replies again**: project assistant polling falls back through OpenClaw gateway history and Gemini CLI transcripts when the gateway session registry points at a missing local JSONL, so real sends no longer complete invisibly.
- **Project assistant startup no longer self-poisons fresh sessions**: session initialization now avoids the broken legacy chat-completions warmup path, records the selected model locally, and resumes existing project agents without blocking on slow config round-trips.
- **OpenClaw runtime maintenance now has honest status rails**: heartbeat checks, memory flushes, context maintenance, and compaction events now surface as maintenance indicators instead of being replayed as fake chat content or generic thinking state.
- **Project-agent rails keep tool activity visible during maintenance**: running tool labels stay visible while OpenClaw performs memory/context maintenance, with finished maintenance shown as a completed rail instead of a stuck spinner.
- **Fresh mail setup no longer depends on Stalwart `latest`**: setup and Settings mail installers now pin `stalwartlabs/stalwart:v0.15.5`, avoiding the newer Stalwart admin API drift that broke domain provisioning on fresh installs.
- **Agent Chat history recovery is more resilient for reused OpenClaw session aliases**: history loading now resolves `new-*` / `portal-new-*` aliases and recovers transcript messages from matching trajectory snapshots when the session registry points at a stale or stub session.

### Improved
- **Gateway metadata calls are bounded and less disruptive**: project chat and telemetry prefer direct session describes, reuse the persistent gateway WebSocket, and fall back to local session registry data when metadata is temporarily slow instead of turning harmless refreshes into user-visible failures.
- **AI setup cleans stale provider auth state when pinning OAuth credentials**: successful provider setup now removes same-provider stale profiles and usage metadata while preserving unrelated providers, making provider status and default routing less ambiguous after reconnects.
- **Regression coverage now protects the maintenance rail and Stalwart image pin paths**: targeted rail assertions and backend tests cover maintenance/tool rail behavior and prevent accidental reintroduction of drifting mail-server tags.

## [3.25.9] — 2026-05-06

### Fixed
- **Gemini-backed Agent Chats keep finished turns after the stream ends**: when local OpenClaw session history lags behind the imported Gemini transcript, the portal now appends the newer transcript tail instead of dropping the completed assistant reply, tool cards, or visible reasoning on refresh.
- **Fresh OpenClaw `new-*` sessions stay attached to the right chat**: Agent Chat now normalizes portal-created session aliases before history reloads and session lookups, which prevents completed turns from disappearing behind mismatched session keys.
- **AI account setup is sturdier across Codex, Gemini, and Claude**: the sign-in and setup flows now preserve callback state more carefully, normalize discovered model IDs consistently, and recover provider-auth handoffs more reliably.

### Improved
- **Compatibility Patch status is more truthful on current OpenClaw bundles**: the checker and bundled helper now resolve the imported Gemini CLI backend and newer heartbeat detector variants, which prevents false “patch missing” warnings after a successful apply.

## [3.25.8] — 2026-05-01

### Improved
- **Hosted updates ship the current OpenClaw compatibility helper**: the public installer and tarball moved forward with the validated relay, reply-routing, and Gemini CLI compatibility fixes instead of relying on a manual follow-up repair.
- **The public release path was revalidated against current OpenClaw builds**: portal-backed chat and provider discovery were rechecked before shipping the compatibility update so the hosted download stayed aligned with the current runtime.

## [3.25.7] — 2026-04-28

### Fixed
- **OpenClaw session sidebar no longer stalls the whole portal**: the main Agent Chat sessions list now uses session metadata instead of opening large transcript/checkpoint files just to build sidebar labels and previews, which stops event-loop stalls that were making gateway chat, hosted pages, and shared pages look like they were disconnecting or timing out.
- **Main-session list polling is bounded instead of re-parsing the world on every refresh**: the parsed OpenClaw main-session registry is now cached briefly by file stat, which keeps admin/session polling from pinning the Node main thread on busy installs.

## [3.25.6] — 2026-04-28

### Fixed
- **Claude setup-token links are clean again**: the AI Setup backend now extracts the Claude authorize URL without swallowing the trailing terminal prompt, so Anthropic sign-in no longer hands the browser a malformed `state` parameter.

### Improved
- **Portal/OpenClaw compatibility checks track newer upstream bundle names**: the admin hotfix status path and bundled compatibility helper now recognize `heartbeat-events-filter-*` and `claude-live-session-*` layouts while keeping the Gemini runtime/tool wiring checks intact.
- **OpenClaw chat defaults are more sensible for non-Claude models**: Agent Chat and project chat now fall back to `high` thinking when Claude-specific adaptive defaults do not apply, and Codex setup copy better explains the stable default versus fallback model options.

## [3.25.5] — 2026-04-22

### Fixed
- **Gemini OAuth setup now stays aligned with the default-model picker**: finishing Google sign-in no longer leaves the selected Gemini default model in an inconsistent state, so the connected provider is ready to use with the expected model choice.
- **Compaction notices are rendered through one shared component**: Agent Chat and project chat now reuse the same compaction notice block, and restored history dedupes repeated compaction notices instead of echoing them back at the user.

### Improved
- **The public install experience is clearer on the marketing site**: the hero install area now presents separate Linux and Windows one-paste commands with dedicated copy buttons, keeping the public-facing release path explicit and free of internal-only notes.
- **The installer has a real Windows / WSL local beta path**: localhost mode now auto-detects on WSL, skips VPS-only reverse proxy and firewall setup, and gives Windows users a first-class test-drive flow before they rent a server.

## [3.25.4] — 2026-04-19

### Improved
- **Installer and updater flows now auto-apply the validated OpenClaw compatibility patch set when needed**: normal install and update runs bring the relay and Gemini runtime markers forward automatically instead of leaving that repair stranded behind a manual Settings action.
- **Agent Chat and project chat handle active OpenClaw runs more honestly**: supported OpenClaw sessions now use a real interrupt-and-steer path for in-turn follow-ups, immediate `Thinking…` state is surfaced as soon as the run is accepted, tracked runs can finish cleanly even if the last browser subscriber drops, and the current session dropdown/header now labels the actual chat instead of acting like a blind history counter.
- **History restoration is much cleaner in both main and project chat**: hidden Portal Backend RPC / async completion / heartbeat envelope artifacts are stripped or summarized instead of being replayed as if they were real user-visible conversation.
- **Project agents are finally back in a sane repo workspace**: project chat now binds the repo into `/workspace/project`, restores automatic assistant commits after successful runs, sets a local git identity if one is missing, and shelves transient `.agent-*` / `.assistant-*` scratch files so auto-commit and revert flows stop tripping over portal-maintenance state.
- **AI setup and provider state are more truthful across Claude, Codex, Gemini, and key-based providers**: model IDs are canonicalized consistently, fallback-model registration survives current OpenClaw CLI output shapes, provider removal cleans both auth and model config, Claude setup-token flow shows live finishing output instead of looking frozen, Gemini/Codex native CLI auth handling is sturdier, and provider status surfaces now do a better job distinguishing configured, expired, refreshable, and cooldown states.
- **Windows / WSL local beta messaging is explicit now**: the installer, setup surfaces, Projects/Apps UI, and bundled docs now say plainly that localhost WSL installs are an experimental test-drive path, while public hosting, stable share links, and custom-domain HTTPS remain VPS-first.
- **Admin/runtime copy and controls are clearer**: Settings and Agent Chat now describe the compatibility action as a fallback after separate OpenClaw upgrades, show both relay and Gemini patch markers, expose an OpenClaw compaction-notice toggle, and recognize more tool aliases in live tool-status presentation.

### Fixed
- **OpenClaw “live note” ambiguity is gone on capable runtimes**: the portal no longer pretends assistant-side injection is real steering when `sessions.steer` is available, and the UI now says “interrupt and steer” when that is what will actually happen.
- **Claude setup-token handoff no longer stalls after the auth code paste step**: the backend captures tokens earlier, cleans up stale helper processes, and lets the frontend show progress while Claude finishes instead of leaving the user staring at a silent spinner.
- **Project git operations are less fragile around assistant scratch state**: revert now ignores transient portal files automatically, dirty-tree errors name the real blocking files, and assistant auto-commit no longer sweeps session metadata into user commits.
- **Provider model/config cleanup is more complete**: removing a provider now clears the related `models.json` / config state too, which prevents stale defaults and fallback remnants from lingering after auth is removed.

### Maintenance
- **The bundled compatibility helper now ships the full Gemini-aware patch path through the normal release channel**: current release artifacts carry the hashed-bundle relay fix, heartbeat `persistedLastTo` preservation, Gemini CLI `stream-json` / `--yolo` patching, and Gemini runtime tool-event wiring that were validated during the release audit.
- **Release coverage and docs were extended to match the new setup/runtime behavior**: 3.25.4 adds focused regression tests for AI-setup model normalization and OpenClaw CLI JSON parsing, plus a bundled `docs/WINDOWS_WSL_BETA.md` reference for the new localhost beta path.

## [3.25.3] — 2026-04-17

### Improved
- **Agent Chat and project chat finally reconcile live state with history correctly**: pending user turns and the active assistant bubble now survive history reloads, post-turn reconciliation waits for the gateway to catch up, and reloads restore separate thinking, tool, text, and compaction phases instead of flattening them into one stale transcript.
- **Live tool activity is much easier to follow**: main chat, project chat, and the composer status rail now share tool-specific icons, labels, and status copy, and running tools stay visible during compaction or maintenance instead of being overwritten by fake generic “thinking” states.
- **Fresh OpenClaw sessions behave like real sessions earlier**: synthetic `new-*` portal sessions are materialized on demand, session-model patching can create the concrete OpenClaw session before first send, session-control loading states are more honest, and model discovery now reads the live OpenClaw config directly instead of shelling out through a brittle CLI path.
- **Projects regained richer public-safe file viewers**: the lazily loaded Monaco/text, Markdown/HTML preview, PDF, spreadsheet, and binary-file viewer components are back in the public source tree, which restores clean public builds and broadens in-browser preview coverage.
- **Gemini subscription setup is a first-class path now**: the provider catalog now includes Google Gemini account OAuth with guided instructions, and the OAuth prompt automation is more tolerant of Gemini’s evolving CLI prompt order.

### Fixed
- **The post-turn stale-history race behind disappearing or duplicated assistant turns is closed**: a just-finished local turn is no longer immediately overwritten by stale gateway history, which fixes the refresh-only chat-state regression that showed up most painfully in live OpenClaw runs.
- **Streaming merge logic no longer eats letters or spaces while deduping replay noise**: small token deltas are preserved, while large repeated suffix or cumulative chunks are still de-duplicated safely.
- **Fresh-session model drift and 404s are fixed**: the portal now normalizes `portal-*` session slugs consistently and can create concrete OpenClaw sessions before reading info or patching models, stopping `new-*` session keys from silently failing session-info and model requests.
- **Deploys stop serving stale hashed frontend bundles longer than they should**: the production SPA HTML cache now refreshes its source snapshot before computing the cache key, so deep links stop clinging to old bundle filenames after a deploy.
- **Login, auth, and setup handoff are sturdier**: post-login navigation can force a clean reload when needed, provider setup completion now refreshes surrounding settings state, and auth parsing prefers explicit Bearer headers over stale cookies.
- **Remote Desktop access is tighter and less foot-gunny**: raw websockify is loopback-only, audio proxy ports are configurable, noVNC and audio routes require elevated portal auth, and readiness/docs now reflect the real loopback-only expectation.
- **Gateway restart fallback is safer on hosts without usable user-systemd**: when `openclaw gateway restart` cannot manage the service, the portal falls back to restarting the system service or signaling the live gateway so runtime compatibility fixes actually take effect.

### Security
- **Public release/export safety got stricter**: the GitHub export script now blocks dirty working trees by default and scans for beta or staging infrastructure markers before anything can be pushed publicly.

### Maintenance
- **Regression coverage was added for tool-phase maintenance snapshots**: `StreamEventBus` now has direct tests for keeping a running tool visible while compaction or maintenance events arrive.


## [3.25.2] — 2026-04-14

### Fixed
- **Portal compatibility hotfix status/apply works again on current OpenClaw installs**: the admin checker now inspects the real hashed `heartbeat-runner-*` and `get-reply-*` bundles instead of stale stub targets, recognizes the current exec-completion detector shape already shipped upstream, and stops falsely reporting modern OpenClaw builds as unsupported when the long-run relay hotfix can still be applied safely.

### Maintenance
- **This patch release keeps the public release path honest**: current portal builds, hosted installer artifacts, and the public GitHub export now all reflect the same compatibility-fix behavior instead of requiring private manual knowledge to recover newer OpenClaw installs, and the public source export once again includes the lazily loaded project viewer components needed for a clean frontend build.

## [3.25.1] — 2026-04-13

### Fixed
- **Installer and updater release parity for the OpenClaw relay hotfix helper is restored**: `scripts/patch-openclaw-long-run-relay-hotfix.sh` now reliably targets the real hashed `heartbeat-runner-*` and `get-reply-*` bundles in current OpenClaw installs instead of the wrong stub or old reply filename, so installer and in-place update users receive the same long-run webchat relay / heartbeat `persistedLastTo` compatibility fix that production needed.

### Maintenance
- **This patch release exists to ship the helper refresh through the normal public release channel**: installer downloads, hosted `portal.tar.gz`, and source release metadata are now aligned again instead of leaving the fix stranded only in GitHub source.

## [3.25.0] — 2026-04-12

### Improved
- **Agent Chat and project chat status behavior is finally consistent**: the shared `ComposerStatusBadge` rail now drives both chat surfaces, project chat no longer renders its own stray inline stop control, and reconnect, compaction, queue, and lifecycle messaging follow the same presentation rules in both places.
- **Project chat became a first-class agent surface**: resumed runs are surfaced correctly, exec approvals resolve with the same queue-aware modal flow used in main Agent Chats, auth refresh is attempted before reconnect after auth-failure closes, pending approvals are cleared on abort/reset/finalize paths, slash-command model changes persist to the same restored key, and live model/provenance metadata is applied before the terminal `done` event.
- **Auth and setup flows are more coherent end to end**: protected deep links preserve their redirect target through unauthenticated fallthrough, setup/reinstall UI now tells the truth about password requirements, reinstall mode is treated as a first-class route gate, and post-setup handoff retries cleanly across the backend restart window instead of trapping users on a completion spinner.
- **Admin and operator surfaces are more truthful**: Dashboard gateway reconnect and update UI now respect viewer role, Feature Readiness is available to `SUB_ADMIN`, General settings inputs keep draft state while temporarily blank, and several route descriptions and empty states were rewritten to read like finished product rather than internal tooling.
- **Cold-open responsiveness improved across the app**: Agent Chats, Dashboard, Projects, Files, Mail, and Settings all shed real first-open work through page-boundary lazy loading, deferred charts/models/session-history fetches, demand-driven direct-gateway bootstrap, and bounded thumbnail concurrency.

### Fixed
- **Misleading thought-process chrome is gone**: the redundant per-turn `ThinkingBlock`, `Internal monologue`, and `Thought process` UI was removed from both main and project chat, leaving the status rail as the single truthful in-turn state surface.
- **Non-admin approval dead-ends were closed**: normal users no longer open a reconnecting admin-only approvals stream, non-admin `exec_approval` requests are auto-denied server-side instead of surfacing unusable prompts, and project chat now actually exposes approval state to elevated users who can act on it.
- **Authenticated background polling is quieter and safer**: assistant-status, Ollama status, and session-list pollers now stop promptly when auth is gone, and repeated missing-token or invalid-token backend warnings are deduped instead of flooding logs every few seconds.
- **Password and session cleanup now matches user expectations**: reinstall reset, password reset, and authenticated password change all revoke prior sessions and clear stale auth cookies so the user-visible handoff matches the actual security behavior.
- **Registration, account identity, and setup defaults are more reliable**: the fallback registration mode is consistently `approval`, email identity handling is case-insensitive across login/reset/registration/profile checks, and reserved mailbox names like `support` and `noreply` can no longer leak into ordinary user-account paths.
- **Dashboard and status recovery are more honest during reconnects**: stream-status hydration now keeps status-only and compaction-only active snapshots alive across reconnects, lifecycle maintenance text is preserved instead of being collapsed to generic thinking copy, and stale pre-tool assistant text is no longer rehydrated as if it were fresh live output.

### Security
- **Route access now matches the UI contract more closely**: background tasks are admin-only, interactive Files/Projects/Apps routes require approved interactive users, terminal deep links now resolve through the real admin gate, and direct-gateway `chat.inject` was tightened back down to elevated users only.
- **Public and shared data exposure is tighter**: `GET /api/settings/public` no longer carries internal operational config, reinstall status exposes a masked owner hint instead of raw identity, and release packaging excludes the placeholder Prisma database and other internal-only artifacts.

### Maintenance
- **OpenClaw compatibility hotfixing is tougher on current installs**: the bundled `scripts/patch-openclaw-long-run-relay-hotfix.sh` now resolves hashed bundle filenames and patches both older and current OpenClaw dist shapes, including the direct-webchat heartbeat relay fallback and heartbeat-specific `persistedLastTo` preservation branch the portal still depends on.
- **Release packaging is safer**: `scripts/build-release.sh` now explicitly excludes `backend/prisma/dev.db`, copies the freshly built tarball and installer to the marketing site, and keeps the release path aligned with the actual hosted install artifacts.

## [3.24.1] — 2026-04-09

### Fixed
- **Agent Chat recovers faster after gateway restarts** — the persistent OpenClaw WebSocket now clears stale reconnect timers and resets retry state when the portal explicitly asks it to reconnect, which stops startup-time restart churn from stretching into dead-looking chats.
- **Managed portal skill sync stops thrashing unchanged installs** — Remote Desktop now hashes the bundled portal skill and skips unnecessary refreshes when the installed copy is already identical.
- **Installer repairs the OpenClaw gateway service more aggressively** — updates now rewrite the gateway unit to run `openclaw gateway --port 18789`, enable it, and retry a clean boot when stale gateway processes or port conflicts block startup.

## [3.23.10] — 2026-04-09

### Fixed
- **Dishonest in-turn steering UI was cleaned up** — the purple follow-up pill under the composer is gone instead of pretending `/steer` works reliably in the current OpenClaw path.
- **Agent Chat copy now says what it actually does** — "Live FYI / steer" wording was replaced with "live note" language in capability pills, the running composer placeholder, and send-button text.
- **Bundled OpenClaw hotfix helper now patches current installs cleanly** — `scripts/patch-openclaw-long-run-relay-hotfix.sh` now recognizes both the older and current bundle shapes for heartbeat detection, relay routing, and reply-state preservation.

## [3.23.9] — 2026-04-09

### Improved
- **Main-chat and project-chat session controls got a real upgrade** — OpenClaw sessions now expose native fast mode controls more cleanly, project chats gained thinking controls, and session-control state behaves more consistently across reconnects and recovered sessions.
- **Model switching is more trustworthy** — the portal now normalizes model IDs reported back from session info, preserves intended project models, and reduces stale-model fallbacks that used to make model changes look like they silently failed.
- **Project switching and session switching are more resilient** — project chat state, selected session metadata, and reconnect behavior now survive switching flows with less stale state and fewer ghost controls.
- **Long-run and interrupted chat recovery is tougher** — reconnect behavior, control filtering, hidden-resume handling, and yielded-run recovery were tightened so stale streams and phantom resumes are far less likely.
- **OpenClaw compatibility hotfix is now explicit and admin-controlled** — admins can inspect the installed runtime patch state and apply the older OpenClaw long-run relay hotfix directly from Agent Chat session controls or Settings instead of relying on hidden manual server edits.
- **Ollama defaults were refreshed** — recommendation defaults now line up with the current Ollama guidance shipped in the portal.

### Fixed
- **Fast mode toggle paths now behave correctly across main and project sessions** — native OpenClaw `fastMode` patching is wired through the real session controls instead of being easy to lose in stale UI state.
- **Dormant, idle, and yielded-run reconnect bugs** — the portal now recovers more cleanly after inactive or backgrounded OpenClaw runs instead of leaving stale session controls, stuck spinners, or dead-looking chats behind.
- **Session switcher / stale-state bugs after reloads** — the stale public-settings cache issue, hidden interrupted-stream bubbles after idle timeout, replayed duplicate chat output, and avatar 404 noise were all cleaned up.
- **Heartbeat/session-control edge cases** — false heartbeat-model update failures are avoided, and session-control refresh behavior is more stable.
- **Agent Tools request pressure is bounded** — tab request behavior is tighter, which reduces unnecessary gateway churn.
- **Approved signup passwords are preserved correctly** — the auth flow no longer drops the approved password state during signup.
- **Compatibility hotfix installs now bundle the actual patch helper** — portal releases now ship `scripts/patch-openclaw-long-run-relay-hotfix.sh`, so the admin action works on fresh installs instead of failing with a missing-script error.
- **Hotfix apply now restarts more safely on non-systemd OpenClaw setups** — when `openclaw gateway restart` only reports a disabled service, the portal now falls back to signaling the live gateway process so the patched runtime actually reloads.

## [3.23.8] — 2026-04-07

### Fixed
- **Project chat survives project renames** — assistant session identity is now stable per project instead of being tied to the mutable project name.
- **Large text files preview cleanly** — files over 10MB now open in a graceful read-only preview instead of hard failing, while edit limits remain enforced.
- **Project chat got real session controls** — session controls and slash-command autocomplete are now available directly in project chat.
- **Tasks tab no longer stampedes the gateway** — task loading was reduced to a single cached gateway fetch with in-flight dedupe and stale fallback behavior.

### Security
- **Project downloads stop leaking internal agent state** — clean and stripped exports now exclude `.assistant-*`, `.agent-*`, `.marcus-*`, and `.portal-project.json` files.

### Maintenance
- **Release packaging is tighter** — release and public-export scripts now exclude editor backup files, and release tarballs omit unneeded frontend and backend source trees.

## [3.23.7] — 2026-04-07

### Improved
- **Agent chats recover more gracefully** — reloads, reconnects, attachment handoff, and active stream recovery are all more reliable now.
- **Project AI chat is much more stable** — history recovery, first-open model selection, per-project session routing, and rapid switching between projects all behave more predictably.
- **Files and chat links are more dependable** — attachment access across refreshes and split-host installs is fixed, and file links resolve more cleanly.
- **Tasks and session controls feel cleaner** — long-running work, summaries, and related session controls load with less friction.
- **Missing frontend assets now fail safely** — bad asset requests return proper 404s instead of cascading into blank-page failures.
- **Project model defaults are saner** — providers excluded by auth-order overrides are pushed behind healthy options instead of surfacing first.

### Security
- **File access is tighter** — AI file helper routes are constrained to the correct user and project paths.
- **Share links are safer** — mutations are now scoped to the correct owner and project instead of raw link id alone.
- **Signed tool URLs are harder to abuse** — origin selection is stricter, and browser direct-gateway exposure is narrower.

## [3.23.6] — 2026-04-05

### 🐛 Bug Fixes

#### Mobile Auth / 2FA
- **Clear stale auth cookies before the 2FA handoff** — login responses that enter email/TOTP verification now explicitly expire leftover access and refresh cookies, so old mobile Safari sessions cannot poison the next step with a bad refresh attempt.
- **Clear broken cookies on refresh failure and best-effort logout** — invalid/expired refresh-token paths now actively clear auth cookies, and logout still clears the browser session even when the access token is already dead.
- **Stop bogus session refresh retries during unauthenticated / 2FA-pending flows** — the frontend now limits cookie-based session recovery to explicit restore-session probes and refuses to refresh while 2FA is pending, preventing the generic mobile `login failed` collapse.

## [3.23.5] — 2026-04-05

### 🐛 Bug Fixes

#### Claude (OpenClaw) Setup
- **Revert the Claude CLI bridge detour** — Claude/OpenClaw setup is back on the normal setup-token path instead of trying to repurpose the server Claude Code login as an OpenClaw auth bridge.
- **Show a hard Anthropic Extra Usage warning throughout setup** — the Claude provider card, provider picker, setup flow, and completion state now warn that OpenClaw-driven Claude requests require Anthropic Extra Usage and may require purchasing an Extra Usage bundle.
- **Add a direct link to Anthropic usage settings** — admins can jump straight to `https://claude.ai/settings/usage` from the warning UI instead of hunting through Anthropic settings.
- **Keep native Claude Code login separate** — native Claude Code remains available for the portal's native agent path, but it is no longer presented as the OpenClaw Claude provider setup.

#### Project Chat
- **Unstick project chat when streams end without a final `done`** — project chat now treats `stream_ended` as terminal so the UI stops spinning when the gateway never emits a last completion event.

## [3.23.4] — 2026-04-05

### 🐛 Bug Fixes

#### Claude Subscription / OpenClaw
- **Stop driving the broken `claude-cli/...` model path** — Claude Subscription setup now imports the server Claude Code OAuth session into OpenClaw as an Anthropic OAuth profile, keeps the live model on canonical `anthropic/...` IDs, and explicitly prefers that Claude CLI-backed profile in `auth.order` instead of sending the gateway into `Unknown model` / `Missing auth` failures.
- **Scrub leaked portal OpenClaw env before local CLI calls** — the AI setup flow and other OpenClaw CLI helpers now strip inherited `OPENCLAW_API_URL` / `OPENCLAW_GATEWAY_TOKEN`-style service env before spawning `openclaw`, so setup works from the real systemd service context instead of only from a clean root shell.
- **Auto-repair stale Claude model config** — legacy `claude-cli/sonnet-4.6` / `claude-cli/...` defaults, fallbacks, and model registry entries are now normalized back onto canonical Anthropic model IDs so stale config cannot keep poisoning new chats.
- **Make OpenClaw chat/session model switching actually stick** — project session bootstrap now patches existing sessions onto the intended selected/default model instead of silently reusing an older Claude/Codex session model.
- **Unstick turns that ended on `stream_ended` without final `done`** — both main chat and project chat now treat `stream_ended` as a terminal state, clearing the spinner/watchdog even when the gateway never emits a final completion event.

#### Model Picker Clarity
- **Add clearer model labels and collapse broken Claude duplicates** — OpenClaw model lists are normalized before they reach the UI, duplicate `claude-cli/...` catalog variants collapse onto Anthropic IDs, and chat model pickers now show clearer display names plus provider/runtime badges and the canonical model ID.

## [3.23.3] — 2026-04-04

### 🔧 Maintenance

#### Claude Subscription / OpenClaw Setup
- **Make Claude subscription setup prefer the server Claude CLI path** — The Claude Subscription setup flow now tells admins to log into Claude Code on the server first, then connect OpenClaw to the local `claude-cli/...` runtime instead of steering people toward API-key billing.
- **Add OpenClaw Claude CLI bridge for Anthropic** — The portal can now switch OpenClaw’s Anthropic path over to `claude-cli` by running the proper OpenClaw CLI auth flow on the server, then setting the chosen Claude model automatically.
- **Detect Claude CLI-backed Anthropic setups correctly** — AI Provider status now recognizes Anthropic/OpenClaw setups that are using `claude-cli/...` model references, labels them as `Claude CLI`, and surfaces missing native Claude login as an actual error state.
- **Clean up Claude CLI-backed Anthropic config on removal** — Removing the Claude Subscription provider now also removes `claude-cli/...` model defaults, fallbacks, and registry entries instead of leaving stale Anthropic CLI config behind.
- **Clarify the native Claude login handoff** — After Claude Code server login, the portal now explicitly points admins back to the Claude Subscription card to connect that login to OpenClaw.

## [3.23.2] — 2026-04-04

### 🐛 Bug Fixes

#### Claude Code / Native Agent Chat
- **Fix Claude Code OAuth sessions being overridden by bad Anthropic API keys** — Native Claude chats now prefer the server's local Claude OAuth login over inherited `ANTHROPIC_API_KEY` values, fixing the false `Invalid API key · Fix external API key` failure in Agent Chat after successful OAuth setup.
- **Harden native-provider session routing when switching providers** — Agent Chat no longer tries to reuse OpenClaw session IDs (`main`, `new-*`, or `agent:*`) as Claude/Codex/Gemini native session IDs. When you switch into a native provider, the portal now opens a fresh native session instead of failing history loads or sends against a foreign session key.

## [3.23.1] — 2026-04-02

### 🐛 Hotfixes

#### Agent Chat / Gateway Model Compatibility
- **Fix React crash in Agent Chat selector** — The portal no longer assumes agent `model` fields are always plain strings. This fixes `model.split is not a function` crashes on `/agent-chats` when OpenClaw returns structured model configs.
- **Normalize gateway model values at the backend boundary** — Structured OpenClaw model configs (for example `{ primary, fallbacks }`) are now converted into stable string model IDs before the portal API returns them.
- **Harden model rendering across the UI** — Agent Chat, Agent Tools, Usage, and Terminal status views now safely render model labels even if a non-string value slips through.

## [3.23.0] — 2026-04-02

### ✨ New Features

#### Background Tasks Visibility
- **Add Background Tasks page and Agent Tools tab** — Admins can now view running and recent subagents/cron-backed jobs in a dedicated Tasks view, with status, model, duration, parent session, summaries, and failures.
- **Add `/api/gateway/tasks` backend endpoint** — The portal now queries OpenClaw session state directly to surface detached task activity in the UI.

### 🐛 Bug Fixes

#### Agent Chat / Project Chat
- **Fix stale assistant text after reconnect** — Stream resume now only rehydrates accumulated text while the assistant is actively streaming. Tool/thinking reconnects no longer replay stale content from a prior phase.
- **Suppress phantom live-bubble content during reconnect/tool phases** — Project chat now clears resume-seeded content when real tool/thinking events arrive, preventing duplicated or misleading partial assistant output after tab sleep, disconnects, or tool transitions.

#### Tasks UI
- **Fix Tasks page double-`/api` request bug** — Corrected the Tasks page client path so it requests `/api/gateway/tasks` instead of the broken `/api/api/gateway/tasks`.

## [3.22.0] — 2026-04-01

### 🔧 Maintenance

#### OpenClaw Gateway Compatibility
- **Updated OpenClaw gateway compatibility to 2026.3.31** — Picks up improved exec approval handling, better provider error recovery (Anthropic transient errors now retry instead of failing), hardened config SecretRef round-trips, and background task flow improvements.
- **Installer version bump** — Installer now targets v3.22.0 and is compatible with the latest OpenClaw gateway release.

### 🛡️ Infrastructure
- **Remove unused analytics and installer subdomain routes** — Removed dead Caddy proxy routes (`analytics.bridgesllm.ai`, `install.bridgesllm.ai`) that had no DNS records configured and were generating continuous TLS certificate errors. Analytics dashboard remains accessible through the portal project behind authentication. Installer continues to work at `bridgesllm.ai/install.sh`.
- **Remove public analytics dashboard exposure** — Closed two unauthenticated routes (`/analytics` on the marketing site, `/api/dashboard` on the portal domain) that exposed the analytics dashboard publicly. Data is now only accessible through the authenticated portal.

## [3.21.0] — 2026-03-31

### ✨ New Features

#### Remote Desktop Clipboard & Mobile Keyboard
- **Clipboard paste into Remote Desktop** — New floating toolbar (bottom-right) with a clipboard panel. Paste text from your phone or desktop clipboard directly into the VNC session. Three modes:
  - **Read** — reads your device clipboard into the text area
  - **Paste** — sends text to the VNC clipboard and simulates Ctrl+V
  - **Type** — sends text character-by-character as keystrokes (for password fields, terminals, and apps that don't support clipboard paste)
- **Mobile keyboard support** — Keyboard button opens a hidden input that captures your phone's soft keyboard and forwards all keystrokes to the VNC session. Handles printable characters, Enter, Backspace, Tab, arrow keys, Delete, Home, and End.
- **Works on all devices** — Desktop browsers, iOS Safari, Android Chrome. No additional setup or plugins required.


## [3.20.1] — 2026-03-29

### 🐛 Bug Fixes

#### Native CLI Agent Login
- **Fix Claude Code native login on headless servers** — Replaced the broken localhost callback relay approach with Claude's correct manual PKCE OAuth flow. The portal now generates the auth URL, accepts Anthropic's pasted authorization code, exchanges it directly for tokens, and writes the Claude credentials file itself.
- **Fix Codex read-only sessions** — Codex agent chats now launch with `--full-auto`, giving the session `workspace-write` sandboxing with `on-request` approvals instead of the unusable default read-only sandbox.
- **Fix Gemini native auth detection** — Gemini availability now recognizes the real OAuth credentials path (`~/.gemini/oauth_creds.json`), so successful logins become selectable in agent chat.

#### Agent Chat / Project Chat
- **Refresh provider availability when opening the agent selector** — Newly authenticated native CLI providers no longer require a hard refresh before they appear as usable.
- **Align project sandbox chat defaults with gateway config** — Project assistant chats now report and inherit the configured gateway default model instead of stale hardcoded Anthropic fallbacks.

## [3.20.0] — 2026-03-29

### 🔐 Security
- **Remove rehype-raw from markdown renderer** — Agent responses with unfenced HTML were rendered directly into the portal DOM via rehype-raw, enabling XSS and breaking page layout. Raw HTML in chat is now safely escaped; code blocks with preview still work via sandboxed iframe.

### 🚨 Critical
- **Fix installer destroying portal on update** — The installer hardcoded `bridgesllm_portal` on port 5432 for the database URL and migration check. Installs using different database names or ports (common on established servers) would fail the check with "0 tables created" and abort — without restarting the portal service. Result: dead portal after clicking "Update". Fixed: preserve existing DATABASE_URL on updates, parse it for migration checks, and always restart the service if the update fails mid-way.

### 🐛 Bug Fixes

#### Provider Authentication
- **Fix Anthropic API key/token save** — API keys entered through portal settings were never persisted to auth-profiles.json. The portal now writes directly to all three config files (auth-profiles.json, openclaw.json, models.json) instead of relying on `openclaw onboard` which silently failed for non-OAuth providers.
- **Fix Claude setup-token extraction** — Token regex didn't match Claude CLI's actual output format. Now matches the `sk-ant-oat01-` prefix directly, immune to format changes.
- **Fix save button disabled when no model selected** — Adding a provider when a default model was already configured left the Save button grayed out because `selectedModel` started as null.
- **Fix model default override** — All three setup flows (API key, OAuth, setup-token) auto-selected a model on mount, silently overwriting the user's existing default. Now checks for an existing default first.
- **Fix OpenClaw stdout diagnostic pollution** — `registerProviderModels` JSON parsing failed because OpenClaw CLI prints diagnostic messages to stdout before JSON output. Now strips non-JSON prefixes before parsing.

#### Chat Streaming
- **Fix stale "Agent is thinking" indicator** — `stream-status` endpoint returned `active: true` from stale gateway `chatState` or soft-cleared StreamEventBus entries. Added: active flag check in `getStreamStatus()`, 90s stale event guard on the endpoint, and 60s gateway activity guard.
- **Fix missed messages after phone lock/tab background** — Visibility change handler now reloads chat history when tab becomes visible and no stream is active, picking up responses that completed while the device was backgrounded.

#### Code Preview
- **Fix HTML preview iframe white background** — Removed `bg-white` class from preview iframe so dark-themed app previews render correctly.
- **Auto-detect bare HTML responses** — Agent responses with raw `<!DOCTYPE html>` (no markdown code fences) now auto-wrap in fences for proper code block + preview rendering.
- **Wrap partial HTML in clean document** — Partial HTML snippets get a minimal document wrapper with CSS reset to prevent style leakage into the portal.

#### Installer
- **Fix migration table count check** — Replaced PrismaClient-based check (failed due to wrong working directory) with direct `psql` query. Prevents false "0 tables" errors during updates.
- **Fix hardcoded Anthropic model fallback** — Removed hardcoded `anthropic/claude-opus-4-6`; uses the gateway's configured default model instead.

## [3.19.0] — 2026-03-26

### ✨ AI Provider Setup Wizard
- **One-click OAuth sign-in** for ChatGPT/Codex, Google Gemini, and Claude — automated PTY-based auth flows handle the entire process.
- **Step-by-step wizard** with provider-specific prerequisites (subscription checks, Google Cloud Project ID, OAuth consent screen instructions).
- **Claude automated setup** — runs `claude setup-token` server-side, captures auth URL, opens browser, detects completion, and saves credentials automatically. Falls back to manual token paste if needed.
- **Google Gemini enhancements** — auto-confirms caution prompt, supports `GOOGLE_CLOUD_PROJECT` for paid accounts, auto-detects when local callback server completes auth.
- **Auto-completion polling** — frontend polls session status every 2–3s, detects when OAuth finishes without user intervention.
- **All provider models registered automatically** — after auth, discovers and adds all available models as fallbacks so they appear in every model switcher.

### 🎛 Wizard UX Improvements
- **Correct step ordering** — AI Coding Tools (install CLIs) appears before Connect an AI Provider (requires CLIs).
- **No auto-advance** — connecting a provider no longer skips to the next wizard step. Users can add multiple providers before clicking Continue.
- **Model selection optional** — "All models added automatically" messaging with optional default selection.
- **Provider cards with row layout** — clean card UI for ChatGPT, Gemini, Claude, and OpenClaw "More" options.

### 🔔 OAuth Expiration Tracking
- Provider cards now display token expiry dates with color-coded urgency badges.
- Visual states: green (healthy), amber (expiring within 14 days), red (expiring within 3 days or expired).
- Expired tokens show "Re-authenticate to restore access" with one-click re-auth flow.

### 🖥 Remote Desktop
- **Resize support fixed** — changed VNC `AcceptSetDesktopSize` from 0 to 1. Browser window resizing now works.

### 🐛 Bug Fixes
- Fixed installer hanging on "Waiting for package manager" — `awk` self-matching bug where the package-manager-busy check detected its own process.
- Fixed avatar 404 console errors — return null instead of path to non-existent default file.
- Fixed WebSocket disconnect on terminal session close.
- Installer uses `openclaw@latest` instead of pinned version.

### 🔐 Security
- Removed tracked SSH terminal keys from repository (now generated per-instance).
- Removed stale compiled assets directory from tracked files.
- Cleaned internal documentation of test infrastructure details.

### 📦 Installer
- Package manager busy check excludes awk/grep/ps/bash from self-matching.
- VNC launcher creates resize-enabled sessions by default.

## [3.18.2] — 2026-03-24

### 🔐 Security Hardening
- **Systematic shell-escape enforcement** across all backend `execSync` paths — every user-influenced parameter (commit messages, branch names, file paths, URLs, remote names) now uses proper single-quote shell escaping instead of double-quote interpolation.
- **Input validation tightened** — branch names, remote names, and commit hashes are validated against strict allowlist regexes before reaching any shell command.
- **Desktop env file permissions** reduced from world-readable to owner+group only.

### 🖥️ Remote Desktop
- **Centralized desktop environment** — all Remote Desktop launch paths (projects, agent browser, shared Chrome) now source a single canonical env file (`/home/bridgesrd/.bridges-rd-env`) written at VNC startup. Eliminates the class of bugs where environment variables were silently dropped during `su` login shell transitions.
- **Python/pygame audio fix** — projects using audio (pygame, SDL) no longer crash with "ALSA: Couldn't open audio device" because `DISPLAY`, `PULSE_SERVER`, and `SDL_AUDIODRIVER` are now guaranteed to reach the child process.
- **New `desktopEnv.ts` module** — `desktopExec()` and `desktopExecDetached()` helpers provide a single, tested code path for running commands as the desktop user with full environment inheritance.
- **Graceful fallback** — older installs that haven't re-run Remote Desktop setup get inline environment exports as a fallback, so nothing breaks during the update window.

### 🤖 OpenClaw Integration
- **Bundled `bridgesllm-portal` skill** — a comprehensive AgentSkill for operating the portal ships in every install. Covers Remote Desktop, shared browser (CDP), email, file management, projects, agent chat, automations, terminal, apps deployment, dashboard, and system administration. Automatically installed into the OpenClaw workspace during setup wizard and refreshed on Remote Desktop auto-setup.

### 🔧 Installer
- **Package-manager wait disabled** — `apt-get` handles lock contention natively; the custom wait loop caused false-positive blocking on fresh VPS instances where idle daemons (`unattended-upgrade-shutdown --wait-for-signal`, `packagekitd`) were detected as blockers.
- **Real progress bars** — installer now shows actual download sizes, real package counts, and pulse animations for indeterminate steps instead of estimated placeholders.
- **OpenClaw version display fix** — summary no longer stutters `OpenClaw OpenClaw 2026.x.x`.

## [3.18.0] — 2026-03-23

This is a major release covering a full week of intensive development. Dozens of new features, hundreds of fixes, and significant architectural improvements across every layer of the portal.

### 🖥️ Shared Browser & Remote Desktop
- **Shared Browser** — full shared Chrome browser embedded in the Remote Desktop page, controllable by both users and agents via CDP. Agents can navigate, screenshot, evaluate JS, and interact with pages through the portal skill.
- **Smart adaptive resolution** — VNC viewport now auto-adjusts to match your browser window size instead of using a fixed resolution.
- **Viewport stability overhaul** — eliminated resize oscillation, phantom viewport pollution, iframe reload loops, and Chrome state file contamination that caused resolution drift.
- **Chrome cold-start reliability** — `--no-sandbox` flag, network warm-up sequence, and fresh temp profiles prevent blank/broken browser sessions.
- **Full XFCE desktop config** — ships a complete desktop theme (Greybird + elementary icons), panel layout, keyboard shortcuts, and session defaults so Remote Desktop looks polished out of the box.
- **Remote Desktop audio** — PulseAudio → WebSocket → Web Audio API pipeline for streaming desktop audio to the browser. Includes mobile Safari support and reconnect safety.
- **Remote Desktop in installer** — auto-installs and configures Xtigervnc, noVNC, XFCE, and audio on fresh installs and updates.
- **Agent browser viewer** — live CDP screenshot streaming panel merged into the Remote Desktop page, so you can watch what the agent sees in real time.

### 💬 Agent Chat
- **FYI mode** — message queue with remove and drain for agent yield states, so the agent can park non-urgent messages for you to review.
- **Drag/drop + paste attachments** — drop files or paste images directly into the chat composer.
- **Reconnect indicator + button** — visible connection state with one-click reconnect when the WebSocket drops.
- **Unified Session Controls panel** — thinking level slider, quick-reply model picker, and compaction model selector in one place.
- **Adaptive thinking level** — Opus/Claude 4.6 defaults to the right thinking tier automatically.
- **Thinking bubble visibility** — thinking chip shows during thinking phase even without reasoning content; compaction events no longer pollute the thinking bubble.
- **Aborted run preservation** — partial streamed text is now preserved when a run is aborted, instead of blanking the response.
- **Agent status rail** — unified connected/compacting/streaming state indicator with explicit color mapping.
- **Streaming reliability** — reconnect after restart, survive sub-agent yield/resume across run boundaries, prevent `chat.final` from clobbering post-tool text, fix cascade text length tracking, fix duplicate StreamEventBus subscribers.
- **Session isolation** — agent switching properly isolates sessions; compaction events don't leak across providers.
- **Project chat alignment** — project chat panels now use the same streaming, reconnection, and graduation logic as main chat.

### 🛒 Skill Marketplace
- **Working Extensions/Skills panel** — browse, search, explore, inspect, install, and uninstall skills from clawhub.com directly in the portal UI.
- **Marketplace metadata enrichment** — cards show real descriptions, authors, versions, and download counts instead of placeholder text.
- **Backend fully rewritten** — replaced non-existent `openclaw skills search/install` commands with the real `clawhub` CLI.

### 🔐 Approval Workflows
- **Native approval modal** — exec approval decisions now use the real OpenClaw runtime values (`allow-once`, `allow-always`, `deny`).
- **Modal waits for backend** — approval modal stays open until the backend confirms success, preventing premature close.
- **Visible-browser policy** — enforces that the agent's browser is visible during main portal sessions; hidden browser requests are denied.

### 📧 Email
- **Owner mail provisioning** — automatic mailbox creation during setup with password drift prevention.
- **Mail signature and auto-forward** — database migration and UI support for per-user email signatures and forwarding rules.
- **Share link email** — branded email with optional password sent from user's own mailbox via the share panel.

### 🔧 Installer & Fresh-VPS UX
- **Fresh-VPS transparency** — installer now detects `apt`/`dpkg`/`cloud-init`/`unattended-upgrades` blockers, shows what it's waiting on with elapsed time, and continues automatically. No more "the installer looks frozen."
- **Safe package-manager recovery** — if package state is interrupted (not actively busy), installer attempts `dpkg --configure -a` + `apt-get -f install` before failing.
- **Per-package install verification** — replaced unreliable count-based checks with per-package `dpkg -s` verification.
- **Auto-dependency detection** — unified progress notifications for missing system dependencies.
- **Three-tier update strategy** — choose always/minor-only/never for component updates.
- **Dependency version tracking** — dashboard shows versions of all installed components (PostgreSQL, Caddy, Docker, Ollama, OpenClaw, Node).

### 🔗 OpenClaw Compatibility
- **Persistent gateway hardening** — stripped unsupported connect params that caused silent WebSocket rejections on OpenClaw 2026.3.x.
- **Gateway RPC routing** — all RPC now routes through the persistent WS to prevent clientId collision that broke chat streaming.
- **Health endpoint accuracy** — dashboard now requires authenticated persistent WebSocket before reporting "Connected" instead of just checking HTTP reachability.
- **Reconnect button** — when gateway is reachable but WS auth fails, a reconnect button appears instead of a dead-end error.
- **Token resolution centralized** — portal reads gateway token from `openclaw.json` at runtime, eliminating token mismatch after `openclaw onboard`.

### 🎨 UI/UX
- **Lazy loading + React.memo + skeleton loading** — significantly faster page loads and smoother navigation.
- **Terminal tab persistence** — terminal tabs survive navigation between pages.
- **Slash command autocomplete** — categorized palette with provider-aware commands, scroll-into-view, and blur dismiss.
- **Dynamic OG tags** — portal generates Open Graph meta tags from branding settings.
- **Search engine visibility toggle** — choose whether search engines can index your portal.
- **Project rename** — double-click or pencil icon in sidebar to rename projects inline.
- **Feature carousel** — marketing site shows live video demos of every feature.
- **YouTube embed support** — CSP now allows YouTube frames in portal-hosted pages.

### 🔒 Security
- **Cookie-first auth** — removed localStorage token exposure paths.
- **Domain-aware auth cookies** — cookies respect the actual deployment domain.
- **Shell injection prevention** — domain regex validation before shell execution in self-update.
- **Self-update process survival** — uses `systemd-run --scope` to survive service restart.
- **Share access hardening** — signed share cookies, usage limits, and tighter public share gating.
- **Step 10 security audit** — comprehensive audit with npm audit fixes.

### 📊 Infrastructure
- **README architecture** now uses a Mermaid diagram instead of misaligned ASCII boxes.
- **README requirements** updated to match real minimums (3.5GB RAM, 35GB disk).
- **Telemetry V2** — install lifecycle events, download tracking, heartbeat with dependency versions.
- **Release process** — validated on an isolated host before publication.
- **GitHub export** rewritten to eliminate `.work/` duplication and add comprehensive exclusions for internal docs.

### Bug Fixes (selected)
- Fixed installed skills endpoint crash when OpenClaw emits JSON on stderr
- Fixed pre-existing TypeScript build errors in setup-legacy and gateway RPC
- Fixed Monaco editor black box (CSP blocking jsdelivr CDN stylesheet)
- Fixed session stability / unexplained logouts
- Fixed rsync `--delete` nuking projects on update
- Fixed corrupted `MAIL_DOMAIN` from missing trailing newline
- Fixed SVG wallpaper rendering (missing librsvg2-common)
- Fixed `DATABASE_URL` hardcoded port in update path
- Fixed HTTP/IP installs — `crypto.randomUUID` replaced with safe client ID fallback
- Fixed thinking slider sending invalid `sessions.patch` field instead of `/think`
- Fixed compaction model control to use real OpenClaw options

## [3.14.0] — 2026-03-17

### Fixed
- **Agent Chat Connection Failure (CRITICAL)** — `PersistentGatewayWs` sent unsupported top-level properties (`lastSeq`, `stateVersion`) in the WebSocket connect request. OpenClaw 2026.3.x strict validation rejected these, causing **every** connection attempt to fail silently. Dashboard showed "Connected" (green) while Agent Chat was completely broken. Root cause: the gateway's connect param schema only accepts `auth`, `client`, `device`, `role`, `scopes`, `caps`, `minProtocol`, `maxProtocol`. All other properties are now stripped.
- **Dashboard False Positive** — health endpoint and green dot used an HTTP probe to the gateway's web UI root, which always returns 200 if the process is running. Now requires the authenticated persistent WebSocket to be connected before reporting "Connected."
- **Missing RPC Scope** — `openclawGatewayRpc.ts` only requested `operator.admin` scope. Added `operator.read` to fix `config.get` "missing scope" errors.

### Added
- **Reconnect Button** — when the dashboard detects the gateway is reachable but the real-time WebSocket is dead, it shows a "Reconnect" button instead of a dead-end error message. Triggers `POST /api/gateway/reconnect` which forces a PersistentGatewayWs reconnect with up to 8s wait.

### Changed
- Dashboard health endpoint now returns `chatReady` (authenticated WS) in addition to `connected` (HTTP probe)
- Green avatar dot checks `/api/gateway/health` with `wsConnected` instead of the basic `/api/gateway/status` probe
- Tailnet-specific hostnames removed from committed source (use `VITE_ALLOWED_HOSTS` env var instead)
- GitHub export script rewritten — eliminates `.work/` duplication bug, adds comprehensive exclusions for internal docs, job data, test files, and build artifacts

## [3.13.0] — 2026-03-16

### Added
- **Project Rename** — double-click or pencil icon in sidebar to rename projects inline
- **Dynamic OG Tags** — portal generates Open Graph meta tags from branding settings
- **Search Engine Visibility Toggle** — choose whether search engines index your portal
- **Dependency Version Tracking** — dashboard shows versions of all installed components
- **Feature Carousel** — marketing site now shows live video demos of every feature

### Fixed
- **Gateway Token Resolution** — centralized token resolver reads from `openclaw.json` at runtime, eliminating token mismatch issues after `openclaw onboard`
- **Chat Streaming Jank** — unified render path prevents React unmount/remount flicker during streaming
- **Unclosed Code Fences** — auto-closes unclosed markdown code blocks during streaming for proper rendering
- **HTML Auto-Preview** — HTML and SVG code blocks default to preview view with deferred iframe loading
- **Accent-Colored Streaming Border** — streaming chat bubbles use your theme accent color with smooth fade
- **Monaco Editor Black Box** — added CDN stylesheet to CSP `style-src` for proper editor rendering
- **Installer Token Sync** — reads live gateway token after OpenClaw starts, patches `.env.production` if mismatched
- **Update rsync Safety** — excludes `.env.production` and `.env` from `--delete` during updates
- **Self-Update Process Survival** — uses `systemd-run --scope` to survive service restart
- **Shell Injection Prevention** — domain regex validation before shell execution in self-update

### Changed
- Dashboard health check triggers gateway reconnect when token exists but WS is disconnected
- Installer generates token early to prevent empty token in fresh `openclaw.json`

## [3.12.0] — 2026-03-16

### Fixed
- Chat streaming transitions and rendering reliability
- Accent-colored dashed border on streaming bubbles

## [3.11.0] — 2026-03-16

### Added
- Dependency version tracking in heartbeat telemetry
- Three-tier update strategy in installer (always/minor-only/never)

### Fixed
- Monaco editor CSP stylesheet blocking (CDN added to `style-src`)

## [3.10.0] — 2026-03-16

### Added
- Telemetry V2 with install lifecycle events and download tracking

### Fixed
- `DATABASE_URL` hardcoded port in update path

## [3.9.0] — 2026-03-16

### Added
- Dynamic OG tags for portal (injected from SystemSetting)
- Search engine visibility toggle (`noindex` meta tag)

### Fixed
- Shell injection in self-update domain parameter (CRITICAL)
- JWT refresh secret auto-generation for old installs

## [3.8.0] — 2026-03-16

### Fixed
- Self-update process killed by systemd stop — now uses `systemd-run --scope`
- Avatar shows stale cached image after crop/save

## [3.7.0] — 2026-03-16

### Fixed
- OpenClaw token mismatch — portal reads token from `openclaw.json` at runtime
- rsync `--exclude='assets'` blocking frontend JS deployment (CRITICAL)
- Corrupted `MAIL_DOMAIN` from missing trailing newline in env file
- `userMailService.ts` module-scope caching of stale env values
- GIF crop/zoom disabled in avatar editor
- Project agent default model hardcoded to unavailable `opus-4-6`

---

*For the full commit history, see [GitHub Releases](https://github.com/BridgesLLM-ai/portal/releases).*
