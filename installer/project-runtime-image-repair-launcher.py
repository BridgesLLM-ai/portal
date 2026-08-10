#!/usr/bin/python3

import fcntl
import os
import re
import stat
import subprocess
import sys


INSTALLER_PATH = "/opt/bridgesllm/portal/installer/install.sh"
INSTALLER_SIGNATURE_PATH = f"{INSTALLER_PATH}.sig"
LOG_DIRECTORY_PATH = "/opt/bridgesllm/logs"
LOG_NAME_PATTERN = re.compile(
    r"project-runtime-image-repair-[A-Za-z0-9_.:-]+\.log"
)
VERSION_PATTERN = re.compile(rb'^readonly VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$', re.MULTILINE)
INSTALLER_SIZE_LIMIT = 2 * 1024 * 1024
RELEASE_PUBLIC_KEY = b"""-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF0Mqi+e9entO6AacPZbQ4lBQ+hModVr2tqb/P3tkQD4=
-----END PUBLIC KEY-----
"""
EXECUTION_ENVIRONMENT = {
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}


def identity(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_gid,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def open_root_directory(parts):
    directory_fd = os.open(
        "/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    )
    descriptors = [directory_fd]
    root_info = os.fstat(directory_fd)
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or root_info.st_uid != 0
        or root_info.st_gid != 0
        or root_info.st_mode & 0o022
    ):
        raise SystemExit(70)
    for part in parts:
        next_fd = os.open(
            part,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=directory_fd,
        )
        descriptors.append(next_fd)
        info = os.fstat(next_fd)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
        ):
            raise SystemExit(70)
        directory_fd = next_fd
    return directory_fd, descriptors


def open_attested_file(
    directory_fd, name, *, exact_size=None, maximum_size=None, exact_mode=None
):
    descriptor = os.open(
        name,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=directory_fd,
    )
    info = os.fstat(descriptor)
    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or (exact_size is not None and info.st_size != exact_size)
        or (maximum_size is not None and info.st_size > maximum_size)
        or (exact_mode is not None and stat.S_IMODE(info.st_mode) != exact_mode)
        or identity(current) != identity(info)
    ):
        os.close(descriptor)
        raise SystemExit(70)
    return descriptor, identity(info)


def reattest_file(directory_fd, name, descriptor, expected_identity):
    descriptor_info = os.fstat(descriptor)
    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (
        identity(descriptor_info) != expected_identity
        or identity(current) != expected_identity
    ):
        raise SystemExit(70)


def verify_installer_signature(installer_fd, signature_fd):
    key_fd = os.memfd_create(
        "bridgesllm-release-public-key",
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    try:
        view = memoryview(RELEASE_PUBLIC_KEY)
        while view:
            written = os.write(key_fd, view)
            if written <= 0:
                raise SystemExit(70)
            view = view[written:]
        os.lseek(key_fd, 0, os.SEEK_SET)
        fcntl.fcntl(
            key_fd,
            fcntl.F_ADD_SEALS,
            fcntl.F_SEAL_SEAL
            | fcntl.F_SEAL_SHRINK
            | fcntl.F_SEAL_GROW
            | fcntl.F_SEAL_WRITE,
        )
        os.lseek(installer_fd, 0, os.SEEK_SET)
        os.lseek(signature_fd, 0, os.SEEK_SET)
        result = subprocess.run(
            [
                "/usr/bin/openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                f"/proc/self/fd/{key_fd}",
                "-rawin",
                "-in",
                f"/proc/self/fd/{installer_fd}",
                "-sigfile",
                f"/proc/self/fd/{signature_fd}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(key_fd, installer_fd, signature_fd),
            close_fds=True,
            env={**EXECUTION_ENVIRONMENT, "OPENSSL_CONF": "/dev/null"},
            timeout=15,
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(70)
        os.lseek(installer_fd, 0, os.SEEK_SET)
    finally:
        os.close(key_fd)


def verify_installer_version(installer_fd, expected_version):
    os.lseek(installer_fd, 0, os.SEEK_SET)
    chunks = []
    total = 0
    while True:
        chunk = os.read(installer_fd, min(65536, INSTALLER_SIZE_LIMIT + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > INSTALLER_SIZE_LIMIT:
            raise SystemExit(70)
    matches = VERSION_PATTERN.findall(b"".join(chunks))
    if matches != [expected_version.encode("ascii")]:
        raise SystemExit(70)
    os.lseek(installer_fd, 0, os.SEEK_SET)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(64)
    os.umask(0o077)
    expected_version, log_path = sys.argv[1:]
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", expected_version) is None:
        raise SystemExit(64)
    log_name = os.path.basename(log_path)
    if (
        os.path.dirname(log_path) != LOG_DIRECTORY_PATH
        or os.path.normpath(log_path) != log_path
        or LOG_NAME_PATTERN.fullmatch(log_name) is None
    ):
        raise SystemExit(64)

    opened = []
    try:
        log_directory_fd, log_descriptors = open_root_directory(
            [part for part in LOG_DIRECTORY_PATH.split("/") if part]
        )
        opened.extend(log_descriptors)
        log_fd = os.open(
            log_name,
            os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=log_directory_fd,
        )
        opened.append(log_fd)
        log_info = os.fstat(log_fd)
        current_log_info = os.stat(
            log_name, dir_fd=log_directory_fd, follow_symlinks=False
        )
        if (
            not stat.S_ISREG(log_info.st_mode)
            or log_info.st_uid != 0
            or log_info.st_gid != 0
            or log_info.st_nlink != 1
            or stat.S_IMODE(log_info.st_mode) != 0o600
            or identity(current_log_info) != identity(log_info)
        ):
            raise SystemExit(70)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)

        installer_parts = [
            part for part in INSTALLER_PATH.split("/") if part
        ]
        installer_directory_fd, installer_descriptors = open_root_directory(
            installer_parts[:-1]
        )
        opened.extend(installer_descriptors)
        installer_fd, installer_identity = open_attested_file(
            installer_directory_fd,
            installer_parts[-1],
            maximum_size=INSTALLER_SIZE_LIMIT,
        )
        opened.append(installer_fd)
        signature_name = os.path.basename(INSTALLER_SIGNATURE_PATH)
        signature_fd, signature_identity = open_attested_file(
            installer_directory_fd,
            signature_name,
            exact_size=64,
        )
        opened.append(signature_fd)
        verify_installer_signature(installer_fd, signature_fd)
        verify_installer_version(installer_fd, expected_version)
        reattest_file(
            log_directory_fd,
            log_name,
            log_fd,
            identity(log_info),
        )
        reattest_file(
            installer_directory_fd,
            installer_parts[-1],
            installer_fd,
            installer_identity,
        )
        reattest_file(
            installer_directory_fd,
            signature_name,
            signature_fd,
            signature_identity,
        )
        os.set_inheritable(installer_fd, True)
        os.execve(
            "/bin/bash",
            [
                "/bin/bash",
                f"/proc/self/fd/{installer_fd}",
                "--repair-project-runtime-image",
            ],
            EXECUTION_ENVIRONMENT,
        )
    finally:
        for descriptor in reversed(opened):
            try:
                os.close(descriptor)
            except OSError:
                pass


if __name__ == "__main__":
    main()
