import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { getOpenClawApiUrl } from '../config/openclaw';

const execFileAsync = promisify(execFile);
const OPENCLAW_GATEWAY_UNIT = 'openclaw-gateway.service';
const OPENCLAW_GATEWAY_UNIT_PATH =
  '/etc/systemd/system/openclaw-gateway.service';
const OPENCLAW_GATEWAY_DROP_IN =
  '/etc/systemd/system/openclaw-gateway.service.d/20-bridgesllm-authorization-fence.conf';
const OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH =
  '/root/.config/systemd/user/openclaw-gateway.service';
const OPENCLAW_GATEWAY_ROOT_USER_DROP_IN =
  '/root/.config/systemd/user/openclaw-gateway.service.d/20-bridgesllm-authorization-fence.conf';
const OPENCLAW_GATEWAY_FENCE_MARKER =
  '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1';
const OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT =
  '{"schema":"bridgesllm.openclaw-gateway-authorization-fence.v1","unit":"openclaw-gateway.service"}\n';
const OPENCLAW_GATEWAY_DROP_IN_CONTENT =
  `[Unit]\nConditionPathExists=!${OPENCLAW_GATEWAY_FENCE_MARKER}\n`
  + '[Service]\nKillMode=control-group\n';
const OPENCLAW_GATEWAY_ROOT_USER_DROP_IN_CONTENT =
  `[Unit]\nConditionPathExists=!${OPENCLAW_GATEWAY_FENCE_MARKER}\n`
  + '[Service]\nKillMode=control-group\nExecCondition=/usr/bin/false\n';
const OPENCLAW_GATEWAY_CONTROL_GROUP =
  `/system.slice/${OPENCLAW_GATEWAY_UNIT}`;
const OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP =
  `/user.slice/user-0.slice/user@0.service/app.slice/${OPENCLAW_GATEWAY_UNIT}`;
const ROOT_USER_MANAGER_UNIT = 'user@0.service';
const ROOT_USER_MANAGER_CONTROL_GROUP =
  '/user.slice/user-0.slice/user@0.service';
const ROOT_USER_RUNTIME_DIRECTORY = '/run/user/0';
const ROOT_USER_BUS_PATH = `${ROOT_USER_RUNTIME_DIRECTORY}/bus`;
const DEFAULT_OPENCLAW_GATEWAY_PORT = 18_789;
const SYSTEMCTL = '/usr/bin/systemctl';
const SS = '/usr/bin/ss';
const SYSTEMD_CGROUP_ROOT = '/sys/fs/cgroup';
const SYSTEMD_OPERATION_TIMEOUT_MS = 45_000;
const SYSTEMD_SETTLE_TIMEOUT_MS = 30_000;
const SYSTEMD_SETTLE_POLL_MS = 100;

export interface OpenClawGatewayUnitSnapshot {
  installed: boolean;
  masked: boolean;
  active: boolean;
  activeState: string;
  subState: string;
  killMode: string;
  mainPid: number;
  controlGroup: string | null;
  fragmentPath: string | null;
  dropInPaths: readonly string[];
  needDaemonReload: boolean;
}

export interface OpenClawRootUserManagerSnapshot {
  available: boolean;
  active: boolean;
  activeState: string;
  subState: string;
  mainPid: number;
  controlGroup: string | null;
}

export interface OpenClawGatewayFenceMarkerIdentity {
  path: typeof OPENCLAW_GATEWAY_FENCE_MARKER;
  device: string;
  inode: string;
}

export interface OpenClawGatewayStopProof {
  unit: typeof OPENCLAW_GATEWAY_UNIT;
  stopped: true;
  priorActive: boolean;
  priorMainPid: number;
  priorControlGroup: string | null;
  observedActiveState: string;
  observedMainPid: 0;
  cgroupEmpty: true;
  listenerPort: number;
  listenersAbsent: true;
  markerPath: typeof OPENCLAW_GATEWAY_FENCE_MARKER;
  markerDevice: string;
  markerInode: string;
  dropInPath: typeof OPENCLAW_GATEWAY_DROP_IN;
  rootUserDropInPath: typeof OPENCLAW_GATEWAY_ROOT_USER_DROP_IN;
  rootUserManagerActive: boolean;
  rootUserUnitInstalled: boolean;
  rootUserUnitMasked: boolean;
  rootUserUnitPriorActive: boolean;
  rootUserUnitObservedActiveState: string;
  rootUserUnitObservedMainPid: 0;
  rootUserCgroupEmpty: true;
}

export interface OpenClawGatewayAuthorizationFenceDependencies {
  getGatewayApiUrl(): string;
  systemctl(args: readonly string[]): Promise<string>;
  rootUserSystemctl(args: readonly string[]): Promise<string>;
  inspectRootUserManager(): Promise<OpenClawRootUserManagerSnapshot>;
  ensureMarker(): OpenClawGatewayFenceMarkerIdentity;
  inspectMarker(): OpenClawGatewayFenceMarkerIdentity | null;
  removeMarker(): void;
  attestDropIn(): void;
  attestRootUserDropIn(): void;
  attestRootUserMask(): void;
  listListeningPids(port: number): Promise<readonly number[]>;
  readProcessControlGroup(pid: number): string | null;
  readCgroupEvents(controlGroup: string): string | null;
  wait(ms: number): Promise<void>;
  now(): number;
}

