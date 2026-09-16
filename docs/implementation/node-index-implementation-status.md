# Bounded Node/index private implementation receipt

Pinned assembly base: `81f83eb182771d00740d1678085be4a00fa6fa78`.
Continuation base: `b9c7f1f5618f642ddbce02dfbf16671c97597efe`.
Focused guard follow-up base: `548e1faa5c021c92cb3a10e92e4364591a01bcb8`.

**Local finite-contract implementation complete; private review candidate, not
host-normalized or production-qualified.** No live/TEST change, protected host
input inspection, package/build/signing/remote action or native startup occurred.

## Completed shipping changes

- Finite direct Node/index/data-environment binding and persistent read-only
  start condition. Standard CLI selection/defaults and predecessor list stay
  unchanged; no wrapper hash, arbitrary command or tuning escape exists.
- Isolated `/usr/bin/python3 -B -I -S`: finite Debian x86-64 Python 3.11/3.12
  layout, complete reachable stdlib namespace/content/bytecode commitment,
  bounded known helper extension imports and recursive ELF dependencies. Site
  startup/build-config branches are excluded by isolation, not broadly admitted.
- Recursive interpreter/DT_NEEDED closure now covers Bash, sh, rm, cat, sed,
  cut, Python and observation utilities. Parse the glibc loader cache as data;
  never execute ldconfig/ldd to discover dependencies. Reject preload, audit,
  filter, nonfinite runpath, ambiguous cache and hwcap/search alternatives.
  Only the two fixed observation tools may use the exact systemd library path;
  shadow dependencies there refuse. No caller-supplied library allowance.
- Fixed service PATH, C locale and disabled external OpenSSL configuration;
  guard has no site startup or bytecode writes. Crypto-provider redirection,
  shell startup/function controls and native execution controls refuse.
- Expanded effective-property refusal covers private namespaces, root/image,
  bind/path masks, credentials, generated writable directories, security and
  process remapping. Standard unit search tiers, alternate fragments and
  drop-in directory identities/membership are rechecked. Execution prefixes
  refuse. Lock removal is restricted to the one `state/gateway.lock` role.
- Generic password/project/endpoint data key classes cover the sanitized
  assignment/config/dotenv categories without publishing host-specific keys.
- Actual process argv, executable inode/device/path, generation, namespace,
  cgroup and fixed environment are checked immediately when recording a start
  result, before pending authority is cleared. Intended target generation is
  rechecked there and at existing cutover/retirement boundaries.
- Existing one-owner transaction, B1 same-filesystem writes, receipt decision,
  recovery and retirement remain in use. All accepted Chat payload, source-lock
  and historical predecessor bytes are unchanged. Installer helper seal updated.

## Verification receipts

| Check | Final result |
|---|---|
| `python3 -B -I -S scripts/validation/openclaw-node-index-execution-test.py` | **19 passed** |
| `python3 -B -I -S scripts/validation/openclaw-node-index-lifecycle-test.py` | **3 passed** |
| Selected `openclaw-retained-chat-execution-test.py` cases listed below | **3 passed** |
| Python compile-only syntax, `bash -n installer/install.sh`, `git diff --check`, exact helper seal | **Passed** |
| Committed production source closure | **Passed**; exact commit recorded in final task report |

Selected legacy cases: `test_exact_real_launcher_node_service_positive_both_versions`,
`test_npm_A_cli_and_service_B_real_package_selector_refuses`, and
`test_cli_link_drift_before_queued_start_refuses_permit` in `ExecutionBinding`.
The prior continuation also passed the entry-import-drift and wrapper/extra-argv
regressions; this follow-up reran only the affected source-selection cases.
No old broad native/performance/build matrix was rerun.

**Independent dependency evidence:** real read-only qualification bound 1,233
stdlib files and 46 ELF identities on the test interpreter layout. A separate
isolated system Python import/memory-mapping oracle confirmed its loaded shared
objects belong to the captured graph. Synthetic stdlib source/bytecode drift
changes the commitment; an escaping link refuses. This is not just an artifact
compared with itself. Systemd's actual `load_env_file` independently verifies
synthetic quote/dollar/backtick/backslash value preservation.

**Red → green:** the first negative lifecycle test exposed acceptance of a wrong
post-start argv until cutover. Moving process attestation into start-result
recording made this a refusal with owner/fence/pending evidence retained. The
initial lifecycle fixture also incorrectly exported installer bookkeeping as
native environment; its isolated harness now mirrors shipping shell-local scope.
No shipping environment bypass was added to make that fixture pass.

