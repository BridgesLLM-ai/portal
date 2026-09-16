#!/usr/bin/env python3
"""Add one missing CLI. Never replace a configured runtime or touch credentials.

Called by a retained Portal job. The shared installer lock excludes updates and
recovery. Native npm tools use the signed bundle's existing archive/tree verifier;
other harnesses use their pinned installers. A retry can finish publishing links
for an exact package left by interruption, without uninstalling anything.
"""
from __future__ import annotations
import argparse
import contextlib
import ctypes
import errno
import fcntl
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

PORTAL = Path('/opt/bridgesllm/portal')
LOCKS = ('/run/lock/bridgesllm-portal-installer.lock', '/run/bridgesllm-agent-mutation.lock')
FENCES = (
    '/var/lib/bridgesllm-installer/active-update.json',
    '/var/lib/bridgesllm-installer/cutover-update.json',
    '/var/lib/bridgesllm-installer/uninstall/active-uninstall.json',
    '/var/lib/bridgesllm/backup-recovery/quiescence.json',
    '/var/lib/bridgesllm-restore/active-restore.json',
    '/var/lib/bridgesllm-installer/openclaw-2026.9.1-migration-v2',
    '/var/lib/bridgesllm-installer/native-cli-bundle-v1',
    '/var/lib/bridgesllm-installer/openclaw-native-chat-v1',
    '/var/lib/bridgesllm-installer/openclaw-mutation-maintenance-v1.json',
    '/var/lib/bridgesllm-installer/host-mutations/active-host-mutation.json',
    '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
)
NATIVE = {'claude-code': '2.1.263', 'codex': '0.153.4'}
SCRIPTS = {
    'gemini': ('antigravity-runtime.sh', '/usr/local/bin/agy'),
    'antigravity': ('antigravity-runtime.sh', '/usr/local/bin/agy'),
    'grok-build': ('grok-build-runtime.sh', '/usr/local/bin/grok'),
    'hermes': ('hermes-runtime.sh', '/usr/local/bin/hermes'),
    'opencode': ('opencode-runtime.sh', '/usr/local/bin/opencode'),
}

class InstallError(RuntimeError):
    pass


def exists(path: Path) -> bool:
    return os.path.lexists(path)


