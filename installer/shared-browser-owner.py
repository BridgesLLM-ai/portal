#!/usr/bin/env python3
"""Explicit dedicated-profile ownership. Never assign existing unowned cookies."""
import json
import os
import re
import stat
import sys
from pathlib import Path

STATE = Path('/var/lib/bridges-shared-browser')
PROFILE = Path('/home/bridgesbrowser/.config/portal-shared/profile')


def pin(owner, state=STATE, profile=PROFILE):
    if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', owner):
        raise ValueError('Explicit lowercase Portal owner UUID required')
    directory = state.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or stat.S_IMODE(directory.st_mode) != 0o700:
        raise ValueError('Unsafe profile-owner directory')
    owner_file = state / 'profile-owner.json'
    if os.path.lexists(owner_file):
        descriptor = os.open(owner_file, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 128:
                raise ValueError('Unsafe profile-owner file')
            if json.load(stream) != owner:
                raise ValueError('Owner differs; stop all dedicated services and explicitly archive the profile first')
        return
    # No import, silent wipe, or adoption of a previous principal's cookies.
    for parent in [profile, *profile.parents]:
        if parent.is_symlink():
            raise ValueError('Symlink in dedicated profile path')
    if profile.exists() and (not profile.is_dir() or any(profile.iterdir())):
        raise ValueError('Unowned profile data exists; explicit archive required')
    descriptor = os.open(owner_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(owner, stream)
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != 'pin' or os.geteuid() != 0:
        raise SystemExit('Usage (root): shared-browser-owner.py pin PORTAL_OWNER_UUID')
    try:
        pin(sys.argv[2])
    except (OSError, ValueError) as error:
        raise SystemExit(f'Shared browser ownership refused: {error}')
