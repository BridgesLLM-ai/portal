#!/usr/bin/env python3
"""Repair only the Portal question bridge on an already-installed native runtime.

Used from a verified, staged Portal release BEFORE promoting Portal. Core,
provider packages, configuration, sessions and databases are never modified.
Directory exchange is atomic; even a killed updater leaves a complete plugin.
The installer operation lock serializes this with all other Portal operations.
"""
import argparse
import ctypes
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import time
import urllib.request

FILES = ('index.js', 'package.json', 'openclaw.plugin.json')
STATE = Path('/root/.openclaw')
TARGET = STATE / 'extensions/bridgesllm-ask-user'
TRANSACTION = STATE / 'extensions/.bridgesllm-native-bridge-update'
CONFIG = STATE / 'openclaw.json'
UNIT = 'openclaw-gateway.service'
ENV = dict(os.environ, OPENCLAW_ALLOW_ROOT='1')
NATIVE_VERSIONS = {'2026.9.1', '2026.9.2', '2026.9.3'}


def private(path, directory=False):
    if path.resolve() != path:
        raise RuntimeError('Question bridge path uses a symbolic link')
    for item in (path, *path.parents):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Question bridge path is writable by another account')
    info = path.lstat()
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Question bridge directory is not regular')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('Question bridge file is not a single regular file')
    return path


def checksum(path):
    return hashlib.sha256(private(path).read_bytes()).hexdigest()


def tree(path):
    private(path, True)
    if {p.name for p in path.iterdir()} != set(FILES):
        raise RuntimeError('Question bridge contains unexpected files; retained without mutation')
    return {name: checksum(path / name) for name in FILES}


def flush(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def record(value):
    temporary = TRANSACTION / 'record.tmp'
    temporary.write_text(json.dumps(value, sort_keys=True) + '\n')
    temporary.chmod(0o600)
    flush(temporary)
    os.replace(temporary, TRANSACTION / 'record.json')
    flush(TRANSACTION)


def exchange(left, right):
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    if rename(-100, os.fsencode(left), -100, os.fsencode(right), 2):
        raise OSError(ctypes.get_errno(), 'Atomic question bridge exchange failed')
    flush(left.parent)
    flush(right.parent)


def run(args, timeout=60):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=ENV)


def active():
    return run(['/usr/bin/systemctl', 'is-active', '--quiet', UNIT], 10).returncode == 0


def unit_identity():
    result = run(['/usr/bin/systemctl', 'show', UNIT, '--property=MainPID,InvocationID,ActiveState,SubState'], 10)
    if result.returncode:
        raise RuntimeError('Gateway identity unavailable')
    return result.stdout


def ready():
    try:
        config = json.loads(private(CONFIG).read_text())
        port = config.get('gateway', {}).get('port', 18789)
        if type(port) is not int or not 1 <= port <= 65535:
            return False
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/readyz', timeout=5) as response:
            return json.load(response).get('ready') is True
    except (OSError, ValueError):
        return False


def restart_ready():
    if run(['/usr/bin/systemctl', 'restart', UNIT], 120).returncode:
        raise RuntimeError('Gateway restart failed')
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        if active() and ready():
            return
        time.sleep(2)
    raise RuntimeError('Gateway readiness did not return')


def inspect_native_plugin():
    result = run(['openclaw', 'plugins', 'inspect', 'bridgesllm-ask-user', '--json', '--runtime'], 120)
    if result.returncode:
        raise RuntimeError('Native question bridge runtime inspection failed')
    data = json.loads(result.stdout)
    plugin = data.get('plugin', {})
    if (plugin.get('id') != 'bridgesllm-ask-user'
            or plugin.get('version') != '4.0.0' or plugin.get('status') != 'loaded'
            or plugin.get('enabled') is not True or plugin.get('activated') is not True
            or plugin.get('error') or Path(plugin.get('rootDir', '')).resolve() != TARGET
            or plugin.get('toolNames') != [] or plugin.get('hookCount') != 0
            or data.get('typedHooks') != []
            or data.get('gatewayMethods') != ['bridgesllm.ask_user.steer']):
        raise RuntimeError('Native question bridge contract did not load')


