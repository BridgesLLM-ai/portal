#!/usr/bin/env python3
"""Package the Portal-owned OpenClaw plugins for a release (updater v2 C9, PF-13).

For each plugin source below, writes ``<out>/<id>-<version>.tgz`` in npm-pack
layout (members under ``package/``, the root OpenClaw's archive installer
resolves first) and ``<out>/manifest.json`` in the
``bridgesllm.portal-plugins.v1`` format toolctl's PF-13 reads. The manifest is
checked with the validator of the toolctl that ships in the same source root.

Deterministic: members sorted, fixed mtime, numeric owner 0, fixed modes, gzip
header without a file name or timestamp, and no host path in any member.
Python 3 standard library only; run with ``python3 -I``.

Each plugin's supported OpenClaw range is its package.json
``openclaw.install.minHostVersion`` (OpenClaw's own field), else ``>=<floor>``
from the tool policy.

Usage: build-portal-plugins.py --source-root <portal tree> --out <new dir> [--mtime <epoch>]
"""

import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tarfile

SCHEMA = "bridgesllm.portal-plugins.v1"
PLUGIN_SOURCES = (
    "installer/openclaw-ask-user-plugin",
    "installer/openclaw-shared-browser-plugin",
)
OPTIONAL_FILES = ("README.md", "LICENSE")
MAX_FILE_BYTES = 8 * 1024 * 1024


class PackagingError(Exception):
    pass


def _read_regular(path):
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise PackagingError("%s is not a regular single-link file" % path)
        if info.st_size > MAX_FILE_BYTES:
            raise PackagingError("%s is larger than %d bytes" % (path, MAX_FILE_BYTES))
        with open(path, "rb") as handle:
            return handle.read()
    except OSError as error:
        raise PackagingError("%s can't be read: %s" % (path, error.strerror or error))