Expected-red checks now pass: extra/force/loader argv, source/marker drift,
unknown/missing/remapping properties, alternate unit/command prefixes, arbitrary
lock target, wrong hook PATH/locale, data execution syntax and control variables;
queued credential/drop-in/lifecycle/ELF/stdlib drift; mixed unowned targets; wrong
activated argv. Guard refusal never consumes the permit or discards owner/fence.

## Focused guard follow-up: two reproduced defects closed

- **Guard PATH red → green.** The previous binding incorrectly required ambient
  `which(openclaw)` inside the service guard. The fixed service PATH is only
  `/usr/bin:/bin`; the explicitly bound npm CLI alias can live outside it.
  `test_fixed_guard_path_uses_explicit_cli_and_rejects_retargeting` first failed
  with `Node/index npm/CLI/profile roots differ`, then passed after removing
  ambient CLI lookup from this direct-Node variant alone. Explicit profile/CLI/
  package agreement, strict alias-chain identity and launcher pin remain
  required. Retargeting the alias to another same-version package refuses.
  Standard CLI ambient discovery and its drift contract are unchanged.
- **Managed env red → green.** The pinned native `dotenv-global` source reads
  `HOME/.config/openclaw/gateway.env`; the previous check only covered the
  similarly named file under state. The new admission test initially accepted
  that extra source (expected refusal failed). It now refuses both generic
  application-only additions and loader-control data. Adding the actual managed
  env path after permit issuance also refuses in the real guard handler without
  discarding owner/fence/permit. Existing conservative extra-source absences stay.
- Removed the blanket CLI lookup double from finite binding fixtures. The full
  lifecycle guard now runs with the exact service PATH rather than the fixture's
  CLI-discovery PATH. All three lifecycle tests pass with this correction.
- **25 focused tests green:** 19 finite-contract, 3 lifecycle, 3 affected legacy
  source-selection cases. Helper identity, compile-only syntax, `bash -n`, and
  whitespace checks pass. Committed source closure is checked on the reported
  successor commit. No broad matrix was reopened.
- `stage_verified_release` is byte-identical to the pinned `81f83eb1` base in
  this private branch. Main's independent extraction-mode fix was neither read
  from a live host nor modified here. Accepted payloads, B1 writer, default CLI
  body and predecessor pins were independently compared with that base.

## Exact lifecycle scope and limitations

The new lifecycle suite invokes the real shipping shell functions and the real
sealed-helper descriptor/hash loader. Fixture instrumentation is installed
**after** that loader verifies the exact helper bytes. Owner publication,
protected ledger loads, every target write, Portal receipt/atomic cutover,
start-result validation, rollback and terminal retirement run unchanged.

The real actual-condition handler is independently spawned after the permit is
issued and before the synthetic service starts. After retirement the real
no-owner handler accepts coherent installed targets. Partial-write evidence
records one accepted and two original target hashes before recovery restores all
three originals and retires the owner. Public index source bytes are real;
protected repair contents are explicitly generic fixture doubles. Config/master,
old wrapper and journal sentinels remain byte-and-identity unchanged. A real
unowned listener with same-name argv remains alive across the isolated route.
This does **not** claim a real gateway can bind its occupied port: start/readiness
are doubles and no force-takeover or native invocation occurs.

Systemd observations/actions, recursive-cgroup inactivity and process observation
values are scoped doubles. The lifecycle fixture substitutes dependency inventory
results already tested independently; it does not patch binding comparison,
activation predicates, owner authority, target verification or retirement.
No real Node process, configured provider, login fallback or service was run.
The inventory bounds the selected helper/prehooks and their dynamic-link imports;
it is not whole-OS/PAM/NSS/plugin attestation or malicious-root containment.

## Concrete Main-only gates

1. **Complete the host prerequisite, not the updater.** Privately classify the
   recording drop-in's key/value semantics (absent from the sanitized report),
   confirm the exact lock path and normalized effective properties, and preserve
   required provider/channel inputs formerly dependent on login fallback.
   The observed generic credential/project/endpoint classes and hook structure
   are covered; recording compatibility is **not proven**. Unknown recording
   controls still refuse; do not omit the setting or silently broaden admission.
2. Authorize and journal separate normalization using the companion draft;
   include fixed PATH/locale/OpenSSL policy in operational-equivalence review.
   Install the persistent exact signed helper/profile and retire prerequisite
   ownership before ordinary Chat delivery. No auto-restart of the old wrapper.
3. Collect real direct Node/index activation, exact process/cgroup/argv, fallback
   unexecuted, and bounded configured-provider readiness receipts. Only these
   can close live operational equivalence; fixture readiness cannot.
4. Assemble and bind this exact successor into the trusted signed artifact and
   complete Main's separate TEST/production gates. Existing standard receipts
   are not custom-host proof. No signing or deployment was done here.
