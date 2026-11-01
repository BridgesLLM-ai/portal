#!/usr/bin/env python3
"""Custody of the Portal question plugin's derived native registry projection.

The native leased writer refreshes the registry. This helper never manufactures
native plugin rows: it saves their exact predecessor and permits rollback only
when every foreign authority field is unchanged, except the authenticated
restore-only empty-allow registration mistake below. Native 2026.10.5/2026.10.6 (identical index writer) may add
source-capture receipts; these are retained, never rolled back by this owner.
Config/plugin bytes retain their existing ask-user transaction and the outer migration still owns full state recovery.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import time

ACTION, STATE, TRANSACTION, SOURCE = sys.argv[1:]
state, transaction, source = map(Path, (STATE, TRANSACTION, SOURCE))
plugin_id = 'bridgesllm-ask-user'
snapshot = transaction / 'installed-index.previous.json'
manifest = transaction / 'manifest.json'
database = state / 'state/openclaw.sqlite'

def fail(message):
    raise SystemExit('Question plugin registry: ' + message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

# Custody bounds are per file type. JSON custody files are read whole into
# memory; the shared SQLite database is only opened through SQLite, so its
# bound is a sanity limit, never the JSON limit.
JSON_CUSTODY_MAX_BYTES = 16 * 1024 * 1024
SQLITE_CUSTODY_MAX_BYTES = 64 * 1024 * 1024 * 1024

def secure(path, directory=False, max_bytes=JSON_CUSTODY_MAX_BYTES):
    for parent in [path, *path.parents]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            fail('unsafe custody path')
        if parent == path:
            if directory != stat.S_ISDIR(info.st_mode):
                fail('unexpected custody entry type')
            if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                fail('unsafe custody file')
            if not directory and info.st_size > max_bytes:
                fail(f'custody file exceeds its {max_bytes}-byte bound')
        if parent == state or parent == transaction:
            break

def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)

def atomic(path, value):
    secure(path.parent, True)
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n'
    if len(encoded.encode('utf-8')) > 16 * 1024 * 1024:
        fail('encoded snapshot exceeds the custody byte limit')
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def row(connection):
    tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'state_leases' in tables and connection.execute(
        "SELECT 1 FROM state_leases WHERE (scope='core:plugin-lifecycle' OR scope='claw-package-lifecycle') AND expires_at>? LIMIT 1",
        (int(time.time()*1000),)).fetchone():
        fail('plugin lifecycle lease is active')
    if 'config_machine_state' not in tables:
        return None
    return connection.execute("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='plugins.installedIndex'").fetchone()

def normalized(raw):
    if raw is None:
        return None, []
    value = decode(raw)
    if not isinstance(value, dict) or not isinstance(value.get('index'), dict):
        fail('unsupported native index shape')
    index = value['index']
    if not isinstance(index.get('plugins'), list):
        fail('native index has no plugin rows')
    owned = []
    foreign = []
    for entry in index['plugins']:
        if isinstance(entry, dict) and entry.get('pluginId') == plugin_id:
            if entry.get('rootDir') != str(state / 'extensions' / plugin_id):
                fail('question plugin row has a foreign root')
            owned.append(entry)
        else:
            foreign.append(entry)
    if len(owned) > 1:
        fail('duplicate question plugin rows')
    index['plugins'] = sorted(foreign, key=lambda r: json.dumps(r, sort_keys=True))
    if isinstance(index.get('diagnostics'), list):
        index['diagnostics'] = [r for r in index['diagnostics'] if not isinstance(r, dict) or r.get('pluginId') != plugin_id]
    # Native registry revision and policy receipts are derived cache metadata;
    # every foreign contribution, install record, path and byte hash stays exact.
    value.pop('revision', None)
    for key in ('generatedAtMs', 'refreshReason', 'policyHash'):
        index.pop(key, None)
    return json.dumps(value, sort_keys=True, separators=(',', ':')), owned

def native_receipt(value):
    """Validate the 10.5 receipt wire shape, not its native admission authority."""
    def string(v):
        return isinstance(v, str) and bool(v)
    def sha(v):
        return isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) is not None
    def size(v):
        return type(v) is int and 0 <= v <= 9007199254740991
    def fields(v, required, optional={}):
        return (isinstance(v, dict) and required.keys() <= v.keys()
                and v.keys() <= required.keys() | optional.keys()
                and all(check(v[k]) for k, check in required.items())
                and all(optional[k](v[k]) for k in v.keys() - required.keys()))
    def records(check):
        return lambda v: isinstance(v, dict) and all(isinstance(k, str) and check(x) for k, x in v.items())
    member = lambda v: fields(v, dict(source=string, sourceIdentity=string,
        capturedIdentity=string, boundaryChecked=lambda x: type(x) is bool),
        dict(contentHash=sha, sizeBytes=size))
    namespace = lambda v: fields(v, dict(sourceDirectory=string, capturedRoot=string,
        managed=lambda x: type(x) is bool, members=records(member)), dict(referenceRoot=string))
    artifact = lambda v: fields(v, dict(sourceIdentity=string, contentHash=sha,
        sizeBytes=size, capturedPath=string, namespace=string, capturedIdentity=string))
    return fields(value, dict(signature=string, sourceDigest=sha,
        nativeArtifacts=records(artifact), nativeNamespaces=records(namespace)))

BUILD_HINT_FIELDS = frozenset(('openclawVersion', 'staticAssets', 'workerEntries', 'bundledDist'))

def persisted_build_projection(build):
    """The persisted reader's projection of one valid native build-hint set.

    Any unknown field or malformed value returns None and stays strict.
    """
    if not isinstance(build, dict) or not build.keys() <= BUILD_HINT_FIELDS:
        return None
    if 'openclawVersion' in build and (not isinstance(build['openclawVersion'], str)
            or re.fullmatch(r'[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?', build['openclawVersion']) is None):
        return None
    if 'bundledDist' in build and type(build['bundledDist']) is not bool:
        return None
    if 'workerEntries' in build and (not isinstance(build['workerEntries'], list)
            or not all(isinstance(x, str) for x in build['workerEntries'])):
        return None
    if 'staticAssets' in build and (not isinstance(build['staticAssets'], list)
            or not all(isinstance(x, dict) and set(x) == {'source', 'output'}
                       and all(isinstance(v, str) for v in x.values()) for x in build['staticAssets'])):
        return None
    return {k: v for k, v in build.items() if k == 'bundledDist'}

def derived_build_equivalence(old, new):
    """Native discovery publishes build hints derived from package.json; the
    persisted 10.5/10.6 reader keeps only bundledDist. A full set and its own
    projection describe one package when its package.json identity is unchanged,
    in either direction. Two different full sets, a changed bundledDist, unknown
    fields and every other row difference still compare unequal."""
    left, right = old.get('packageBuild'), new.get('packageBuild')
    if left == right:
        return
    projected = persisted_build_projection(left)
    package = old.get('packageJson')
    if (projected is None or projected != persisted_build_projection(right)
            or projected not in (left, right)
            or not isinstance(package, dict) or new.get('packageJson') != package
            or not isinstance(package.get('hash'), str)
            or re.fullmatch('[a-f0-9]{64}', package['hash']) is None):
        return
    old['packageBuild'] = new['packageBuild'] = projected

def foreign_projection(before_raw, after_raw):
    """Permit only the observed 10.5 schema projection and additive native receipt.

    Install identity, roots, hashes, configuration, diagnostics and install records
    still compare exactly. Existing receipts cannot disappear or change. A newly
    published receipt is not installer authority: preserve it value-for-value in
    the foreign row, leaving its interpretation/capture custody to native code.
    """
    before = decode(before_raw) if before_raw is not None else None
    after = decode(after_raw) if after_raw is not None else None
    if not before or not after or any(v.get('index', {}).get('hostContractVersion') not in ('2026.10.5', '2026.10.6')
                                     for v in (before, after)):
        return before_raw, after_raw
    def rows(value):
        result = {}
        for entry in value['index']['plugins']:
            if not isinstance(entry, dict) or not isinstance(entry.get('pluginId'), str) or entry['pluginId'] in result:
                fail('invalid or duplicate native plugin row')
            result[entry['pluginId']] = entry
        return result
    previous, current = rows(before), rows(after)
    for identity, old in previous.items():
        new = current.get(identity)
        if new is None or identity == plugin_id:
            continue
        derived_build_equivalence(old, new)
        if old.get('sourceAdmissions') == new.get('sourceAdmissions'):
            continue
        key = str(old.get('rootDir')) + '\0'
        receipts = new.get('sourceAdmissions')
        if ('sourceAdmissions' in old or not old.get('installRecordHash')
                or not isinstance(receipts, dict) or set(receipts) != {key}
                or not native_receipt(receipts[key])):
            fail('foreign source admission drift')
        old['sourceAdmissions'] = receipts
    for value in (before, after):
        value['index']['plugins'].sort(key=lambda r: json.dumps(r, sort_keys=True))
    return (json.dumps(before, sort_keys=True, separators=(',', ':')),
            json.dumps(after, sort_keys=True, separators=(',', ':')))

def empty_allow_restore(before_raw, after_raw):
    """Authenticate only the old registrar's empty -> singleton allow mistake.

    This is rollback authority, never forward attestation. The sealed predecessor
    config and exact old registrar output must explain the entire live config;
    every normalized foreign field other than true -> false remains exact.
    """
    if (ACTION != 'restore' or before_raw is None or after_raw is None
            or owner.get('configPreexisted') is not True or owner.get('targetPreexisted') is not False):
        fail('foreign registry drift; full outer state recovery is required')
    previous = transaction / 'previous-openclaw.json'
    config = state / 'openclaw.json'
    secure(previous)
    secure(config)
    raw = previous.read_bytes()
    if digest(raw) != owner.get('previousConfigSha256'):
        fail('empty-allow restore predecessor config digest mismatch')
    value = decode(raw)
    plugins = value.get('plugins') if isinstance(value, dict) else None
    if not isinstance(plugins, dict) or plugins.get('allow') != []:
        fail('empty-allow restore requires the sealed empty allowlist')
    entries = plugins.setdefault('entries', {})
    if not isinstance(entries, dict) or plugin_id in entries:
        fail('empty-allow restore requires a fresh question registration')
    plugins['allow'] = [plugin_id]
    entries[plugin_id] = dict(enabled=True, config={})
    expected = (json.dumps(value, indent=2) + '\n').encode('utf-8')
    if config.read_bytes() != expected:
        fail('empty-allow restore live config differs from exact owned registration')
    before, after = decode(before_raw), decode(after_raw)
    if any(v.get('index', {}).get('hostContractVersion') not in ('2026.10.5', '2026.10.6') for v in (before, after)):
        fail('empty-allow restore requires a supported native index')
    previous_rows = {p['pluginId']: p for p in before['index']['plugins']}
    enabled = set()
    for entry in after['index']['plugins']:
        old = previous_rows.get(entry['pluginId'], {})
        if (type(old.get('enabled')) is not bool or type(entry.get('enabled')) is not bool
                or (old['enabled'] is False and entry['enabled'] is True)):
            fail('foreign registry drift beyond the exact empty-allow registration')
        # An unchanged enabled native slot is not registration damage. Preserve
        # it exactly; only the authenticated true->false changes are reversed.
        if old.get('enabled') is True and entry.get('enabled') is False:
            entry['enabled'] = True
            enabled.add(entry['pluginId'])
    for value in (before, after):
        value['index']['plugins'].sort(key=lambda r: json.dumps(r, sort_keys=True))
    # Dict equality erases JSON type changes (True == 1, False == 0).
    # Use the same canonical wire comparison as forward attestation.
    exact = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'))
    if not enabled or exact(before) != exact(after):
        fail('foreign registry drift beyond the exact empty-allow registration')
    return enabled


def restored_projection(saved_raw, current_raw, enabled=frozenset()):
    # Restore only this transaction's owned projection. Foreign rows (including
    # native receipt/capture authority) stay exactly as read under the DB lock,
    # except enabled flags authenticated by empty_allow_restore.
    saved, current = decode(saved_raw), decode(current_raw)
    if current['index'].get('hostContractVersion') not in ('2026.10.5', '2026.10.6'):
        return saved_raw
    foreign = [p for p in current['index']['plugins'] if p.get('pluginId') != plugin_id]
    for entry in foreign:
        if entry.get('pluginId') in enabled:
            entry['enabled'] = True
    owned = [p for p in saved['index']['plugins'] if p.get('pluginId') == plugin_id]
    saved['index']['plugins'] = foreign + owned
    return json.dumps(saved, sort_keys=True, separators=(',', ':'))

if ACTION not in {'snapshot', 'attest', 'restore'} or not state.is_absolute() or transaction != state / '.bridgesllm-ask-user-tested-pair-v1':
    fail('invalid transaction binding')
if state.resolve() != state or transaction.resolve() != transaction:
    fail('noncanonical transaction path')
secure(state, True)
secure(transaction, True)
secure(manifest)
owner = decode(manifest.read_bytes())
if owner.get('schema') != 'bridgesllm-ask-user-tested-pair-v1' or owner.get('stateRoot') != str(state) or owner.get('configPath') != str(state / 'openclaw.json') or owner.get('targetDir') != str(state / 'extensions' / plugin_id):
    fail('unsupported ask-user transaction')
# Older sealed ask-user transactions never authorized an index write.
if ACTION != 'snapshot' and 'installedIndexSnapshotSha256' not in owner:
    raise SystemExit(0)
if database.exists():
    secure(database, max_bytes=SQLITE_CUSTODY_MAX_BYTES)
    connection = sqlite3.connect(str(database), isolation_level=None, timeout=10)
else:
    connection = None
try:
    if connection:
        connection.execute('BEGIN IMMEDIATE')
    current = row(connection) if connection else None
    if ACTION == 'snapshot':
        if snapshot.exists() or 'installedIndexSnapshotSha256' in owner:
            fail('index snapshot already exists')
        saved = {'schema': 1, 'databasePresent': bool(connection), 'valueJson': current[0] if current else None,
                 'updatedAtMs': current[1] if current else None}
        # Snapshot is not publication authority until the existing manifest binds it.
        atomic(snapshot, saved)
        owner['installedIndexSnapshotSha256'] = digest(snapshot.read_bytes())
        atomic(manifest, owner)
    else:
        secure(snapshot)
        raw = snapshot.read_bytes()
        if digest(raw) != owner['installedIndexSnapshotSha256']:
            fail('index snapshot digest mismatch')
        saved = decode(raw)
        before, _ = normalized(saved['valueJson'])
        after, owned = normalized(current[0] if current else None)
        before, after = foreign_projection(before, after)
        enabled = empty_allow_restore(before, after) if before != after else frozenset()
        if ACTION == 'attest':
            if len(owned) != 1:
                fail('question plugin was not indexed')
            entry = owned[0]
            secure(source, True)
            for name in ('openclaw.plugin.json', 'package.json'):
                secure(source / name)
            package = decode((source / 'package.json').read_bytes())
            if entry.get('manifestHash') != digest((source / 'openclaw.plugin.json').read_bytes()) or entry.get('packageVersion') != package.get('version') or entry.get('packageJson', {}).get('hash') != digest((source / 'package.json').read_bytes()):
                fail('indexed question plugin bytes differ from the signed source')
        elif saved['valueJson'] is None:
            if connection and current:
                connection.execute("DELETE FROM config_machine_state WHERE state_key='plugins.installedIndex'")
        else:
            if connection is None:
                fail('predecessor registry database disappeared')
            connection.execute("INSERT OR REPLACE INTO config_machine_state VALUES('plugins.installedIndex',?,?)", (restored_projection(saved['valueJson'], current[0], enabled), saved['updatedAtMs']))
    if connection:
        connection.commit()
finally:
    if connection:
        connection.close()
