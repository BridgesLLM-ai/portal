#!/usr/bin/env python3
"""Create the private display's X authority over stdin, never argv or logs."""
import os
import secrets
import subprocess
from pathlib import Path
os.umask(0o077)
p = Path('/run/bridges-shared-desktop/transport/Xauthority')
if p.is_symlink():
    raise SystemExit('X authority must not be a symlink')
p.touch(mode=0o600, exist_ok=True)
os.chmod(p, 0o600)
subprocess.run(['xauth', '-f', str(p), 'source', '-'],
               input=f'add :2 . {secrets.token_hex(16)}\n', text=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