def safe_parents(path: Path) -> None:
    for parent in reversed(path.absolute().parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or (info.st_mode & 0o022 and not (parent == Path('/run/lock') and info.st_mode & stat.S_ISVTX)):
            raise InstallError('Installation directory is not secure. Ask the server owner to repair its permissions.')


def secure_file(path: Path) -> None:
    safe_parents(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise InstallError('The installed Portal helper needs repair. Reapply the signed Portal update.')


@contextlib.contextmanager
def operation_lock(paths=LOCKS):
    descriptors = []
    try:
        for raw in paths:
            path = Path(raw)
            safe_parents(path)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            descriptors.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size:
                raise InstallError('The installation lock needs repair. No tools were changed.')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise InstallError('Another installation, backup or update is running. Wait for it to finish, then try again.') from None
        yield tuple(descriptors)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def refuse_maintenance(fences=FENCES) -> None:
    if any(exists(Path(p)) for p in fences):
        raise InstallError('An update or recovery is unfinished. Finish it in Maintenance, then retry this installation.')


def load_bundle(portal: Path):
    helper = portal / 'installer/native-cli-bundle-transaction.py'
    secure_file(helper)
    # Test-only switches in the reusable helper must not be inherited by a job.
    os.environ.pop('BRIDGESLLM_INSTALLER_SOURCE_ONLY', None)
    os.environ.pop('PORTAL_NATIVE_CLI_BUNDLE_FAULT', None)
    spec = importlib.util.spec_from_file_location('portal_bundle_install', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rename_new(source: Path, target: Path) -> None:
    # Atomic no-replace publication, including nonempty directories. An external
    # writer winning the destination does not get overwritten or removed.
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise InstallError('The tool changed during installation. Refresh its status before retrying.')
        raise OSError(code, os.strerror(code))


def refuse_shadowed(bin_name: str, expected: set[Path]) -> None:
    for directory in ('/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/root/.local/bin', '/root/.npm-global/bin'):
        candidate = Path(directory) / bin_name
        # /bin and /sbin may be the distribution's normal usr-merge aliases.
        canonical_parent = candidate.parent.resolve()
        candidate = canonical_parent / candidate.name
        if candidate not in expected and exists(candidate):
            raise InstallError('This CLI is already installed at a different location. Use its existing sign-in or ask the owner to repair that installation.')


def install_native(tool_id: str, portal: Path = PORTAL) -> None:
    bundle = load_bundle(portal)
    catalog = bundle.load_catalog(portal / 'backend/dist/config/nativeHostCliAdmissionCatalog.v1.json')
    tool = catalog['tools'][tool_id]
    version = NATIVE[tool_id]
    platform_name = bundle.platform_key()
    platform = tool['versions'][version]['platforms'].get(platform_name)
    if platform is None:
        raise InstallError('This CLI is not available for this server architecture.')
    target = Path(tool['packageRoot'])
    links = {Path(name): value for name, value in tool['executables'].items()}
    refuse_shadowed(tool['binName'], set(links))
    for link, destination in links.items():
        safe_parents(link)
        if exists(link) and (not link.is_symlink() or os.readlink(link) != destination):
            raise InstallError('This CLI already has an installation. No existing tool was replaced; refresh its status.')
    # Parent scopes can be absent on a fresh install. Only create fixed catalog
    # paths, and validate each existing ancestor before creating a child.
    for parent in reversed(target.parents):
        if not exists(parent):
            safe_parents(parent)
            parent.mkdir(mode=0o755)
        elif parent != Path('/'):
            safe_parents(parent / '_')
    if exists(target):
        # Supports an interrupted first install, but refuses arbitrary upgrades.
        bundle.verify_target_tree(target, tool, version, platform, catalog['limits'])
        print('Verified existing CLI files.', flush=True)
    else:
        print('Downloading and verifying CLI files…', flush=True)
        with tempfile.TemporaryDirectory(prefix=f'.portal-install-{tool_id}-', dir=target.parent) as temporary:
            prep = Path(temporary)
            bundle.build_target(prep, tool_id, tool, version, platform_name, catalog, None)
            refuse_maintenance()
            staged = prep / 'staged/packages' / tool_id
            rename_new(staged, target)
            bundle.fsync_directory(target.parent)
    bundle.verify_target_tree(target, tool, version, platform, catalog['limits'])
    for link, destination in links.items():
        if not exists(link):
            # symlink() refuses a concurrent destination; never replace it.
            os.symlink(destination, link)
            bundle.fsync_directory(link.parent)
        elif not link.is_symlink() or os.readlink(link) != destination:
            raise InstallError('The CLI link changed. Refresh its status before retrying.')
    print(f'Installed {tool_id} {version}. Continue to sign in.', flush=True)


def install_script(tool_id: str, portal: Path = PORTAL, lock_fds: tuple[int, ...] = ()) -> None:
    script, raw_target = SCRIPTS[tool_id]
    target = Path(raw_target)
    safe_parents(target)
    refuse_shadowed(target.name, {target})
    if exists(target):
        raise InstallError('This CLI is already installed. Refresh its status and continue to sign in. No files were replaced.')
    existing_root = {'hermes': '/opt/bridgesllm/tools/hermes/0.21.1',
                     'opencode': '/opt/bridgesllm/tools/opencode/1.18.29'}.get(tool_id)
    if existing_root and exists(Path(existing_root)):
        raise InstallError('This CLI has an incomplete existing installation. Use Maintenance to repair it; no existing files were replaced.')
    helper = portal / 'installer' / script
    secure_file(helper)
    print('Downloading and installing CLI files…', flush=True)
    # Fixed installer arguments, no caller-controlled shell or inherited CLI
    # credentials/settings. Vendor scripts already pin and verify their bytes.
    with tempfile.TemporaryDirectory(prefix='portal-cli-install-home-') as home:
        result = subprocess.run(['/bin/bash', str(helper), 'converge'],
            stdin=subprocess.DEVNULL, timeout=25 * 60, check=False, pass_fds=lock_fds,
            env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                 'HOME': home, 'LANG': 'C.UTF-8', 'NO_COLOR': '1', 'DO_NOT_TRACK': '1'},
            cwd=portal)
    if result.returncode:
        raise InstallError('CLI installation did not finish. See the download or verification error above, then retry.')
    if not target.is_file() or not os.access(target, os.X_OK):
        raise InstallError('The installer finished without a usable CLI. Retry installation or contact support.')
    print(f'Installed {tool_id}. Continue to sign in.', flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tool', choices=sorted(set(NATIVE) | set(SCRIPTS)))
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.platform != 'linux':
        print('Automatic CLI installation needs the Linux server administrator.', file=sys.stderr)
        return 1
    try:
        with operation_lock() as lock_fds:
            refuse_maintenance()
            if args.tool in NATIVE:
                install_native(args.tool)
            else:
                install_script(args.tool, lock_fds=lock_fds)
        return 0
    except (InstallError, OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
