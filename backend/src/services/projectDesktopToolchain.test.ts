import { desktopDependencyPolicy, desktopElectronRoot, desktopToolchainAvailability, DesktopToolchainUnavailableError } from './projectDesktopToolchain';

const KEYS = ['PORTAL_DESKTOP_RUNTIME_IMAGE_ID', 'PORTAL_DESKTOP_ELECTRON_ROOT', 'PORTAL_DESKTOP_TOOLCHAIN_STATE', 'PORTAL_DESKTOP_DEPENDENCY_POLICY'];
const IMAGE = 'sha256:' + 'a'.repeat(64);

describe('Desktop toolchain availability', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; } });
  afterEach(() => { for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

  it('is available only when the installer recorded an installed state and an immutable image', () => {
    expect(desktopToolchainAvailability()).toMatchObject({ available: false, code: 'not-installed' });
    process.env.PORTAL_DESKTOP_TOOLCHAIN_STATE = 'installed';
    expect(desktopToolchainAvailability()).toMatchObject({ available: false, code: 'not-installed' });
    process.env.PORTAL_DESKTOP_RUNTIME_IMAGE_ID = IMAGE;
    expect(desktopToolchainAvailability()).toEqual({ available: true, dependencyPolicy: 'brokered' });
    process.env.PORTAL_DESKTOP_RUNTIME_IMAGE_ID = 'bridgesllm-desktop-toolchain:v1';
    expect(desktopToolchainAvailability().available).toBe(false);
  });

  it('reports the recorded host reason and never echoes unknown state text', () => {
    process.env.PORTAL_DESKTOP_RUNTIME_IMAGE_ID = IMAGE;
    for (const code of ['architecture', 'glibc', 'userns', 'apparmor', 'disk', 'remote-desktop', 'build-failed', 'skipped', 'project-runtimes']) {
      process.env.PORTAL_DESKTOP_TOOLCHAIN_STATE = 'unavailable:' + code;
      const result = desktopToolchainAvailability();
      expect(result).toMatchObject({ available: false, code });
      if (!result.available) expect(result.reason.length).toBeGreaterThan(20);
    }
    process.env.PORTAL_DESKTOP_TOOLCHAIN_STATE = 'unavailable:<script>';
    const unknown = desktopToolchainAvailability();
    expect(unknown).toMatchObject({ available: false, code: 'not-installed' });
    if (!unknown.available) expect(unknown.reason).not.toContain('<script>');
  });

  it('defaults to brokered dependencies and honours an explicit offline policy', () => {
    expect(desktopDependencyPolicy()).toBe('brokered');
    process.env.PORTAL_DESKTOP_DEPENDENCY_POLICY = 'offline';
    expect(desktopDependencyPolicy()).toBe('offline');
    process.env.PORTAL_DESKTOP_DEPENDENCY_POLICY = 'anything-else';
    expect(desktopDependencyPolicy()).toBe('brokered');
  });

  it('accepts only an installer-managed, manifest-addressed Electron root', () => {
    expect(() => desktopElectronRoot()).toThrow(DesktopToolchainUnavailableError);
    for (const bad of ['/usr/lib/bridgesllm-desktop/electron/44.9.0', '/tmp/electron', '/usr/lib/bridgesllm-desktop/electron/44.9.0-ABCDEF123456', '/usr/lib/bridgesllm-desktop/electron/44.9.0-0123456789ab/../x']) {
      process.env.PORTAL_DESKTOP_ELECTRON_ROOT = bad;
      expect(() => desktopElectronRoot()).toThrow(DesktopToolchainUnavailableError);
    }
    process.env.PORTAL_DESKTOP_ELECTRON_ROOT = '/usr/lib/bridgesllm-desktop/electron/44.9.0-0123456789ab';
    expect(desktopElectronRoot()).toBe('/usr/lib/bridgesllm-desktop/electron/44.9.0-0123456789ab');
  });
});
