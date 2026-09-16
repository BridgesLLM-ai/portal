#!/usr/bin/env python3
"""Read-only qualification of the exact retained 2026.9.2 Chat revision 2.

This verifier is NOT a mutation/activation owner. An original or revision-2
result describes disk bytes only; it does not attest the running gateway.
No native modules, CLI, services, network, configuration or journals are used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

VERSION = '2026.9.2'
PACKAGE_SHA256 = 'aaba2fdde13e3d1a676102fc53195bac94d6236e9d9bef192c84dca04cf9ea5b'
SOURCE_LOCK_SHA256 = 'cc40afabebfc179518c3bdb8525060903960d39e323aa9c8515778ad5842f96c'
TARGETS = {
    'chat-IsrqkYID.js': (
        'b0387dcd7a41f60618f336cebbf9f01c21ac4cef83cda08e69fdc3bf9abc2e0a',
        '20c7b18e6d903972735e9ffb6b62930ea0eaaded9a9aef01277dd02ad07a8644'),
    'session-history-tail-BuFrV1Wb.js': (
        '6d8d0cbb5552f67b1c533cc6d847d44c3e67c7c0cd46c2a8d9b0e59e5825f5fd',
        '2627a3715460f960df50bdcd33fe8aeead991cc7b3898af9bca93e4fd897ca8d'),
    'session-transcript-readers-CYDRQsH5.js': (
        '6435d6948bafc69c5153f3ff39b51c3960696e3c2bbb494f84b4db60e4b70e07',
        'afe7a440b2da76aa3cf1d0f42d957f90507f8c98dd5952f26e9e9f9e61dfab7d'),
}


def fail(message):
    raise ValueError(message)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def directory(path):
    if not path.is_absolute() or Path(os.path.normpath(path)) != path:
        fail('noncanonical directory')
    for entry in [*reversed(path.parents), path]:
        s = entry.lstat()
        if not stat.S_ISDIR(s.st_mode) or (s.st_uid, s.st_gid) != (0, 0):
            fail('unsafe directory ancestry')
        if s.st_mode & 0o022 and not (entry == Path('/tmp') and s.st_mode & stat.S_ISVTX):
            fail('writable directory ancestry')
    s = path.lstat()
    return {'device': s.st_dev, 'inode': s.st_ino}


def read(path):
    directory(path.parent)
    # Open without following a final link and verify the opened inode as well
    # as the path before/after reading. Qualification is not write authority;
    # a future owner must revalidate under its own lock and reboot fence.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o644)
                or before.st_size > 2_000_000):
            fail('unsafe source file: ' + path.name)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            content = stream.read(2_000_001)
        after = os.fstat(fd)
        named = path.lstat()
        fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns,
                            s.st_mode, s.st_uid, s.st_gid, s.st_nlink)
        if fields(before) != fields(after) or fields(after) != fields(named) or len(content) != before.st_size:
            fail('source changed during qualification')
        return content
    finally:
        os.close(fd)


def payload(path):
    directory(path)
    if {p.name for p in path.iterdir()} != {*TARGETS, 'SOURCE-LOCK.json'}:
        fail('unexpected 9.2 payload member')
    if digest(read(path / 'SOURCE-LOCK.json')) != SOURCE_LOCK_SHA256:
        fail('revision-2 source lock drift')
    for name, pins in TARGETS.items():
        if digest(read(path / name)) != pins[1]:
            fail('revision-2 payload drift: ' + name)
    return {'version': VERSION, 'generation': 'revision-2', 'targets': {n: p[1] for n, p in TARGETS.items()}}


def qualify(path):
    identity = directory(path)
    raw = read(path / 'package.json')
    metadata = json.loads(raw)
    if not isinstance(metadata, dict) or metadata.get('name') != 'openclaw':
        fail('not an OpenClaw package')
    if metadata.get('version') != VERSION:
        fail('unsupported core version; this verifier is 2026.9.2 only')
    if digest(raw) != PACKAGE_SHA256:
        fail('package metadata differs from the qualified 9.2 snapshot')
    directory(path / 'dist')
    observed = {name: digest(read(path / 'dist' / name)) for name in TARGETS}
    if any(observed[n] not in pins for n, pins in TARGETS.items()):
        fail('unknown 9.2 native Chat source')
    indices = {TARGETS[n].index(value) for n, value in observed.items()}
    if len(indices) != 1:
        fail('mixed three-file Chat generation; only its existing owner may recover it')
    if directory(path) != identity or read(path / 'package.json') != raw:
        fail('package changed during qualification')
    return {'version': VERSION, 'generation': 'original' if indices == {0} else 'revision-2',
            'packageIdentity': identity, 'packageMetadataSha256': digest(raw), 'targets': observed,
            'runtimeAttested': False, 'mutationPerformed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--package-dir', type=Path)
    group.add_argument('--payload-dir', type=Path)
    args = parser.parse_args()
    result = qualify(args.package_dir) if args.package_dir is not None else payload(args.payload_dir)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise SystemExit('Native Chat 9.2 qualification refused: ' + str(error))