interface OpenClawGatewayEndpoint {
  apiUrl: string;
  port: number;
}

function parseConfiguredGatewayEndpoint(rawValue: string): OpenClawGatewayEndpoint {
  const raw = String(rawValue || '');
  if (!raw || raw !== raw.trim()) {
    throw new Error('OpenClaw gateway URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('OpenClaw gateway URL is invalid');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('OpenClaw gateway URL is not an unambiguous HTTP endpoint');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== 'localhost'
    && hostname !== '127.0.0.1'
    && hostname !== '[::1]'
  ) {
    throw new Error('OpenClaw gateway URL is not loopback-only');
  }
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OpenClaw gateway port is invalid');
  }
  return Object.freeze({
    apiUrl: parsed.href,
    port,
  });
}

interface SystemdUnitIdentity {
  unitPath: string;
  dropInPath: string;
  controlGroup: string;
  label: string;
  allowExactMask?: boolean;
}

const SYSTEM_GATEWAY_IDENTITY: SystemdUnitIdentity = Object.freeze({
  unitPath: OPENCLAW_GATEWAY_UNIT_PATH,
  dropInPath: OPENCLAW_GATEWAY_DROP_IN,
  controlGroup: OPENCLAW_GATEWAY_CONTROL_GROUP,
  label: 'system',
});

const ROOT_USER_GATEWAY_IDENTITY: SystemdUnitIdentity = Object.freeze({
  unitPath: OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH,
  dropInPath: OPENCLAW_GATEWAY_ROOT_USER_DROP_IN,
  controlGroup: OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP,
  label: 'root user',
  allowExactMask: true,
});

function parseSystemctlShow(
  output: string,
  identity: SystemdUnitIdentity = SYSTEM_GATEWAY_IDENTITY,
): OpenClawGatewayUnitSnapshot {
  const fields = new Map(
    String(output || '')
      .split(/\r?\n/)
      .map((line) => {
        const delimiter = line.indexOf('=');
        return delimiter > 0 ? [line.slice(0, delimiter), line.slice(delimiter + 1)] : null;
      })
      .filter((entry): entry is [string, string] => Array.isArray(entry)),
  );
  const loadState = String(fields.get('LoadState') || '').trim();
  const activeState = String(fields.get('ActiveState') || '').trim();
  const subState = String(fields.get('SubState') || '').trim();
  const killMode = String(fields.get('KillMode') || '').trim();
  const mainPid = Number.parseInt(String(fields.get('MainPID') || '0'), 10);
  const rawControlGroup = String(fields.get('ControlGroup') || '').trim();
  const rawFragmentPath = String(fields.get('FragmentPath') || '').trim();
  const rawNeedDaemonReload = String(fields.get('NeedDaemonReload') || '').trim();
  const dropInPaths = Object.freeze(
    String(fields.get('DropInPaths') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  if (
    !loadState
    || !activeState
    || !subState
    || (rawNeedDaemonReload !== 'yes' && rawNeedDaemonReload !== 'no')
    || !Number.isSafeInteger(mainPid)
    || mainPid < 0
  ) {
    throw new Error(`OpenClaw gateway ${identity.label} systemd identity could not be attested`);
  }
  const masked = loadState === 'masked';
  const installed = loadState !== 'not-found';
  if (
    installed
    && loadState !== 'loaded'
    && !(masked && identity.allowExactMask)
  ) {
    throw new Error('OpenClaw gateway systemd unit is not in a loaded state');
  }
  if (installed && !masked && killMode !== 'control-group') {
    throw new Error('OpenClaw gateway systemd unit lacks control-group termination');
  }
  if (installed && rawFragmentPath !== identity.unitPath) {
    throw new Error(`OpenClaw gateway ${identity.label} systemd unit path is not installer-owned`);
  }
  if (
    !masked
    && (installed || dropInPaths.length > 0)
    && dropInPaths[dropInPaths.length - 1] !== identity.dropInPath
  ) {
    throw new Error(
      `OpenClaw gateway ${identity.label} systemd authorization fence is not the final effective drop-in`,
    );
  }
  if (!masked && rawNeedDaemonReload !== 'no') {
    throw new Error(`OpenClaw gateway ${identity.label} systemd manager has stale unit state`);
  }
  const controlGroup = rawControlGroup || null;
  if (controlGroup && controlGroup !== identity.controlGroup) {
    throw new Error(`OpenClaw gateway ${identity.label} systemd cgroup identity is invalid`);
  }
  if (
    installed
    && !masked
    && (
      (activeState === 'active' && (mainPid < 1 || !controlGroup))
      || (mainPid > 0 && !controlGroup)
    )
  ) {
    throw new Error('OpenClaw gateway systemd process identity is incomplete');
  }
  if (
    masked
    && (
      activeState !== 'inactive'
      || subState !== 'dead'
      || mainPid !== 0
      || controlGroup !== null
      || rawFragmentPath !== identity.unitPath
      || (
        dropInPaths.length !== 0
        && (
          dropInPaths.length !== 1
          || dropInPaths[0] !== identity.dropInPath
        )
      )
    )
  ) {
    throw new Error('OpenClaw gateway root user masked identity is inconsistent');
  }
  if (
    !installed
    && (
      activeState !== 'inactive'
      || subState !== 'dead'
      || mainPid !== 0
      || controlGroup !== null
      || rawFragmentPath !== ''
    )
  ) {
    throw new Error('OpenClaw gateway absent systemd identity is inconsistent');
  }
  return Object.freeze({
    installed,
    masked,
    active: activeState === 'active',
    activeState,
    subState,
    killMode,
    mainPid,
    controlGroup,
    fragmentPath: rawFragmentPath || null,
    dropInPaths,
    needDaemonReload: rawNeedDaemonReload === 'yes',
  });
}

function parseRootUserManagerShow(output: string): OpenClawRootUserManagerSnapshot {
  const fields = new Map(
    String(output || '')
      .split(/\r?\n/)
      .map((line) => {
        const delimiter = line.indexOf('=');
        return delimiter > 0 ? [line.slice(0, delimiter), line.slice(delimiter + 1)] : null;
      })
      .filter((entry): entry is [string, string] => Array.isArray(entry)),
  );
  const loadState = String(fields.get('LoadState') || '').trim();
  const activeState = String(fields.get('ActiveState') || '').trim();
  const subState = String(fields.get('SubState') || '').trim();
  const mainPid = Number.parseInt(String(fields.get('MainPID') || '0'), 10);
  const rawControlGroup = String(fields.get('ControlGroup') || '').trim();
  const controlGroup = rawControlGroup || null;
  if (
    (loadState !== 'loaded' && loadState !== 'not-found')
    || !activeState
    || !subState
    || !Number.isSafeInteger(mainPid)
    || mainPid < 0
  ) {
    throw new Error('OpenClaw root user systemd manager identity could not be attested');
  }
  const available = loadState === 'loaded';
  const active = activeState === 'active';
  if (
    active
      ? mainPid < 1 || controlGroup !== ROOT_USER_MANAGER_CONTROL_GROUP
      : (
        activeState !== 'inactive'
        || subState !== 'dead'
        || mainPid !== 0
        || controlGroup !== null
      )
  ) {
    throw new Error('OpenClaw root user systemd manager identity is inconsistent');
  }
  if (!available && active) {
    throw new Error('OpenClaw root user systemd manager absent identity is inconsistent');
  }
  return Object.freeze({
    available,
    active,
    activeState,
    subState,
    mainPid,
    controlGroup,
  });
}

function parseRootUserSystemctlShow(output: string): OpenClawGatewayUnitSnapshot {
  return parseSystemctlShow(output, ROOT_USER_GATEWAY_IDENTITY);
}

function cgroupIsEmpty(raw: string | null): boolean {
  if (raw === null) return true;
  const populated = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 2))
    .find(([key]) => key === 'populated')?.[1];
  return populated === '0';
}