def reconcile():
    if not TRANSACTION.exists():
        return
    private(TRANSACTION, True)
    ledger = TRANSACTION / 'record.json'
    if not ledger.exists():
        # No durable decision exists, so no exchange was permitted.
        shutil.rmtree(TRANSACTION)
        flush(TRANSACTION.parent)
        return
    value = json.loads(private(ledger).read_text())
    if value.get('schema') != 'bridgesllm.native-bridge-update.v1':
        raise RuntimeError('Unrecognized question bridge recovery record')
    slot = TRANSACTION / 'plugin'
    actual = tree(TARGET)
    if actual == value['after'] and value.get('phase') == 'committed':
        shutil.rmtree(TRANSACTION)
        flush(TRANSACTION.parent)
        return
    if actual == value['after']:
        if tree(slot) != value['before']:
            raise RuntimeError('Previous question bridge changed; retained for operator recovery')
        value['phase'] = 'rolling-back'
        record(value)
        exchange(TARGET, slot)
    elif actual != value['before']:
        raise RuntimeError('Question bridge changed outside this update; retained without overwriting it')
    # A prepared record with the original tree means no exchange happened.
    # Do not restart a gateway somebody changed during our preparation. Once
    # rollback starts its durable phase covers a kill after the exchange back.
    if value['wasActive'] and value['phase'] == 'rolling-back':
        restart_ready()
    shutil.rmtree(TRANSACTION)
    flush(TRANSACTION.parent)


def repair(source):
    if not STATE.exists() or not shutil.which('openclaw'):
        print('Question bridge: OpenClaw not installed; unchanged')
        return
    private(STATE, True)
    for pending in (
        Path('/var/lib/bridgesllm-installer/openclaw-2026.9.1-migration-v2'),
        Path('/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1'),
        Path('/run/bridgesllm/openclaw-gateway-migration-permit.v1'),
        STATE / '.bridgesllm-ask-user-tested-pair-v1',
    ):
        if os.path.lexists(pending):
            raise RuntimeError('An OpenClaw maintenance operation must recover before the question bridge update')
    if TRANSACTION.exists():
        reconcile()
    version_result = run(['openclaw', '--version'])
    match = re.fullmatch(r'(?:OpenClaw )?(\d{4}\.\d+\.\d+(?:-[\w.-]+)?)(?: \([a-f0-9]+\))?', version_result.stdout.strip())
    if version_result.returncode or not match:
        raise RuntimeError('Installed OpenClaw version could not be read')
    version = match[1]
    if version not in NATIVE_VERSIONS:
        print('Question bridge: retained non-native runtime is unchanged')
        return
    if not TARGET.exists():
        raise RuntimeError('Native OpenClaw question bridge is missing; run Compatible AI Tools to install it')
    before = tree(TARGET)
    old_version = json.loads((TARGET / 'package.json').read_text()).get('version')
    if old_version == '4.0.0':
        print('Question bridge: native-compatible version already installed; gateway unchanged')
        return
    if old_version != '3.3.0':
        raise RuntimeError('Unknown installed question bridge version; retained without mutation')
    after = {name: checksum(source / name) for name in FILES}
    if json.loads((source / 'package.json').read_text()).get('version') != '4.0.0':
        raise RuntimeError('Signed release does not contain the native question bridge')
    config = json.loads(private(CONFIG).read_text())
    if config.get('plugins', {}).get('entries', {}).get('bridgesllm-ask-user', {}).get('enabled') is not True:
        raise RuntimeError('Question bridge is not enabled; configuration remains unchanged')
    config_digest = checksum(CONFIG)
    was_active = active()
    if was_active and not ready():
        raise RuntimeError('Existing gateway is not ready; no plugin was changed')
    original_identity = unit_identity()
    private(TARGET.parent, True)
    TRANSACTION.mkdir(mode=0o700)
    slot = TRANSACTION / 'plugin'
    slot.mkdir(mode=0o700)
    for name in FILES:
        shutil.copyfile(source / name, slot / name)
        (slot / name).chmod(0o600)
        flush(slot / name)
    flush(slot)
    if tree(slot) != after:
        raise RuntimeError('Staged question bridge changed')
    value = dict(schema='bridgesllm.native-bridge-update.v1', before=before,
                 after=after, configSha256=config_digest, wasActive=was_active, phase='prepared')
    record(value)
    try:
        if tree(TARGET) != before or checksum(CONFIG) != config_digest or unit_identity() != original_identity:
            raise RuntimeError('Gateway or plugin changed during preparation; no exchange performed')
        exchange(TARGET, slot)
        if was_active:
            restart_ready()
        inspect_native_plugin()
        if checksum(CONFIG) != config_digest:
            raise RuntimeError('Configuration changed during question bridge update; original plugin will be restored')
        value['phase'] = 'committed'
        record(value)
    except BaseException:
        reconcile()
        raise
    reconcile()
    print('Question bridge: native-compatible plugin verified; core, configuration and data unchanged')


if __name__ == '__main__':
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit('Question bridge repair requires root')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    arguments = parser.parse_args()
    def interrupted(signum, frame):
        raise RuntimeError('Question bridge update interrupted')
    for event in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(event, interrupted)
    try:
        repair(arguments.source)
    except Exception as error:
        raise SystemExit('Question bridge update: ' + str(error))
