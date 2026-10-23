/** Installer-recorded Desktop toolchain capability. The installer builds the
 * toolchain image locally and records either `installed` or the exact reason
 * this host cannot run Desktop builds; every other Portal function is unaffected. */
export const DESKTOP_ELECTRON_VERSION = '44.9.0';
export const DESKTOP_RUNTIME_PARENT = '/usr/lib/bridgesllm-desktop';
export const DESKTOP_ELECTRON_PARENT = `${DESKTOP_RUNTIME_PARENT}/electron`;
export const DESKTOP_ELECTRON_ROOT_PATTERN = /^\/usr\/lib\/bridgesllm-desktop\/electron\/44\.9\.0-[a-f0-9]{12}$/;

export type DesktopDependencyPolicy = 'brokered' | 'offline';

const UNAVAILABLE_REASONS: Record<string, string> = {
  'not-installed': 'The Desktop toolchain is not installed on this server. An administrator can add it with install.sh --install-desktop-toolchain.',
  skipped: 'Desktop builds were turned off when this server was installed (--skip-desktop-toolchain). An administrator can add them with install.sh --install-desktop-toolchain.',
  'project-runtimes': 'Desktop builds need Project runtimes, which are turned off on this server (--skip-project-runtimes).',
  architecture: 'Desktop builds need an x86_64 server. This server uses a different processor architecture.',
  glibc: 'Desktop builds need glibc 2.36 or newer (Debian 12, Ubuntu 24.04 or later). This server is older.',
  userns: 'Desktop apps need unprivileged user namespaces for the Chromium sandbox, and this server turns them off.',
  apparmor: 'This server restricts user namespaces through AppArmor, and the Desktop runtime profile could not be loaded.',
  disk: 'There was not enough free disk space to build the Desktop toolchain. Free some space, then run install.sh --install-desktop-toolchain.',
  'remote-desktop': 'Desktop apps open on the Remote Desktop, which is not installed on this server.',
  'build-failed': 'The Desktop toolchain could not be built. Check the installer log, then run install.sh --install-desktop-toolchain again.',
};

export class DesktopToolchainUnavailableError extends Error {
  readonly code = 'DESKTOP_TOOLCHAIN_UNAVAILABLE';
  readonly statusCode = 503;
  constructor(message: string) { super(message); this.name = 'DesktopToolchainUnavailableError'; }
}

export type DesktopToolchainAvailability =
  | { available: true; dependencyPolicy: DesktopDependencyPolicy }
  | { available: false; code: string; reason: string; dependencyPolicy: DesktopDependencyPolicy };

// Read at call time; config/env.ts validates these installer keys at startup.
function installerValue(name: string): string { return process.env[name] || ''; }

export function desktopDependencyPolicy(): DesktopDependencyPolicy {
  return installerValue('PORTAL_DESKTOP_DEPENDENCY_POLICY') === 'offline' ? 'offline' : 'brokered';
}

export function desktopToolchainAvailability(): DesktopToolchainAvailability {
  const dependencyPolicy = desktopDependencyPolicy();
  const state = installerValue('PORTAL_DESKTOP_TOOLCHAIN_STATE');
  if (state === 'installed' && /^sha256:[a-f0-9]{64}$/.test(installerValue('PORTAL_DESKTOP_RUNTIME_IMAGE_ID'))) {
    return { available: true, dependencyPolicy };
  }
  const match = /^unavailable:([a-z-]{1,32})$/.exec(state);
  const code = match && UNAVAILABLE_REASONS[match[1]] ? match[1] : 'not-installed';
  return { available: false, code, reason: UNAVAILABLE_REASONS[code], dependencyPolicy };
}

/** The installed Electron root, recorded by the installer after admission. */
export function desktopElectronRoot(): string {
  const root = installerValue('PORTAL_DESKTOP_ELECTRON_ROOT');
  if (!DESKTOP_ELECTRON_ROOT_PATTERN.test(root)) {
    throw new DesktopToolchainUnavailableError('The Desktop GUI runtime is not installed on this server. An administrator can install it with install.sh --install-desktop-toolchain.');
  }
  return root;
}
