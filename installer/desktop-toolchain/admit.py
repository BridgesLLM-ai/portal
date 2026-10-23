#!/usr/bin/env python3
"""Admit the locally built Desktop toolchain image and its unprivileged GUI runtime.

The installer builds the image from this directory's recipe. Admission binds the
result to the recipe fingerprint, the recorded Project runtime base layers and
the image's own runtime manifest, then installs the Electron runtime root-owned
under a versioned, manifest-addressed directory. Nothing is downloaded here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

ROLE_LABEL = 'com.bridgesllm.desktop-toolchain.role'
RECIPE_LABEL = 'com.bridgesllm.desktop-toolchain.recipe-sha256'
ROLE = 'desktop-toolchain-v1'
ELECTRON_VERSION = '44.9.0'
RUNTIME_PARENT = Path('/usr/lib/bridgesllm-desktop')
PROFILE = Path('/etc/apparmor.d/bridgesllm-desktop-electron')
RECIPE_FILES = ('Dockerfile', 'assemble-runtime.py')
RECIPE_DIRECTORIES = ('seed-inputs',)
IMAGE_RUNTIME = '/opt/desktop-runtime/electron'
IMAGE_MANIFEST = '/opt/desktop-runtime/electron-files.json'
MIN_GLIBC = (2, 36)
MIN_DOCKER_FREE = 10 * 1024 ** 3
MIN_RUNTIME_FREE = 1024 ** 3
# NSS dlopens these modules; the runtime must carry the versions paired with its libnss3.
NSS_MODULES = ('lib/libsoftokn3.so', 'lib/libfreeblpriv3.so')
PROBE = ('node --version && cargo --version && rustc --version && cmake --version'
         ' && qtpaths6 --query QT_INSTALL_PLUGINS && python3 -c "import tkinter"'
         ' && test -s /opt/desktop-runtime/electron-files.json && test -d /opt/desktop-seed/notices'
         ' && ls /opt/desktop-seed/wheels | grep -q "^pyinstaller-6\\.16\\.0-"'
         ' && test -d /opt/desktop-seed/npm && test -d /opt/desktop-seed/cargo-home/registry')


class AdmissionError(Exception):
    pass


def prefixed(path, prefix):
    return Path(str(prefix) + str(path)) if prefix else path


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def docker(*args, timeout=180):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise AdmissionError('Docker operation failed: ' + result.stderr.strip()[-1500:])
    return result.stdout


# ---- host capability -------------------------------------------------------

def read_text(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def glibc_version():
    try:
        name, version = os.confstr('CS_GNU_LIBC_VERSION').split()
        major, minor = version.split('.')[:2]
        return name, (int(major), int(minor))
    except (ValueError, OSError, AttributeError):
        return None, None


def free_bytes(path):
    candidate = Path(path)
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    usage = shutil.disk_usage(candidate)
    return usage.free


def capability(docker_root, proc_root='', sys_root=''):
    """Return (code, message); code is 'supported' or an unavailable reason."""
    if os.uname().machine not in ('x86_64', 'amd64'):
        return 'architecture', 'Desktop builds need an x86_64 server.'
    name, version = glibc_version()
    if name != 'glibc' or version < MIN_GLIBC:
        return 'glibc', 'Desktop builds need glibc 2.36 or newer.'
    clone = read_text(proc_root + '/proc/sys/kernel/unprivileged_userns_clone')
    maximum = read_text(proc_root + '/proc/sys/user/max_user_namespaces')
    if clone == '0' or maximum == '0':
        return 'userns', 'Unprivileged user namespaces are turned off, so the Chromium sandbox cannot start.'
    if read_text(proc_root + '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') == '1':
        if not shutil.which('apparmor_parser') or not Path(sys_root + '/sys/kernel/security/apparmor/features/namespaces/userns_create').exists():
            return 'apparmor', 'AppArmor restricts user namespaces and cannot load the Desktop runtime profile.'
    try:
        pwd.getpwnam('bridgesrd')
    except KeyError:
        return 'remote-desktop', 'The Remote Desktop account is not installed.'
    if free_bytes(docker_root) < MIN_DOCKER_FREE or free_bytes(RUNTIME_PARENT) < MIN_RUNTIME_FREE:
        return 'disk', 'Not enough free disk space for the Desktop toolchain.'
    return 'supported', 'Desktop toolchain can be built on this server.'


def needs_profile(proc_root=''):
    return read_text(proc_root + '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') == '1'


# ---- recipe ----------------------------------------------------------------

def recipe_members(source):
    if source.is_symlink() or not source.is_dir():
        raise AdmissionError('Desktop toolchain recipe is not a directory')
    members = []
    for name in RECIPE_FILES:
        members.append(name)
    for directory in RECIPE_DIRECTORIES:
        root = source / directory
        for path in sorted(root.rglob('*')):
            if path.is_symlink():
                raise AdmissionError('Desktop toolchain recipe cannot contain links')
            if path.is_file():
                members.append(str(path.relative_to(source)))
    for name in members:
        path = source / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
            raise AdmissionError('Desktop toolchain recipe member is missing or unsafe: ' + name)
    return sorted(members)


def fingerprint(source):
    lines = ''.join(f'{sha(source / name)}  {name}\n' for name in recipe_members(source))
    return hashlib.sha256(lines.encode()).hexdigest()


def stage_context(source, destination):
    if destination.exists() and any(destination.iterdir()):
        raise AdmissionError('Desktop build context must start empty')
    for name in recipe_members(source):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
    return fingerprint(destination)


# ---- image attestation -----------------------------------------------------

def inspect_one(kind, reference):
    value = json.loads(docker(kind, 'inspect', reference))
    if len(value) != 1:
        raise AdmissionError('Docker identity is ambiguous')
    return value[0]


def attest(image, base_image, recipe_sha256, probe=True):
    if not re.fullmatch(r'[a-f0-9]{64}', recipe_sha256 or ''):
        raise AdmissionError('Desktop recipe fingerprint is invalid')
    value = inspect_one('image', image)
    base = inspect_one('image', base_image)
    config = value.get('Config') or {}
    labels = config.get('Labels') or {}
    layers = (value.get('RootFS') or {}).get('Layers') or []
    base_layers = (base.get('RootFS') or {}).get('Layers') or []
    if (not re.fullmatch(r'sha256:[a-f0-9]{64}', value.get('Id', '')) or value.get('Os') != 'linux'
            or value.get('Architecture') != 'amd64' or config.get('User') != '1000:1000'
            or config.get('WorkingDir') != '/workspace/project' or config.get('Entrypoint') or config.get('Volumes')
            or labels.get(ROLE_LABEL) != ROLE or labels.get(RECIPE_LABEL) != recipe_sha256):
        raise AdmissionError('Desktop toolchain image does not match its recipe')
    if not base_layers or layers[:len(base_layers)] != base_layers or len(layers) <= len(base_layers):
        raise AdmissionError('Desktop toolchain image is not built on the recorded Project runtime image')
    if probe:
        docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--entrypoint', 'sh', value['Id'], '-c', PROBE, timeout=120)
    return value['Id']


# ---- host runtime ----------------------------------------------------------

def runtime_manifest(text):
    value = json.loads(text)
    if not isinstance(value, dict) or not 1 <= len(value) <= 5000:
        raise AdmissionError('GUI runtime inventory is invalid')
    for name, item in value.items():
        if (not isinstance(name, str) or name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/'))
                or '\\' in name or any(ord(ch) < 32 for ch in name) or not isinstance(item, dict)
                or not re.fullmatch(r'[a-f0-9]{64}', str(item.get('sha256', '')))
                or item.get('mode') not in (0o644, 0o755) or not isinstance(item.get('bytes'), int)
                or not 0 <= item['bytes'] <= 512 * 1024 * 1024):
            raise AdmissionError('GUI runtime inventory member is invalid')
    if not {'electron', 'chrome-sandbox', *NSS_MODULES} <= set(value):
        raise AdmissionError('GUI runtime inventory is incomplete')
    if sum(item['bytes'] for item in value.values()) > 1024 ** 3:
        raise AdmissionError('GUI runtime exceeds its bound')
    return value


def manifest_digest(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verify_tree(root, expected, require_traversal=False):
    found = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for child in [Path(directory), *(Path(directory) / name for name in dirs + files)]:
            info = child.lstat()
            if info.st_uid != 0 or info.st_mode & 0o7022 or stat.S_ISLNK(info.st_mode):
                raise AdmissionError('GUI runtime ownership or permissions are unsafe')
            if stat.S_ISDIR(info.st_mode):
                if require_traversal and stat.S_IMODE(info.st_mode) != 0o755:
                    raise AdmissionError('GUI runtime directory is not traversable by the Desktop account; run install.sh --install-desktop-toolchain to repair it')
                continue
            name = str(child.relative_to(root))
            item = expected.get(name)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not item or info.st_size != item['bytes']
                    or stat.S_IMODE(info.st_mode) != item['mode'] or sha(child) != item['sha256']):
                raise AdmissionError('GUI runtime content differs from the toolchain manifest: ' + name)
            found.add(name)
    if found != set(expected):
        raise AdmissionError('GUI runtime is incomplete')


def secure_parents(prefix, repair_access):
    parent = prefixed(RUNTIME_PARENT, prefix)
    electron = parent / 'electron'
    electron.mkdir(mode=0o755, parents=True, exist_ok=True)
    for candidate in (electron, parent):
        info = candidate.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or candidate.is_symlink() or (info.st_mode & 0o022):
            raise AdmissionError('GUI runtime parent directory is unsafe')
    # mkdir's mode is masked by the installer's umask (often 077). Only these two
    # product-owned directories are repaired, never /usr or /usr/lib.
    if repair_access:
        for owned in (parent, electron):
            owned.chmod(0o755)
    return electron


def repair_runtime_directory_access(root, expected):
    # Verify bytes and ownership before repairing traversal. No file mode, ACL,
    # mount, AppArmor rule or outside ancestor is relaxed.
    verify_tree(root, expected)
    for directory, _, _ in os.walk(root, followlinks=False):
        Path(directory).chmod(0o755)
    verify_tree(root, expected, require_traversal=True)


def read_image_manifest(image):
    return runtime_manifest(docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                                   '--entrypoint', 'cat', image, IMAGE_MANIFEST, timeout=60))


def runtime_root_for(manifest, prefix=''):
    return prefixed(RUNTIME_PARENT, prefix) / 'electron' / f'{ELECTRON_VERSION}-{manifest_digest(manifest)[:12]}'


def install_host(image, prefix='', keep=None, profile_source=None, proc_root=''):
    if os.geteuid() != 0:
        raise AdmissionError('Desktop GUI runtime installation requires root')
    expected = read_image_manifest(image)
    electron_parent = secure_parents(prefix, repair_access=False)
    destination = runtime_root_for(expected, prefix)
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_dir():
            raise AdmissionError('Existing GUI runtime is not a managed directory')
        verify_tree(destination, expected)
    else:
        temporary = Path(tempfile.mkdtemp(prefix='.desktop-runtime-', dir=electron_parent))
        container = 'bridgesllm-desktop-extract-' + uuid.uuid4().hex
        created = False
        try:
            docker('create', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL', image)
            created = True
            docker('cp', container + ':' + IMAGE_RUNTIME, str(temporary), timeout=300)
            tree = temporary / 'electron'
            # docker cp keeps image ownership; the host runtime is root-owned.
            for directory, dirs, files in os.walk(tree, followlinks=False):
                for member in [Path(directory), *(Path(directory) / name for name in dirs + files)]:
                    if member.is_symlink():
                        raise AdmissionError('GUI runtime cannot contain links')
                    os.chown(member, 0, 0)
            verify_tree(tree, expected)
            os.rename(tree, destination)
        finally:
            if created:
                docker('rm', container)
            shutil.rmtree(temporary, ignore_errors=True)
    repair_runtime_directory_access(destination, expected)
    secure_parents(prefix, repair_access=True)
    # Keep the runtime a running app may still use until its next restart.
    kept = {destination.name}
    if keep and re.fullmatch(r'/usr/lib/bridgesllm-desktop/electron/44\.9\.0-[a-f0-9]{12}', keep):
        kept.add(Path(keep).name)
    for candidate in electron_parent.iterdir():
        if candidate.name not in kept and re.fullmatch(r'44\.9\.0-[a-f0-9]{12}', candidate.name) and not candidate.is_symlink():
            shutil.rmtree(candidate)
    profile_loaded = False
    if needs_profile(proc_root):
        profile_loaded = install_profile(profile_source, prefix)
    print(json.dumps({'runtime': str(destination)[len(prefix):] if prefix else str(destination),
                      'filesVerified': len(expected), 'apparmorProfile': profile_loaded}))


def install_profile(profile_source, prefix=''):
    profile = prefixed(PROFILE, prefix)
    content = Path(profile_source).read_bytes()
    if not profile.exists() or profile.is_symlink() or profile.read_bytes() != content:
        profile.parent.mkdir(parents=True, exist_ok=True)
        temporary = profile.with_name('.' + profile.name + '.' + uuid.uuid4().hex)
        with temporary.open('xb') as stream:
            stream.write(content)
        temporary.chmod(0o644)
        os.replace(temporary, profile)
    if prefix:
        return True
    result = subprocess.run(['apparmor_parser', '-r', str(profile)], capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        raise AdmissionError('Desktop runtime AppArmor profile did not load; global sandbox restrictions were not changed')
    return True


def verify_host(image, root, prefix=''):
    expected = read_image_manifest(image)
    destination = runtime_root_for(expected, prefix)
    if (prefixed(Path(root), prefix) != destination):
        raise AdmissionError('Recorded GUI runtime does not belong to the recorded toolchain image')
    for parent in (prefixed(RUNTIME_PARENT, prefix), prefixed(RUNTIME_PARENT, prefix) / 'electron'):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or parent.is_symlink() or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise AdmissionError('GUI runtime parent is not accessible to the Desktop account; run install.sh --install-desktop-toolchain to repair it')
    verify_tree(destination, expected, require_traversal=True)


def uninstall_host(prefix=''):
    removed = []
    parent = prefixed(RUNTIME_PARENT, prefix)
    if parent.is_symlink():
        raise AdmissionError('Desktop runtime parent is a link; refusing to follow it')
    if parent.exists():
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise AdmissionError('Desktop runtime parent is not a root-owned directory')
        shutil.rmtree(parent)
        removed.append(str(RUNTIME_PARENT))
    profile = prefixed(PROFILE, prefix)
    if profile.exists() or profile.is_symlink():
        if not prefix and shutil.which('apparmor_parser') and profile.is_file():
            subprocess.run(['apparmor_parser', '-R', str(profile)], capture_output=True, text=True, timeout=30, check=False)
        profile.unlink()
        removed.append(str(PROFILE))
    print(json.dumps({'removed': removed}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capability', 'fingerprint', 'stage-context', 'attest', 'install-host', 'verify-host', 'uninstall-host'])
    parser.add_argument('--source', type=Path)
    parser.add_argument('--context', type=Path)
    parser.add_argument('--image')
    parser.add_argument('--base-image')
    parser.add_argument('--recipe-sha256')
    parser.add_argument('--root')
    parser.add_argument('--keep')
    parser.add_argument('--docker-root', default='/var/lib/docker')
    parser.add_argument('--no-probe', action='store_true')
    # Test-only: relocate every managed host path below a private prefix.
    parser.add_argument('--test-prefix', default='')
    args = parser.parse_args()
    prefix = args.test_prefix
    if prefix and not (Path(prefix).is_absolute() and Path(prefix).is_dir()):
        print('Desktop runtime admission: test prefix must be an existing absolute directory', file=sys.stderr)
        return 2
    try:
        if args.action == 'capability':
            code, message = capability(args.docker_root)
            print(code + '\t' + message)
        elif args.action == 'fingerprint':
            print(fingerprint(args.source))
        elif args.action == 'stage-context':
            print(stage_context(args.source, args.context))
        elif args.action == 'attest':
            print(attest(args.image, args.base_image, args.recipe_sha256, probe=not args.no_probe))
        elif args.action == 'install-host':
            install_host(args.image, prefix, args.keep, profile_source=(args.source or Path(__file__).parent) / 'bridgesllm-desktop-electron.apparmor')
        elif args.action == 'verify-host':
            verify_host(args.image, args.root, prefix)
            print('Desktop GUI runtime verified')
        else:
            uninstall_host(prefix)
    except (AdmissionError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print('Desktop runtime admission: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
