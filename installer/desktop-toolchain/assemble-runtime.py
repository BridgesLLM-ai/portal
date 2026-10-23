#!/usr/bin/env python3
"""Assemble the Desktop GUI runtime inside the toolchain image build.

Runs only during the local image build. It bundles Electron's shared-library
closure (plus the NSS modules NSS loads at run time) from this same image,
normalizes modes, writes the runtime's own file manifest, and collects the
third-party notices that every Desktop build copies into its output.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

RUNTIME = Path('/opt/desktop-runtime/electron')
MANIFEST = Path('/opt/desktop-runtime/electron-files.json')
NOTICES = Path('/opt/desktop-seed/notices')
LIBRARY_DIRECTORY = Path('/usr/lib/x86_64-linux-gnu')
# The host supplies these from its own glibc (the installer requires >= 2.36).
HOST_LIBRARIES = re.compile(r'^(?:libc|libm|libdl|libpthread|librt|libresolv|libutil|ld-linux-x86-64)\.so')
# NSS dlopens these: they never appear in an ldd closure, and they must pair
# with the bundled libnss3 rather than whatever the host happens to ship.
NSS_MODULES = ('libsoftokn3.so', 'libfreeblpriv3.so')


def elf(path):
    with path.open('rb') as stream:
        return stream.read(4) == b'\x7fELF'


def closure(binary):
    output = subprocess.run(['ldd', str(binary)], capture_output=True, text=True, check=False).stdout
    for line in output.splitlines():
        if 'not found' in line:
            raise SystemExit('Missing runtime library for ' + str(binary) + ': ' + line.strip())
        match = re.search(r'=>\s+(/\S+)\s', line)
        if match:
            yield Path(match.group(1))


def bundle_libraries():
    library_root = RUNTIME / 'lib'
    library_root.mkdir(mode=0o755, exist_ok=True)
    binaries = [path for path in RUNTIME.rglob('*') if path.is_file() and not path.is_symlink() and elf(path)]
    for binary in binaries:
        for source in closure(binary):
            name = source.name
            if HOST_LIBRARIES.match(name) or (RUNTIME / name).exists():
                continue
            destination = library_root / name
            if destination.exists():
                if destination.read_bytes() != source.resolve().read_bytes():
                    raise SystemExit('Conflicting runtime library ' + name)
                continue
            shutil.copyfile(source.resolve(), destination)
    for name in NSS_MODULES:
        shutil.copyfile((LIBRARY_DIRECTORY / name).resolve(), library_root / name)
    # A private, empty GIO module directory keeps host GIO plugins out of the bundled GLib.
    (RUNTIME / 'gio-modules').mkdir(mode=0o755, exist_ok=True)
    (RUNTIME / 'gio-modules' / '.keep').write_bytes(b'')


def normalize_and_manifest():
    manifest = {}
    for directory, dirs, files in os.walk(RUNTIME, followlinks=False):
        Path(directory).chmod(0o755)
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise SystemExit('GUI runtime cannot contain links: ' + str(path))
        for name in files:
            path = Path(directory) / name
            mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
            path.chmod(mode)
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            manifest[str(path.relative_to(RUNTIME))] = {'sha256': digest, 'bytes': path.stat().st_size, 'mode': mode}
    if not {'electron', 'chrome-sandbox', 'lib/libnss3.so', 'lib/libsoftokn3.so', 'lib/libfreeblpriv3.so'} <= set(manifest):
        raise SystemExit('GUI runtime is incomplete')
    if manifest['chrome-sandbox']['mode'] & 0o6000:
        raise SystemExit('The setuid sandbox helper is never installed setuid')
    MANIFEST.write_text(json.dumps(manifest, sort_keys=True, indent=1) + '\n')
    MANIFEST.chmod(0o644)
    return manifest


def collect_notices():
    NOTICES.mkdir(mode=0o755, parents=True, exist_ok=True)
    electron = NOTICES / 'electron'
    electron.mkdir(exist_ok=True)
    for name in ('LICENSE', 'LICENSES.chromium.html'):
        shutil.copyfile(RUNTIME / name, electron / name)
    rust = NOTICES / 'rust'
    rust.mkdir(exist_ok=True)
    for license_file in Path('/opt/desktop-rust/share/doc').rglob('LICENSE*'):
        shutil.copyfile(license_file, rust / (license_file.parent.name + '-' + license_file.name))
    debian = NOTICES / 'debian'
    debian.mkdir(exist_ok=True)
    packages = subprocess.run(['dpkg-query', '-W', '-f', '${Package}\n'], capture_output=True, text=True, check=True).stdout.split()
    for package in packages:
        copyright_file = Path('/usr/share/doc') / package / 'copyright'
        if copyright_file.is_file():
            shutil.copyfile(copyright_file, debian / (package + '.copyright'))
    (NOTICES / 'README.txt').write_text(
        'Third-party notices for the Desktop toolchain components that a Desktop build may bundle:\n'
        'Electron/Chromium (electron/), the Rust standard library (rust/), and Debian packages\n'
        'whose shared libraries are copied next to built applications (debian/).\n'
        'Python packages installed into a build keep their own license metadata in the build output.\n')
    for directory, _, files in os.walk(NOTICES):
        Path(directory).chmod(0o755)
        for name in files:
            (Path(directory) / name).chmod(0o644)


def main():
    if os.geteuid() != 0 or not RUNTIME.is_dir():
        raise SystemExit('Run during the Desktop toolchain image build only')
    bundle_libraries()
    manifest = normalize_and_manifest()
    collect_notices()
    print(json.dumps({'runtimeFiles': len(manifest), 'runtimeBytes': sum(item['bytes'] for item in manifest.values())}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
