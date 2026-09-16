#!/usr/bin/env python3
"""Exact 2026.9.3 Chat generation; called only by the fenced installer lifecycle.

No service/config/database operations. The caller owns migration validation,
identity-authorized stop, and the outer decision. This helper independently binds
that generation, refuses live cgroups before byte writes, and never edits the
sealed migration ledger or its three-target tested-pair decision.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import tempfile

SCHEMA = 'bridgesllm-openclaw-native-chat-v1'
OUTER_SCHEMA = 'bridgesllm-openclaw-2026.9.1-migration-transaction-v2'
CORE_COMMIT = '1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7'
TARGETS = {
    'session-history-tail-DUGCG5bk.mjs': (
        '3e400a2e140d3ba4cb8e74ef91aef7807280e13428a51b8c0581a2fb9445fa8c',
        'dbb27a3a6f9349a201df3db9d78983b559dbaba63d33045e3a228bb97ee6bf15'),
    'session-transcript-readers-DZrB96ki.mjs': (
        'f25537601756508d41bb612daf362b6750778f8319e2034a99cdd5846c40862b',
        '80254a0fc5027f4e073767b6c910279652a4eaf5aff5eba64e9d121700c844ba'),
}
HELPER = 'openclaw-native-chat-transaction.py'
SELF_BYTES = Path(__file__).read_bytes()
JOURNAL = 'transaction.json'
PHASES = {'prepared', 'applied', 'commit-pending', 'committed', 'rollback-pending', 'rolled-back'}


def fail(message):
    raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def directory(path, mode=None):
    if not path.is_absolute() or path != Path(os.path.normpath(path)):
        fail('noncanonical directory')
    for entry in [*reversed(path.parents), path]:
        st = entry.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_gid != 0:
            fail('unsafe directory ancestry')
        # Root-owned sticky /tmp is allowed for isolated fixtures only; child
        # directories and every other ancestor must be non-writable by others.
        if stat.S_IMODE(st.st_mode) & 0o022 and not (entry == Path('/tmp') and st.st_mode & stat.S_ISVTX):
            fail('writable directory ancestry')
    st = path.lstat()
    if mode is not None and stat.S_IMODE(st.st_mode) != mode:
        fail('unexpected directory mode')
    return {'device': st.st_dev, 'inode': st.st_ino}


def read(path, mode=0o600):
    directory(path.parent)
    st = path.lstat()
    if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != 0
            or st.st_gid != 0 or stat.S_IMODE(st.st_mode) != mode or st.st_size > 2_000_000):
        fail('unsafe file: ' + str(path))
    return path.read_bytes()


def document(path):
    raw = read(path)
    value = json.loads(raw)
    if raw != canonical(value):
        fail('noncanonical journal')
    return value


def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, mode=0o600, staging=None):
    fd, name = tempfile.mkstemp(prefix='.chat-write-', dir=staging or path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fchmod(out.fileno(), mode)
            os.fchown(out.fileno(), 0, 0)
            os.fsync(out.fileno())
        os.replace(name, path)
        sync(path.parent)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


def fault(name, root):
    # No production switch: injection is confined to a root-owned fixture
    # under /tmp and must name this exact transaction root.
    if (str(root).startswith('/tmp/bridgesllm-native-chat-test-')
            and os.environ.get('PORTAL_NATIVE_CHAT_TEST_ROOT') == str(root)):
        if os.environ.get('PORTAL_NATIVE_CHAT_KILL_AT') == name:
            os.kill(os.getpid(), signal.SIGKILL)
        if os.environ.get('PORTAL_NATIVE_CHAT_FAIL_AT') == name:
            fail('injected failure: ' + name)


def inactive(raw):
    value = json.loads(raw or '{}')
    if (value.get('schema') != 'bridgesllm-openclaw-gateway-unit-identity-v1'
            or value.get('unit') != 'openclaw-gateway.service'
            or value.get('active') is not False or value.get('mainPid') != 0
            or value.get('activeState') not in {'inactive', 'failed'}
            or value.get('subState') not in {'dead', 'failed'}
            or value.get('needDaemonReload') is not False):
        fail('no inactive gateway proof')
    group = value.get('controlGroup')
    if not isinstance(group, str) or (group and (not group.startswith('/') or '..' in Path(group).parts)):
        fail('invalid cgroup identity')
    groups = {Path('/sys/fs/cgroup/system.slice/openclaw-gateway.service')}
    if group:
        groups.add(Path('/sys/fs/cgroup') / group.lstrip('/'))
    for cgroup in groups:
        if cgroup.exists():
            for members in [cgroup / 'cgroup.procs', *cgroup.rglob('cgroup.procs')]:
                if members.read_text().strip():
                    fail('gateway cgroup still populated')


def outer(ledger):
    directory(ledger.parent, 0o700)
    value = document(ledger)
    if (value.get('schema') != OUTER_SCHEMA
            or not re.fullmatch('[a-f0-9]{32}', str(value.get('generation', '')))
            or value.get('paths', {}).get('root') != str(ledger.parent)):
        fail('invalid outer generation')
    return value


def package(root):
    identity = directory(root)
    directory(root / 'dist')
    raw = read(root / 'package.json', 0o644)
    value = json.loads(raw)
    if value.get('name') != 'openclaw' or value.get('version') != '2026.9.3':
        fail('Chat generation requires openclaw@2026.9.3')
    # gitHead is not included in every npm package.json; the installer already
    # requires the signed core source pin and the native stock verifier.
    if value.get('gitHead', CORE_COMMIT) != CORE_COMMIT:
        fail('core source commit mismatch')
    return {**identity, 'path': str(root), 'metadataSha256': digest(raw)}


def target_bytes(root):
    values = {}
    for name, pins in TARGETS.items():
        content = read(root / 'dist' / name, 0o644)
        if digest(content) not in pins:
            fail('unknown native Chat bytes: ' + name)
        values[name] = content
    return values


def load(root, ledger, storage=None):
    storage = storage or root
    directory(storage, 0o700)
    value = document(storage / JOURNAL)
    if set(value) != {'schema', 'root', 'identity', 'generation', 'outer', 'package', 'before',
                      'helperSha256', 'phase', 'binding', 'decisionSha256'}:
        fail('unexpected Chat journal shape')
    if (value['schema'] != SCHEMA or value['root'] != str(root)
            or value['identity'] != directory(storage, 0o700)
            or value['phase'] not in PHASES
            or not re.fullmatch('[a-f0-9]{32}', str(value['generation']))):
        fail('Chat journal identity mismatch')
    if digest(read(storage / HELPER)) != value['helperSha256']:
        fail('sealed Chat helper drift')
    owner = outer(ledger)
    if value['outer'] != {'ledger': str(ledger), 'identity': directory(ledger.parent, 0o700),
                          'generation': owner['generation']}:
        fail('stale outer generation')
    if value['package'] != package(Path(value['package']['path'])):
        fail('installed package generation changed')
    if set(value['before']) != set(TARGETS):
        fail('unexpected Chat target set')
    before = {}
    for name, pins in TARGETS.items():
        entry = value['before'][name]
        if set(entry) != {'sha256', 'base64'}:
            fail('unexpected backup binding')
        before[name] = base64.b64decode(entry['base64'], validate=True)
        if digest(before[name]) != entry['sha256'] or entry['sha256'] not in pins:
            fail('invalid exact rollback bytes')
    if len({TARGETS[n].index(digest(b)) for n, b in before.items()}) != 1:
        fail('mixed baseline is not restorable')
    if value['phase'] in {'commit-pending', 'committed'} and not isinstance(value['binding'], dict):
        fail('missing commit binding')
    return value, before, owner


def save(root, value, phase):
    value['phase'] = phase
    # An interrupted write is NOT a published journal. Keep its scratch outside
    # the active/terminal tree so even a partial write cannot wedge retirement.
    # Like unarmed preparation trees, abandoned private scratch is preserved:
    # no glob cleanup, adoption, replay, or authority comes from these siblings.
    # Both directories are on the same filesystem; atomic() fsyncs the published
    # journal's directory after rename. Only this invocation removes its empty
    # staging directory; a later invocation never opens an abandoned one.
    stage = Path(tempfile.mkdtemp(prefix='.native-chat-journal-', dir=root.parent))
    try:
        atomic(root / JOURNAL, canonical(value), staging=stage)
    finally:
        stage.rmdir()
        sync(root.parent)
    fault(phase, root)


def verify_targets(value, expected):
    values = target_bytes(Path(value['package']['path']))
    if any(digest(values[n]) != expected[n] for n in TARGETS):
        fail('Chat pair does not match the required generation')
    return values


def execute(args):
    root, ledger, decision = map(Path, (args.root, args.ledger, args.decision))
    terminal = root.with_name(root.name + '.terminal')
    directory(root.parent, 0o700)
    # The canonical installer also holds its global lifecycle lock. A directory
    # flock serializes even first publication / terminal cleanup without a
    # leftover lock file or a lock inode replaced with the generation.
    fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'cleanup' and os.path.lexists(terminal):
            if os.path.lexists(root):
                fail('two Chat cleanup generations')
            if os.path.lexists(terminal / JOURNAL):
                value, before, _ = load(root, ledger, terminal)
                if value['phase'] not in {'committed', 'rolled-back'}:
                    fail('nonterminal Chat generation')
                expected = ({n: p[1] for n, p in TARGETS.items()} if value['phase'] == 'committed'
                            else {n: digest(b) for n, b in before.items()})
                verify_targets(value, expected)
            sweep(terminal)
            return
        if os.path.lexists(terminal):
            fail('Chat terminal cleanup must complete first')
        if args.action == 'installed':
            core = Path(args.package)
            package(core)
            values = target_bytes(core)
            if any(digest(values[n]) != TARGETS[n][1] for n in TARGETS):
                fail('installed Chat pair is not the accepted generation')
            return
        if args.action == 'prepare':
            if os.path.lexists(root) or os.path.lexists(decision):
                fail('existing transaction/decision forbids fresh Chat preparation')
            owner = outer(ledger)
            if owner['phase'] != 'migration-prepared':
                fail('Chat preparation is outside the authorized migration phase')
            inactive(args.inactive_json)
            core = Path(args.package)
            identity = package(core)
            before = target_bytes(core)
            if len({TARGETS[n].index(digest(b)) for n, b in before.items()}) != 1:
                fail('mixed pair without a recovery generation')
            payload = {n: read(Path(args.payload) / n, 0o644) for n in TARGETS}
            if any(digest(payload[n]) != TARGETS[n][1] for n in TARGETS):
                fail('accepted Chat payload drift')
            helper = SELF_BYTES
            stage = Path(tempfile.mkdtemp(prefix='.native-chat-prepare-', dir=root.parent))
            # A killed preparation can leave a private unarmed staging tree.
            # It never authorizes target writes; preserve it, do not guess.
            atomic(stage / HELPER, helper)
            value = dict(schema=SCHEMA, root=str(root), identity=directory(stage, 0o700),
                         generation=os.urandom(16).hex(), phase='prepared', binding=None,
                         decisionSha256=None, helperSha256=digest(helper), package=identity,
                         outer={'ledger': str(ledger), 'identity': directory(ledger.parent, 0o700),
                                'generation': owner['generation']},
                         before={n: {'sha256': digest(b), 'base64': base64.b64encode(b).decode()}
                                 for n, b in before.items()})
            atomic(stage / JOURNAL, canonical(value))
            fault('before-publication', root)
            os.rename(stage, root)
            sync(root.parent)
            fault('prepared', root)
            for name in TARGETS:
                inactive(args.inactive_json)
                if package(core) != identity or target_bytes(core)[name] != before[name]:
                    fail('target drift before publication')
                if before[name] != payload[name]:
                    atomic(core / 'dist' / name, payload[name], 0o644)
                fault('target-' + name, root)
            verify_targets(value, {n: p[1] for n, p in TARGETS.items()})
            save(root, value, 'applied')
            return
        value, before, owner = load(root, ledger)
        core = Path(value['package']['path'])
        if args.action == 'verify':
            if value['phase'] not in {'applied', 'commit-pending', 'committed'}:
                fail('Chat generation is not applied')
            verify_targets(value, {n: p[1] for n, p in TARGETS.items()})
        elif args.action == 'arm-commit':
            if value['phase'] != 'applied' or owner['phase'] != 'commit-pending' or os.path.lexists(decision):
                fail('invalid Chat predecision boundary')
            binding = json.loads(args.binding)
            if (binding.get('generation') != owner['generation'] or binding.get('ledgerPath') != str(ledger)
                    or binding.get('transactionRoot') != str(ledger.parent)
                    or binding.get('commitPendingLedgerSha256') != digest(read(ledger))):
                fail('outer commit binding mismatch')
            verify_targets(value, {n: p[1] for n, p in TARGETS.items()})
            value['binding'] = binding
            save(root, value, 'commit-pending')
        elif args.action == 'commit':
            if value['phase'] not in {'commit-pending', 'committed'}:
                fail('Chat commit was not armed')
            record = document(decision)
            decision_hash = digest(read(decision))
            if (record.get('schema') != 'bridgesllm-openclaw-tested-pair-commit-v5'
                    or record.get('migration') != value['binding']
                    or owner['phase'] not in {'commit-pending', 'commit-applying', 'committed-cleanup'}):
                fail('decision does not own this Chat generation')
            if owner['phase'] == 'commit-pending':
                if value['binding']['commitPendingLedgerSha256'] != digest(read(ledger)):
                    fail('pending ledger drift')
            elif owner['commit'] != {'pendingLedgerSha256': value['binding']['commitPendingLedgerSha256'],
                                     'decisionSha256': decision_hash}:
                fail('outer commit chain drift')
            if value['decisionSha256'] not in {None, decision_hash}:
                fail('Chat decision changed')
            verify_targets(value, {n: p[1] for n, p in TARGETS.items()})
            value['decisionSha256'] = decision_hash
            save(root, value, 'committed')
        elif args.action == 'rollback':
            if (os.path.lexists(decision) or value['phase'] == 'committed'
                    or owner['phase'] not in {'recovery-pending', 'migration-restored', 'upgrade-restored'}):
                fail('rollback lacks an undecided recovery owner')
            inactive(args.inactive_json)
            # Validate ALL targets before any restoration. Unknown drift is
            # never overwritten, even when the other half has a good backup.
            target_bytes(core)
            save(root, value, 'rollback-pending')
            for name in reversed(TARGETS):
                inactive(args.inactive_json)
                current = target_bytes(core)
                if package(core) != value['package']:
                    fail('package changed during rollback')
                if current[name] != before[name]:
                    atomic(core / 'dist' / name, before[name], 0o644)
                fault('rollback-' + name, root)
            verify_targets(value, {n: digest(b) for n, b in before.items()})
            save(root, value, 'rolled-back')
        elif args.action == 'cleanup':
            if value['phase'] not in {'committed', 'rolled-back'}:
                fail('Chat cleanup is not terminal')
            expected = ({n: p[1] for n, p in TARGETS.items()} if value['phase'] == 'committed'
                        else {n: digest(b) for n, b in before.items()})
            verify_targets(value, expected)
            os.rename(root, terminal)
            sync(root.parent)
            fault('terminal', root)
            sweep(terminal)
    finally:
        os.close(fd)


def sweep(terminal):
    # The atomic terminal rename is cleanup authority, never byte-write or
    # restart authority. Keep the sealed helper until the journal is retired.
    directory(terminal, 0o700)
    if set(p.name for p in terminal.iterdir()) - {JOURNAL, HELPER}:
        fail('unexpected terminal evidence; preserve it')
    # Inspect every remaining file before retiring any evidence.
    if os.path.lexists(terminal / HELPER) and read(terminal / HELPER) != SELF_BYTES:
        fail('terminal helper drift')
    if os.path.lexists(terminal / JOURNAL):
        value = document(terminal / JOURNAL)
        if value.get('schema') != SCHEMA or value.get('phase') not in {'committed', 'rolled-back'}:
            fail('nonterminal Chat cleanup evidence')
        (terminal / JOURNAL).unlink()
        sync(terminal)
        fault('cleanup-journal', terminal.with_name(terminal.name.removesuffix('.terminal')))
    if os.path.lexists(terminal / HELPER):
        (terminal / HELPER).unlink()
        sync(terminal)
        fault('cleanup-helper', terminal.with_name(terminal.name.removesuffix('.terminal')))
    terminal.rmdir()
    sync(terminal.parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['installed', 'prepare', 'verify', 'arm-commit', 'commit', 'rollback', 'cleanup'])
    for name in ['root', 'ledger', 'decision']:
        parser.add_argument('--' + name, required=True)
    for name in ['package', 'payload', 'binding', 'inactive-json']:
        parser.add_argument('--' + name)
    args = parser.parse_args()
    if os.geteuid() != 0:
        fail('root lifecycle required')
    execute(args)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit('Native Chat transaction refused: ' + str(error))