def _read_json(path):
    try:
        return json.loads(_read_regular(path).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise PackagingError("%s is not valid JSON: %s" % (path, error))


def _member_name(source_dir, value, label):
    """A package-relative file named by package.json, kept inside the plugin directory."""
    if not isinstance(value, str) or not value.strip():
        raise PackagingError("%s: %s must be a relative file path" % (source_dir, label))
    name = os.path.normpath(value.strip())
    if os.path.isabs(name) or name == "." or name.split(os.sep)[0] == "..":
        raise PackagingError("%s: %s escapes the plugin directory: %r" % (source_dir, label, value))
    current = source_dir
    for part in name.split(os.sep)[:-1]:
        current = os.path.join(current, part)
        if os.path.islink(current) or not os.path.isdir(current):
            raise PackagingError("%s: %s passes through a non-directory" % (source_dir, label))
    return name.replace(os.sep, "/")


def load_toolctl(source_root):
    path = os.path.join(source_root, "installer", "tools", "bridgesllm-toolctl.py")
    spec = importlib.util.spec_from_file_location("bridgesllm_toolctl_for_packaging", path)
    if spec is None or not os.path.isfile(path):
        raise PackagingError("toolctl is missing from %s" % source_root)
    module = importlib.util.module_from_spec(spec)
    # No __pycache__ in the tree being packaged: build-release.sh runs this inside each release stage, and the
    # bytecode embeds that stage's absolute path, so two otherwise identical stages would differ (and ship a .pyc).
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def openclaw_floor(source_root):
    policy = _read_json(os.path.join(source_root, "installer", "tools", "tool-policy.v2.json"))
    tools = policy.get("tools") if isinstance(policy, dict) else None
    for tool in tools if isinstance(tools, list) else []:
        if isinstance(tool, dict) and tool.get("id") == "openclaw" and isinstance(tool.get("floor"), str):
            return tool["floor"]
    raise PackagingError("the tool policy has no OpenClaw floor")


def plugin_spec(source_root, relative, floor, toolctl):
    """(id, version, openclaw range, [member names]) of one plugin source directory."""
    source_dir = os.path.join(source_root, relative)
    if os.path.islink(source_dir) or not os.path.isdir(source_dir):
        raise PackagingError("plugin source %s is missing" % relative)
    package = _read_json(os.path.join(source_dir, "package.json"))
    manifest = _read_json(os.path.join(source_dir, "openclaw.plugin.json"))
    if not isinstance(package, dict) or not isinstance(manifest, dict):
        raise PackagingError("%s: package.json and openclaw.plugin.json must be objects" % relative)
    plugin_id, version = manifest.get("id"), package.get("version")
    if plugin_id != package.get("name"):
        raise PackagingError("%s: openclaw.plugin.json id %r differs from the package name %r"
                             % (relative, plugin_id, package.get("name")))
    if not isinstance(plugin_id, str) or not toolctl.PLUGIN_ID_RE.fullmatch(plugin_id):
        raise PackagingError("%s: plugin id %r is not valid" % (relative, plugin_id))
    if not isinstance(version, str) or not toolctl.VERSION_RE.fullmatch(version):
        raise PackagingError("%s: version %r is not an exact version" % (relative, version))
    openclaw = package.get("openclaw") if isinstance(package.get("openclaw"), dict) else {}
    install = openclaw.get("install") if isinstance(openclaw.get("install"), dict) else {}
    declared = install.get("minHostVersion")
    supported = declared.strip() if isinstance(declared, str) and declared.strip() else ">=%s" % floor
    try:
        toolctl.parse_range(supported)
    except ValueError:
        raise PackagingError("%s: OpenClaw range %r can't be read" % (relative, supported))
    names = {"package.json", "openclaw.plugin.json"}
    entries = [package.get("main")] if package.get("main") is not None else []
    extensions = openclaw.get("extensions")
    if extensions is not None and not isinstance(extensions, list):
        raise PackagingError("%s: openclaw.extensions must be a list" % relative)
    entries.extend(extensions or [])
    if not entries:
        raise PackagingError("%s: package.json names no entry point" % relative)
    for index, entry in enumerate(entries):
        names.add(_member_name(source_dir, entry, "entry point %d" % index))
    for optional in OPTIONAL_FILES:
        if os.path.lexists(os.path.join(source_dir, optional)):
            names.add(optional)
    return plugin_id, version, supported, sorted(names)


def archive_bytes(source_dir, names, mtime):
    """npm-pack layout tar.gz; nothing about the build host is recorded."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in names:
            data = _read_regular(os.path.join(source_dir, *name.split("/")))
            info = tarfile.TarInfo("package/" + name)
            info.size = len(data)
            info.mtime = mtime
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.type = tarfile.REGTYPE
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), compresslevel=9, mtime=0)


def render(source_root, mtime=0):
    """(manifest, {file name: bytes}) for the release's installer/plugins directory."""
    source_root = os.path.abspath(source_root)
    toolctl = load_toolctl(source_root)
    floor = openclaw_floor(source_root)
    specs = sorted((plugin_spec(source_root, relative, floor, toolctl) + (relative,) for relative in PLUGIN_SOURCES),
                   key=lambda spec: spec[0])
    outputs, plugins = {}, []
    for plugin_id, version, supported, names, relative in specs:
        archive = "%s-%s.tgz" % (plugin_id, version)
        if archive in outputs:
            raise PackagingError("plugin %s is listed twice" % plugin_id)
        data = archive_bytes(os.path.join(source_root, relative), names, mtime)
        outputs[archive] = data
        plugins.append({"id": plugin_id, "version": version, "archive": archive,
                        "sha256": hashlib.sha256(data).hexdigest(), "openclaw": supported})
    manifest = {"schema": SCHEMA, "plugins": plugins}
    errors = toolctl.validate_plugin_manifest(manifest)
    if errors:
        raise PackagingError("the plugin manifest is invalid: %s" % "; ".join(errors))
    outputs["manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return manifest, outputs


def write_outputs(out_dir, outputs):
    """Create ``out_dir`` (absent or empty) and write every output file, mode 0644."""
    try:
        os.mkdir(out_dir, 0o755)
    except FileExistsError:
        if os.path.islink(out_dir) or not os.path.isdir(out_dir) or os.listdir(out_dir):
            raise PackagingError("%s must be absent or an empty directory" % out_dir)
    os.chmod(out_dir, 0o755)
    for name in sorted(outputs):
        path = os.path.join(out_dir, name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
        try:
            view = memoryview(outputs[name])
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(path, 0o644)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--mtime", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        if args.mtime < 0:
            raise PackagingError("--mtime must not be negative")
        manifest, outputs = render(args.source_root, args.mtime)
        write_outputs(os.path.abspath(args.out), outputs)
    except (PackagingError, OSError) as error:
        sys.stderr.write("build-portal-plugins: %s\n" % error)
        return 1
    for plugin in manifest["plugins"]:
        sys.stdout.write("%s %s %s %s\n" % (plugin["archive"], plugin["sha256"], plugin["id"], plugin["openclaw"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
