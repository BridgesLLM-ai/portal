import fs from 'fs';
import path from 'path';
import { DESKTOP_BUILD_SCRIPT, desktopBuildArgs } from './projectDesktopBuild';
import { parseDesktopProjectDescriptor } from './projectDesktopContract';
import { DESKTOP_PROJECT_TEMPLATES } from './projectDesktopTemplates';

const descriptor = parseDesktopProjectDescriptor({ version: 1, target: 'desktop', language: 'rust', interface: 'terminal', framework: 'std', binary: 'desktop-starter' });

describe('Desktop build dependency policy', () => {
  it('passes the server-selected policy as the final in-sandbox argument', () => {
    for (const policy of ['brokered', 'offline'] as const) {
      const args = desktopBuildArgs(descriptor, 'check', [], policy);
      expect(args[0]).toBe('-e');
      expect(args[1]).toBe(DESKTOP_BUILD_SCRIPT);
      expect(args[3]).toBe('check');
      expect(args[args.length - 1]).toBe(policy);
    }
  });

  it('keeps lockfiles authoritative in both modes and only offline mode forbids the network', () => {
    expect(DESKTOP_BUILD_SCRIPT).toContain("process.argv[4] === 'brokered' ? 'brokered' : 'offline'");
    expect(DESKTOP_BUILD_SCRIPT).toContain("const npmMode=offline?'--offline':'--prefer-offline'");
    expect(DESKTOP_BUILD_SCRIPT).toContain("cargoNetwork=offline?['--offline']:[]");
    expect(DESKTOP_BUILD_SCRIPT).toContain("...(offline?['--no-index']:[])");
    expect(DESKTOP_BUILD_SCRIPT).toContain("run('npm',['ci',npmMode,'--include=dev','--no-audit','--no-fund'])");
    expect(DESKTOP_BUILD_SCRIPT).toMatch(/'build','--release','--locked'/);
    expect(DESKTOP_BUILD_SCRIPT).toMatch(/'check','--locked'/);
    // The Electron binary only ever comes from the admitted host runtime.
    expect(DESKTOP_BUILD_SCRIPT).toContain("ELECTRON_SKIP_BINARY_DOWNLOAD:'1'");
    expect(DESKTOP_BUILD_SCRIPT).not.toMatch(/cargo-vendor|replace-with/);
  });
});

describe('Desktop toolchain seed inputs', () => {
  it('match the starter dependency manifests exactly', () => {
    const root = path.resolve(__dirname, '../../../installer/desktop-toolchain/seed-inputs');
    const expected: Record<string, string[]> = {
      'typescript-terminal': ['package.json', 'package-lock.json'],
      'typescript-gui': ['package.json', 'package-lock.json'],
      'rust-terminal': ['Cargo.toml', 'Cargo.lock'],
      'rust-gui': ['Cargo.toml', 'Cargo.lock'],
    };
    expect(fs.readdirSync(root).sort()).toEqual(Object.keys(expected).sort());
    for (const [starter, files] of Object.entries(expected)) {
      expect(fs.readdirSync(path.join(root, starter)).sort()).toEqual([...files].sort());
      for (const file of files) {
        expect(fs.readFileSync(path.join(root, starter, file), 'utf8')).toBe(DESKTOP_PROJECT_TEMPLATES[starter].files[file]);
      }
    }
  });
});