function parseListeningPids(raw: string): readonly number[] {
  const pids = new Set<number>();
  for (const line of String(raw || '').split(/\r?\n/).filter((entry) => entry.trim())) {
    let found = false;
    for (const match of line.matchAll(/\bpid=(\d+)\b/g)) {
      const pid = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(pid) || pid < 1) {
        throw new Error('OpenClaw gateway listener process identity is invalid');
      }
      pids.add(pid);
      found = true;
    }
    if (!found) {
      throw new Error('OpenClaw gateway listener ownership could not be attested');
    }
  }
  return Object.freeze([...pids].sort((left, right) => left - right));
}

function assertSafeRootDirectory(directory: string): void {
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.uid !== 0
    || info.gid !== 0
    || (info.mode & 0o022) !== 0
  ) {
    throw new Error('OpenClaw gateway authorization fence directory is unsafe');
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectExactRootFile(input: {
  filePath: string;
  expectedContent: string;
  exactMode?: number;
  exactLinkCount?: number;
}): OpenClawGatewayFenceMarkerIdentity {
  const before = fs.lstatSync(input.filePath);
  const mode = before.mode & 0o777;
  const exactLinkCount = input.exactLinkCount ?? 1;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== 0
    || before.gid !== 0
    || before.nlink !== exactLinkCount
    || (
      input.exactMode === undefined
        ? (mode & 0o022) !== 0
        : mode !== input.exactMode
    )
    || before.size !== Buffer.byteLength(input.expectedContent)
  ) {
    throw new Error('OpenClaw gateway authorization fence file is unsafe');
  }
  const descriptor = fs.openSync(
    input.filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.nlink !== before.nlink
      || opened.size !== before.size
      || fs.readFileSync(descriptor, 'utf8') !== input.expectedContent
    ) {
      throw new Error('OpenClaw gateway authorization fence file changed during attestation');
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.nlink !== exactLinkCount
      || after.size !== opened.size
    ) {
      throw new Error('OpenClaw gateway authorization fence file raced attestation');
    }
    return Object.freeze({
      path: OPENCLAW_GATEWAY_FENCE_MARKER,
      device: String(after.dev),
      inode: String(after.ino),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

const OPENCLAW_GATEWAY_FENCE_TEMPORARY_PATTERN =
  /^\.openclaw-gateway-authorization-fence\.[1-9][0-9]*\.[a-f0-9]{32}$/;

function recoverInterruptedMarkerPublication(input: {
  markerPath: string;
  expectedContent: string;
}): OpenClawGatewayFenceMarkerIdentity | null {
  const directory = path.dirname(input.markerPath);
  assertSafeRootDirectory(directory);
  let markerDetails: fs.Stats;
  try {
    markerDetails = fs.lstatSync(input.markerPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (markerDetails.nlink === 1) {
    return inspectExactRootFile({
      filePath: input.markerPath,
      expectedContent: input.expectedContent,
      exactMode: 0o600,
    });
  }
  if (markerDetails.nlink !== 2) {
    throw new Error('OpenClaw gateway authorization fence marker link count is unsafe');
  }
  const interrupted = inspectExactRootFile({
    filePath: input.markerPath,
    expectedContent: input.expectedContent,
    exactMode: 0o600,
    exactLinkCount: 2,
  });
  const candidates = fs.readdirSync(directory)
    .filter((entry) => OPENCLAW_GATEWAY_FENCE_TEMPORARY_PATTERN.test(entry))
    .map((entry) => path.join(directory, entry))
    .filter((candidate) => {
      const details = fs.lstatSync(candidate);
      return details.dev === markerDetails.dev && details.ino === markerDetails.ino;
    });
  if (candidates.length !== 1) {
    throw new Error(
      'OpenClaw gateway authorization fence interrupted publication could not be recovered',
    );
  }
  const candidate = candidates[0];
  const candidateIdentity = inspectExactRootFile({
    filePath: candidate,
    expectedContent: input.expectedContent,
    exactMode: 0o600,
    exactLinkCount: 2,
  });
  if (
    candidateIdentity.device !== interrupted.device
    || candidateIdentity.inode !== interrupted.inode
  ) {
    throw new Error(
      'OpenClaw gateway authorization fence interrupted publication identity changed',
    );
  }
  const reboundMarker = fs.lstatSync(input.markerPath);
  const reboundCandidate = fs.lstatSync(candidate);
  if (
    reboundMarker.dev !== markerDetails.dev
    || reboundMarker.ino !== markerDetails.ino
    || reboundMarker.nlink !== 2
    || reboundCandidate.dev !== markerDetails.dev
    || reboundCandidate.ino !== markerDetails.ino
    || reboundCandidate.nlink !== 2
  ) {
    throw new Error(
      'OpenClaw gateway authorization fence interrupted publication raced recovery',
    );
  }
  fs.unlinkSync(candidate);
  fsyncDirectory(directory);
  return inspectExactRootFile({
    filePath: input.markerPath,
    expectedContent: input.expectedContent,
    exactMode: 0o600,
  });
}

function inspectMarkerFile(): OpenClawGatewayFenceMarkerIdentity | null {
  assertSafeRootDirectory('/var/lib');
  assertSafeRootDirectory(path.dirname(OPENCLAW_GATEWAY_FENCE_MARKER));
  try {
    return recoverInterruptedMarkerPublication({
      markerPath: OPENCLAW_GATEWAY_FENCE_MARKER,
      expectedContent: OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
    });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensureMarkerFile(): OpenClawGatewayFenceMarkerIdentity {
  const existing = inspectMarkerFile();
  if (existing) return existing;
  const directory = path.dirname(OPENCLAW_GATEWAY_FENCE_MARKER);
  const temporary = path.join(
    directory,
    `.openclaw-gateway-authorization-fence.${process.pid}.${crypto.randomBytes(16).toString('hex')}`,
  );
  let descriptor: number | null = null;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.fchownSync(descriptor, 0, 0);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, OPENCLAW_GATEWAY_FENCE_MARKER);
      published = true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
    return inspectExactRootFile({
      filePath: OPENCLAW_GATEWAY_FENCE_MARKER,
      expectedContent: OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
      exactMode: 0o600,
    });
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best effort only. The fence is not considered established.
      }
    }
    if (!published || fs.existsSync(temporary)) {
      try {
        fs.unlinkSync(temporary);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          // A leftover root-only temporary file is inert. Preserve the
          // original failure rather than masking it during cleanup.
        }
      }
    }
  }
}

function removeMarkerFile(): void {
  const marker = inspectMarkerFile();
  if (!marker) return;
  fs.unlinkSync(OPENCLAW_GATEWAY_FENCE_MARKER);
  fsyncDirectory(path.dirname(OPENCLAW_GATEWAY_FENCE_MARKER));
}

function attestDropInFile(): void {
  assertSafeRootDirectory('/etc');
  assertSafeRootDirectory('/etc/systemd');
  assertSafeRootDirectory('/etc/systemd/system');
  assertSafeRootDirectory(path.dirname(OPENCLAW_GATEWAY_DROP_IN));
  inspectExactRootFile({
    filePath: OPENCLAW_GATEWAY_DROP_IN,
    expectedContent: OPENCLAW_GATEWAY_DROP_IN_CONTENT,
  });
}

function attestRootUserDropInFile(): void {
  for (const directory of [
    '/root',
    '/root/.config',
    '/root/.config/systemd',
    '/root/.config/systemd/user',
    path.dirname(OPENCLAW_GATEWAY_ROOT_USER_DROP_IN),
  ]) {
    assertSafeRootDirectory(directory);
  }
  inspectExactRootFile({
    filePath: OPENCLAW_GATEWAY_ROOT_USER_DROP_IN,
    expectedContent: OPENCLAW_GATEWAY_ROOT_USER_DROP_IN_CONTENT,
  });
}

function attestRootUserMaskFile(): void {
  for (const directory of [
    '/dev',
    '/root',
    '/root/.config',
    '/root/.config/systemd',
    '/root/.config/systemd/user',
  ]) {
    assertSafeRootDirectory(directory);
  }
  const before = fs.lstatSync(OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH);
  const nullDevice = fs.lstatSync('/dev/null');
  if (
    !before.isSymbolicLink()
    || before.uid !== 0
    || before.gid !== 0
    || before.nlink !== 1
    || fs.readlinkSync(OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH) !== '/dev/null'
    || !nullDevice.isCharacterDevice()
    || nullDevice.isSymbolicLink()
    || nullDevice.uid !== 0
    || nullDevice.gid !== 0
  ) {
    throw new Error('OpenClaw root user gateway mask is unsafe');
  }
  const followed = fs.statSync(OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH);
  const after = fs.lstatSync(OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH);
  if (
    followed.dev !== nullDevice.dev
    || followed.ino !== nullDevice.ino
    || followed.rdev !== nullDevice.rdev
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.nlink !== before.nlink
    || fs.readlinkSync(OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH) !== '/dev/null'
  ) {
    throw new Error('OpenClaw root user gateway mask changed during attestation');
  }
}

function attestRootUserManagerRuntime(): void {
  assertSafeRootDirectory('/run');
  assertSafeRootDirectory(ROOT_USER_RUNTIME_DIRECTORY);
  for (const socketPath of [
    ROOT_USER_BUS_PATH,
    `${ROOT_USER_RUNTIME_DIRECTORY}/systemd/private`,
  ]) {
    const details = fs.lstatSync(socketPath);
    if (
      !details.isSocket()
      || details.isSymbolicLink()
      || details.uid !== 0
      || details.gid !== 0
    ) {
      throw new Error('OpenClaw root user systemd manager runtime is unsafe');
    }
  }
}

function sameMarker(
  left: OpenClawGatewayFenceMarkerIdentity,
  right: OpenClawGatewayFenceMarkerIdentity | null,
): boolean {
  return Boolean(
    right
    && left.path === right.path
    && left.device === right.device
    && left.inode === right.inode,
  );
}

const SYSTEMCTL_ENVIRONMENT = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

async function runSystemctl(
  args: readonly string[],
  rootUser = false,
): Promise<string> {
  if (rootUser) attestRootUserManagerRuntime();
  try {
    const result = await execFileAsync(
      SYSTEMCTL,
      rootUser ? ['--user', ...args] : [...args],
      {
        encoding: 'utf8',
        timeout: SYSTEMD_OPERATION_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: rootUser
          ? {
            ...SYSTEMCTL_ENVIRONMENT,
            XDG_RUNTIME_DIR: ROOT_USER_RUNTIME_DIRECTORY,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${ROOT_USER_BUS_PATH}`,
          }
          : SYSTEMCTL_ENVIRONMENT,
      },
    );
    return String(result.stdout || '');
  } catch {
    throw new Error('OpenClaw gateway systemd operation failed');
  }
}

const defaultDependencies: OpenClawGatewayAuthorizationFenceDependencies = {
  getGatewayApiUrl: getOpenClawApiUrl,
  systemctl: (args) => runSystemctl(args),
  rootUserSystemctl: (args) => runSystemctl(args, true),
  async inspectRootUserManager() {
    try {
      return parseRootUserManagerShow(await runSystemctl([
        'show',
        ROOT_USER_MANAGER_UNIT,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=SubState',
        '--property=MainPID',
        '--property=ControlGroup',
        '--no-pager',
      ]));
    } catch {
      throw new Error('OpenClaw root user systemd manager identity could not be attested');
    }
  },
  ensureMarker: ensureMarkerFile,
  inspectMarker: inspectMarkerFile,
  removeMarker: removeMarkerFile,
  attestDropIn: attestDropInFile,
  attestRootUserDropIn: attestRootUserDropInFile,
  attestRootUserMask: attestRootUserMaskFile,
  async listListeningPids(port) {
    try {
      const result = await execFileAsync(SS, [
        '-H',
        '-ltnp',
        `sport = :${port}`,
      ], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
      });
      return parseListeningPids(String(result.stdout || ''));
    } catch {
      throw new Error('OpenClaw gateway listener ownership could not be inspected');
    }
  },
  readProcessControlGroup(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error('OpenClaw gateway listener process identity is invalid');
    }
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
      const unified = raw
        .split(/\r?\n/)
        .map((line) => line.match(/^0::(.+)$/)?.[1] || null)
        .find((entry): entry is string => Boolean(entry));
      return unified || null;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('OpenClaw gateway listener cgroup could not be read');
    }
  },
  readCgroupEvents(controlGroup) {
    if (![
      OPENCLAW_GATEWAY_CONTROL_GROUP,
      OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP,
      ROOT_USER_MANAGER_CONTROL_GROUP,
    ].includes(controlGroup)) {
      throw new Error('OpenClaw gateway cgroup identity is invalid');
    }
    const eventsPath = path.join(SYSTEMD_CGROUP_ROOT, controlGroup, 'cgroup.events');
    const resolved = path.resolve(eventsPath);
    if (!resolved.startsWith(`${SYSTEMD_CGROUP_ROOT}${path.sep}`)) {
      throw new Error('OpenClaw gateway cgroup path escaped the systemd hierarchy');
    }
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('OpenClaw gateway cgroup state could not be read');
    }
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export class OpenClawGatewayAuthorizationFenceError extends Error {
  readonly code = 'OPENCLAW_GATEWAY_AUTHORIZATION_FENCE_UNAVAILABLE';
  readonly statusCode = 503;
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'OpenClawGatewayAuthorizationFenceError';
  }
}

export function createOpenClawGatewayAuthorizationFence(
  overrides: Partial<OpenClawGatewayAuthorizationFenceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  const resolveEndpoint = (): OpenClawGatewayEndpoint => {
    try {
      return parseConfiguredGatewayEndpoint(dependencies.getGatewayApiUrl());
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw gateway configured endpoint is not an unambiguous loopback HTTP URL.',
      );
    }
  };

  const inspect = async (): Promise<OpenClawGatewayUnitSnapshot> => {
    try {
      const output = await dependencies.systemctl([
        'show',
        OPENCLAW_GATEWAY_UNIT,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=SubState',
        '--property=KillMode',
        '--property=MainPID',
        '--property=ControlGroup',
        '--property=FragmentPath',
        '--property=DropInPaths',
        '--property=NeedDaemonReload',
        '--no-pager',
      ]);
      return parseSystemctlShow(output);
    } catch (error) {
      if (error instanceof OpenClawGatewayAuthorizationFenceError) throw error;
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw gateway systemd identity could not be attested.',
      );
    }
  };

  const inspectRootUserUnit = async (): Promise<OpenClawGatewayUnitSnapshot> => {
    try {
      const output = await dependencies.rootUserSystemctl([
        'show',
        OPENCLAW_GATEWAY_UNIT,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=SubState',
        '--property=KillMode',
        '--property=MainPID',
        '--property=ControlGroup',
        '--property=FragmentPath',
        '--property=DropInPaths',
        '--property=NeedDaemonReload',
        '--no-pager',
      ]);
      return parseRootUserSystemctlShow(output);
    } catch (error) {
      if (error instanceof OpenClawGatewayAuthorizationFenceError) throw error;
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw root user gateway systemd identity could not be attested.',
      );
    }
  };

  const waitFor = async (
    predicate: (snapshot: OpenClawGatewayUnitSnapshot) => boolean,
  ): Promise<OpenClawGatewayUnitSnapshot> => {
    const deadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    let snapshot = await inspect();
    while (!predicate(snapshot) && dependencies.now() < deadline) {
      await dependencies.wait(SYSTEMD_SETTLE_POLL_MS);
      snapshot = await inspect();
    }
    return snapshot;
  };

  const waitForRootUserUnit = async (
    predicate: (snapshot: OpenClawGatewayUnitSnapshot) => boolean,
  ): Promise<OpenClawGatewayUnitSnapshot> => {
    const deadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    let snapshot = await inspectRootUserUnit();
    while (!predicate(snapshot) && dependencies.now() < deadline) {
      await dependencies.wait(SYSTEMD_SETTLE_POLL_MS);
      snapshot = await inspectRootUserUnit();
    }
    return snapshot;
  };

  const assertListenerAuthority = async (
    port: number,
    requireListener: boolean,
  ): Promise<boolean> => {
    let listenerPids: readonly number[];
    try {
      listenerPids = await dependencies.listListeningPids(port);
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw gateway listener ownership could not be attested.',
      );
    }
    if (listenerPids.length === 0) return !requireListener;
    if (!requireListener) return false;
    for (const pid of listenerPids) {
      let controlGroup: string | null;
      try {
        controlGroup = dependencies.readProcessControlGroup(pid);
      } catch {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw gateway listener cgroup could not be attested.',
        );
      }
      if (controlGroup !== OPENCLAW_GATEWAY_CONTROL_GROUP) {
        throw new OpenClawGatewayAuthorizationFenceError(
          'An alternate process owns the OpenClaw gateway listener.',
        );
      }
    }
    return true;
  };

  const waitForListenerAuthority = async (port: number): Promise<void> => {
    const deadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    while (dependencies.now() <= deadline) {
      if (await assertListenerAuthority(port, true)) return;
      await dependencies.wait(SYSTEMD_SETTLE_POLL_MS);
    }
    throw new OpenClawGatewayAuthorizationFenceError(
      'OpenClaw gateway did not return with an attested systemd listener.',
    );
  };

  const assertStaticFence = (): void => {
    try {
      dependencies.attestDropIn();
      dependencies.attestRootUserDropIn();
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw gateway persistent authorization fence is unavailable.',
      );
    }
  };

  const expectedCgroupIsEmpty = (
    controlGroup = OPENCLAW_GATEWAY_CONTROL_GROUP,
  ): boolean => {
    try {
      return cgroupIsEmpty(
        dependencies.readCgroupEvents(controlGroup),
      );
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw gateway stopped cgroup could not be attested.',
      );
    }
  };

  interface RootUserQuiescence {
    managerActive: boolean;
    installed: boolean;
    masked: boolean;
    priorActive: boolean;
    observedActiveState: string;
    observedMainPid: 0;
    cgroupEmpty: true;
  }

  const quiesceRootUserAuthority = async (
    challengePersistentFence: boolean,
  ): Promise<RootUserQuiescence> => {
    let manager: OpenClawRootUserManagerSnapshot;
    try {
      manager = await dependencies.inspectRootUserManager();
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw root user systemd manager identity could not be attested.',
      );
    }
    if (!manager.active) {
      if (
        !expectedCgroupIsEmpty(ROOT_USER_MANAGER_CONTROL_GROUP)
        || !expectedCgroupIsEmpty(OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP)
      ) {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw root user systemd authority remained populated.',
        );
      }
      return Object.freeze({
        managerActive: false,
        installed: false,
        masked: false,
        priorActive: false,
        observedActiveState: manager.activeState,
        observedMainPid: 0 as const,
        cgroupEmpty: true as const,
      });
    }

    try {
      await dependencies.rootUserSystemctl(['daemon-reload']);
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw root user systemd manager could not load its persistent fence.',
      );
    }
    const before = await inspectRootUserUnit();
    if (before.masked) {
      try {
        dependencies.attestRootUserMask();
      } catch {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw root user gateway mask could not be attested.',
        );
      }
    }
    if (
      before.installed
      && !before.masked
      && (before.active || before.mainPid > 0)
    ) {
      await dependencies.rootUserSystemctl(['stop', OPENCLAW_GATEWAY_UNIT]);
      const settled = await waitForRootUserUnit((snapshot) => (
        snapshot.installed
        && !snapshot.active
        && snapshot.mainPid === 0
      ));
      if (!settled.installed || settled.active || settled.mainPid !== 0) {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw root user gateway unit did not settle after stop.',
        );
      }
    }

    let after: OpenClawGatewayUnitSnapshot;
    if (before.installed && !before.masked && challengePersistentFence) {
      await dependencies.rootUserSystemctl(['start', OPENCLAW_GATEWAY_UNIT]);
      after = await waitForRootUserUnit((snapshot) => (
        snapshot.installed
        && !snapshot.active
        && snapshot.mainPid === 0
      ));
    } else {
      after = await inspectRootUserUnit();
    }
    if (
      after.installed !== before.installed
      || after.masked !== before.masked
      || after.active
      || after.mainPid !== 0
      || !expectedCgroupIsEmpty(OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP)
    ) {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw root user gateway did not reach a durably fenced empty state.',
      );
    }
    if (after.masked) {
      try {
        dependencies.attestRootUserMask();
      } catch {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw root user gateway mask could not be re-attested.',
        );
      }
    }
    let managerAfter: OpenClawRootUserManagerSnapshot;
    try {
      managerAfter = await dependencies.inspectRootUserManager();
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw root user systemd manager could not be re-attested.',
      );
    }
    if (
      !managerAfter.active
      && !expectedCgroupIsEmpty(ROOT_USER_MANAGER_CONTROL_GROUP)
    ) {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw root user systemd manager did not settle safely.',
      );
    }
    return Object.freeze({
      managerActive: true,
      installed: before.installed,
      masked: before.masked,
      priorActive: before.active,
      observedActiveState: after.activeState,
      observedMainPid: 0 as const,
      cgroupEmpty: true as const,
    });
  };

  const inspectMarker = (): OpenClawGatewayFenceMarkerIdentity | null => {
    try {
      return dependencies.inspectMarker();
    } catch {
      throw new OpenClawGatewayAuthorizationFenceError(
        'OpenClaw gateway authorization fence marker is unsafe.',
      );
    }
  };

  return Object.freeze({
    inspect,

    async assertReleased(): Promise<void> {
      const marker = inspectMarker();
      if (marker) {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw gateway restart is paused during an authorization transition.',
        );
      }
    },

    async stop(): Promise<OpenClawGatewayStopProof> {
      const endpoint = resolveEndpoint();
      let marker: OpenClawGatewayFenceMarkerIdentity;
      try {
        marker = dependencies.ensureMarker();
      } catch {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw gateway authorization fence marker could not be established.',
        );
      }
      assertStaticFence();
      try {
        await dependencies.systemctl(['daemon-reload']);
      } catch {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw gateway systemd manager could not load its persistent fence.',
        );
      }
      const before = await inspect();
      if (before.installed && (before.active || before.mainPid > 0)) {
        await dependencies.systemctl(['stop', OPENCLAW_GATEWAY_UNIT]);
        const settled = await waitFor((snapshot) => (
          snapshot.installed
          && !snapshot.active
          && snapshot.mainPid === 0
        ));
        if (
          !settled.installed
          || settled.active
          || settled.mainPid !== 0
        ) {
          throw new OpenClawGatewayAuthorizationFenceError(
            'OpenClaw gateway systemd unit did not settle after stop.',
          );
        }
      }
      let after: OpenClawGatewayUnitSnapshot;
      if (before.installed) {
        // A marker on disk is not sufficient evidence that systemd's
        // effective condition still observes it. Challenge the exact loaded
        // unit while the marker is present and require it to remain empty.
        await dependencies.systemctl(['start', OPENCLAW_GATEWAY_UNIT]);
        after = await waitFor((snapshot) => (
          snapshot.installed
          && !snapshot.active
          && snapshot.mainPid === 0
        ));
      } else {
        after = await inspect();
      }
      const rootUser = await quiesceRootUserAuthority(true);
      const cgroupEmpty = expectedCgroupIsEmpty();
      const listenersAbsent = await assertListenerAuthority(endpoint.port, false);
      const reattestedMarker = inspectMarker();
      assertStaticFence();
      if (
        after.installed !== before.installed
        || after.active
        || after.mainPid !== 0
        || !cgroupEmpty
        || !listenersAbsent
        || !sameMarker(marker, reattestedMarker)
      ) {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw gateway did not reach a durably fenced empty state.',
        );
      }
      return Object.freeze({
        unit: OPENCLAW_GATEWAY_UNIT,
        stopped: true,
        priorActive: before.active,
        priorMainPid: before.mainPid,
        priorControlGroup: before.controlGroup,
        observedActiveState: after.activeState,
        observedMainPid: 0 as const,
        cgroupEmpty: true as const,
        listenerPort: endpoint.port,
        listenersAbsent: true as const,
        markerPath: OPENCLAW_GATEWAY_FENCE_MARKER,
        markerDevice: marker.device,
        markerInode: marker.inode,
        dropInPath: OPENCLAW_GATEWAY_DROP_IN,
        rootUserDropInPath: OPENCLAW_GATEWAY_ROOT_USER_DROP_IN,
        rootUserManagerActive: rootUser.managerActive,
        rootUserUnitInstalled: rootUser.installed,
        rootUserUnitMasked: rootUser.masked,
        rootUserUnitPriorActive: rootUser.priorActive,
        rootUserUnitObservedActiveState: rootUser.observedActiveState,
        rootUserUnitObservedMainPid: 0 as const,
        rootUserCgroupEmpty: true as const,
      });
    },

    async release(_restart: boolean): Promise<OpenClawGatewayUnitSnapshot> {
      // Once authorization is COMMITTED, every retry must converge to the same
      // state. Leaving an installed enabled unit inactive after marker removal
      // would only defer its unaudited start until the next reboot.
      const endpoint = resolveEndpoint();
      assertStaticFence();
      const marker = inspectMarker();
      await quiesceRootUserAuthority(true);
      let current = await inspect();
      if (
        marker
        || !current.installed
        || !current.active
      ) {
        const cgroupEmpty = expectedCgroupIsEmpty();
        const listenersAbsent = await assertListenerAuthority(endpoint.port, false);
        if (
          current.active
          || current.mainPid !== 0
          || !cgroupEmpty
          || !listenersAbsent
        ) {
          throw new OpenClawGatewayAuthorizationFenceError(
            'OpenClaw gateway was not empty before releasing its persistent fence.',
          );
        }
      }
      if (marker) {
        try {
          dependencies.removeMarker();
        } catch {
          throw new OpenClawGatewayAuthorizationFenceError(
            'OpenClaw gateway authorization fence marker could not be released.',
          );
        }
      }
      await this.assertReleased();
      if (marker) {
        // The root user unit is retired for the lifetime of the Portal
        // installation. Rechallenge after removing the transition marker so
        // release proves the permanent ExecCondition inhibitor independently.
        await quiesceRootUserAuthority(true);
      }
      current = await inspect();
      if (!current.installed) {
        const cgroupEmpty = expectedCgroupIsEmpty();
        const listenersAbsent = await assertListenerAuthority(endpoint.port, false);
        assertStaticFence();
        await this.assertReleased();
        if (
          current.active
          || current.mainPid !== 0
          || !cgroupEmpty
          || !listenersAbsent
        ) {
          throw new OpenClawGatewayAuthorizationFenceError(
            'OpenClaw gateway absent state could not be re-attested after fence release.',
          );
        }
        return current;
      }
      let after = current;
      if (!current.active) {
        const cgroupEmpty = expectedCgroupIsEmpty();
        const listenersAbsent = await assertListenerAuthority(endpoint.port, false);
        if (current.mainPid !== 0 || !cgroupEmpty || !listenersAbsent) {
          throw new OpenClawGatewayAuthorizationFenceError(
            'OpenClaw gateway was not empty before converging its release.',
          );
        }
        await dependencies.systemctl(['start', OPENCLAW_GATEWAY_UNIT]);
        after = await waitFor((snapshot) => snapshot.active && snapshot.mainPid > 0);
      }
      if (!after.active || after.mainPid < 1) {
        throw new OpenClawGatewayAuthorizationFenceError(
          'OpenClaw gateway did not return to an active systemd cgroup.',
        );
      }
      await waitForListenerAuthority(endpoint.port);
      assertStaticFence();
      await this.assertReleased();
      return after;
    },

    async start(): Promise<OpenClawGatewayUnitSnapshot> {
      return this.release(true);
    },
  });
}

export const openClawGatewayAuthorizationFence =
  createOpenClawGatewayAuthorizationFence();

export async function assertOpenClawGatewayAuthorizationFenceReleased(): Promise<void> {
  await openClawGatewayAuthorizationFence.assertReleased();
}

export const __openClawGatewayAuthorizationFenceTest = {
  OPENCLAW_GATEWAY_UNIT,
  OPENCLAW_GATEWAY_UNIT_PATH,
  OPENCLAW_GATEWAY_DROP_IN,
  OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH,
  OPENCLAW_GATEWAY_ROOT_USER_DROP_IN,
  OPENCLAW_GATEWAY_DROP_IN_CONTENT,
  OPENCLAW_GATEWAY_ROOT_USER_DROP_IN_CONTENT,
  OPENCLAW_GATEWAY_FENCE_MARKER,
  OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
  OPENCLAW_GATEWAY_CONTROL_GROUP,
  OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP,
  ROOT_USER_MANAGER_CONTROL_GROUP,
  OPENCLAW_GATEWAY_PORT: DEFAULT_OPENCLAW_GATEWAY_PORT,
  parseConfiguredGatewayEndpoint,
  parseSystemctlShow,
  parseRootUserSystemctlShow,
  parseRootUserManagerShow,
  parseListeningPids,
  cgroupIsEmpty,
  sameMarker,
  recoverInterruptedMarkerPublication,
};
