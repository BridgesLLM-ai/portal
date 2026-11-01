# Native OpenClaw outputs — DERIVED FROM DIST

Every file here is **derived from the code that builds the output**, read statically (never run) in the
OpenClaw 2026.10.9 package dist and in the installed 2026.9.9 package dist; the first native hop on an
existing host is driven by the installed updater, so both shapes matter. They are not recorded from a
live run yet; replace them with recorded goldens from a live rehearsal.

Only the fields toolctl reads are claimed. Inner objects toolctl ignores (`update`, `availability`,
`service`, `port`, `config`, the dry run's own `run`), timestamps, ids, paths and reason strings are
placeholders of the right type.

| File | Built by (2026.10.9 dist) | Same in 2026.9.9 dist |
|---|---|---|
| `update-status.idle.json`, `update-status.active.json` | `status-MQwmoqS8.mjs:175-202` (`...runStatus` spread); `update-run-status-QPcYZgvx.mjs:20-37` (`activeRun`, `lastRun`, `staleRun`, `abandonedRun`, `runStatusError`); record fields `update-run-ledger-CgeXEnlV.mjs:159-183`; `lastRun` = newest non-dry-run row `update-run-read.kernel-BjTlx3Le.mjs:84-95` | `status-B2SgZaJV.mjs` (same keys, no `configWarnings`); `update-run-status-LRu5Q5Pr.mjs` (identical apart from import hashes); `update-run-read.kernel-AYdFMAIe.mjs:90` |
| `update-status.interrupted-before-activation.json` | `update-run-ledger-CgeXEnlV.mjs:356-363` (`finishInterruptedRunInTransaction`: `finishUpdateRunRecord(record, {status, reason: "interrupted"})`, status `failed` for an update); terminal record phase `finished` (`update-run-record-Chv9kKnY.mjs:62-79`); docs `docs/cli/update/how-updates-run.md:280-283` ("records a failed, `interrupted` history entry"). Step statuses of the interrupted stage are UNVERIFIED (toolctl reads only step names) | `update-run-ledger-RLRMui7p.mjs` (same `reason: "interrupted"` writer) |
| `update-result.*.json` | `progress-D_wefNIe.mjs:201-206` (`{...result, run: toPublicUpdateRun(run), reportPath}`); terminal record `update-run-record-Chv9kKnY.mjs:62-79` (phase always `finished`); status mapping `update-command-terminal-CFODDKeC.mjs:401-409`; vocabulary `update-run-vocabulary-BuT3Q1bJ.mjs:2-31` | `progress-Cv6zpZi2.mjs:183`; `update-run-record-BCEjJm1u.mjs:64`; `update-run-vocabulary-BYZF4sMi.mjs` (identical) |
| `update-result.admission-refused.json` | `update-command-result-DBZRPlYy.mjs:189-218` (failure result, no run), `:263-294` (admission refusal printed without a run) | `update-command-result-*` (not separately diffed) |
| `update-dry-run.*.json` | `update-command-schema-Cd6xJMym.mjs:338-361` (preview), `:308-316` and `:409-417` ("Would refuse update:" notes with `failures[]`) | `update-command-schema-q4VkaA5r.mjs:262, 336-342` |
| `gateway-status.ready.json` | `status-CN0FcM_W.mjs:64-70` (JSON), `:385` (`--require-rpc` exits 1 unless `rpc.ok`); `status.gather-DblVZBna.mjs:489, 585-600` (`gateway.version`, `rpc`) | `status-C4k6JJKG.mjs:383`; `status.gather-BSLM1zHw.mjs:438, 533` |
| `plugins-inspect.loaded.json` | `plugins-inspect-command-Dnj4ctSH.mjs:228-233` (`{...inspect, install}`), `:178-201` (missing plugin exits 1); record `loader-shared-DLOPnyYC.mjs:32-51, 88-99` (`status` loaded/disabled/error, `error` on disabled too) | `loader-shared-DjbWoJ5x.mjs:32-51, 89-99, 156` |
| `plugins-reload.ok.json` | `plugins-reload-command-C-NX5Mv9.mjs:16-20` (gateway `plugins.reload` result verbatim; `restartRequired`) | `plugins-reload-command-Dn4QAsGD.mjs:16-20` |
| `update-repair.ok.json` | `update-repair-command-u-uSovpV.mjs:172-180` (`reportRepairResult`); other outcomes delegate to `update-command-finalize-ZknUBuX4.mjs:305, 540, 752` (`status` ok/warning/error/failed; exit 1 on error) | `update-repair-command-Cs2RMip2.mjs:143-150` |
