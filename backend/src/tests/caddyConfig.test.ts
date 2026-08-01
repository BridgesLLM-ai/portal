import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns/promises';
import {
  APP_CONTENT_CADDY_BLOCK_BEGIN,
  buildAppContentManagedCaddyBlock,
  buildPortalManagedCaddyBlock,
  configuredAppContentDomain,
  defaultAppContentDomain,
  type CaddyCommandRunner,
  PORTAL_CADDY_BLOCK_BEGIN,
  PORTAL_CADDY_SETUP_IP_BEGIN,
  removePortalSetupIpAccess,
  removePortalSetupIpAccessFromContent,
  replaceAppContentManagedCaddyBlock,
  replacePortalManagedCaddyBlock,
  resolveAppContentDomain,
  updatePortalAndAppContentCaddyConfig,
  updatePortalCaddyConfig,
} from '../utils/serverSetup';

describe('BridgesLLM-owned Caddy configuration', () => {
  let tempDir: string;
  let caddyPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgesllm-caddy-'));
    caddyPath = path.join(tempDir, 'Caddyfile');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function successfulRunner(validated: string[], onReload?: () => void): CaddyCommandRunner {
    return {
      validate(configPath: string): void {
        validated.push(fs.readFileSync(configPath, 'utf8'));
      },
      reload(): void {
        onReload?.();
      },
    };
  }

  it('installs a marked Portal block into a fresh empty Caddyfile', () => {
    fs.writeFileSync(caddyPath, '');
    const validated: string[] = [];
    let reloads = 0;

    const changed = updatePortalCaddyConfig('portal.example.com', '203.0.113.10', true, {
      caddyPath,
      commandRunner: successfulRunner(validated, () => { reloads += 1; }),
    });

    const installed = fs.readFileSync(caddyPath, 'utf8');
    expect(changed).toBe(true);
    expect(installed).toBe(buildPortalManagedCaddyBlock('portal.example.com', '203.0.113.10', true));
    expect(validated).toEqual([installed]);
    expect(reloads).toBe(1);
  });

  it('replaces only the existing marked Portal block', () => {
    const before = `mail.example.net {
  reverse_proxy 127.0.0.1:8080
}

`;
    const after = `
voice.example.net:8443 {
  reverse_proxy 127.0.0.1:9000
}
`;
    const existing = `${before}${buildPortalManagedCaddyBlock('old.example.com', '203.0.113.20', true)}${after}`;

    const updated = replacePortalManagedCaddyBlock(
      existing,
      buildPortalManagedCaddyBlock('new.example.com', '203.0.113.21', true),
    );

    expect(updated.startsWith(before)).toBe(true);
    expect(updated.endsWith(after)).toBe(true);
    expect(updated).toContain('new.example.com, www.new.example.com');
    expect(updated).not.toContain('old.example.com');
    expect(updated.match(new RegExp(PORTAL_CADDY_BLOCK_BEGIN, 'g'))).toHaveLength(1);
  });

  it('migrates the exact legacy Portal block while preserving unrelated nested sites verbatim', () => {
    const unrelatedBefore = `{
  email ops@example.net
}

alpha.example.net {
  handle /nested/* {
    header X-Literal "{not a block}"
    reverse_proxy 127.0.0.1:9000 {
      flush_interval -1
    }
  }
}

`;
    const legacyPortal = `# BridgesLLM Portal — managed by setup wizard
old.example.com, www.old.example.com {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}

# Keep IP access alive during setup so the wizard can finish on HTTP
http://198.51.100.5 {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
`;
    const unrelatedAfter = `
omega.example.net {
  respond "still here" 200
}
`;
    const existing = `${unrelatedBefore}${legacyPortal}${unrelatedAfter}`;

    const updated = replacePortalManagedCaddyBlock(
      existing,
      buildPortalManagedCaddyBlock('new.example.com', '203.0.113.11', true),
    );

    expect(updated.startsWith(unrelatedBefore)).toBe(true);
    expect(updated.endsWith(unrelatedAfter)).toBe(true);
    expect(updated).toContain('new.example.com, www.new.example.com');
    expect(updated).not.toContain('old.example.com');
    expect(updated.match(new RegExp(PORTAL_CADDY_BLOCK_BEGIN, 'g'))).toHaveLength(1);
  });

  it('removes the complete legacy setup-IP block despite nested reverse_proxy braces', () => {
    const legacy = `# BridgesLLM Portal — managed by setup wizard
portal.example.com, www.portal.example.com {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}

# Keep IP access alive during setup so the wizard can finish on HTTP
http://203.0.113.12 {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
`;

    expect(removePortalSetupIpAccessFromContent(legacy)).toBe(
      buildPortalManagedCaddyBlock('portal.example.com', '203.0.113.12', false),
    );
  });

  it('uses the validated atomic path when setup removes temporary IP access', () => {
    const unrelated = `other.example.net {
  handle {
    reverse_proxy 127.0.0.1:9999 {
      flush_interval -1
    }
  }
}

`;
    fs.writeFileSync(
      caddyPath,
      `${unrelated}${buildPortalManagedCaddyBlock('portal.example.com', '203.0.113.13', true)}`,
    );
    const validated: string[] = [];
    let reloads = 0;

    const changed = removePortalSetupIpAccess({
      caddyPath,
      commandRunner: successfulRunner(validated, () => { reloads += 1; }),
    });

    const installed = fs.readFileSync(caddyPath, 'utf8');
    expect(changed).toBe(true);
    expect(installed.startsWith(unrelated)).toBe(true);
    expect(installed).not.toContain(PORTAL_CADDY_SETUP_IP_BEGIN);
    expect(installed).not.toContain('http://203.0.113.13');
    expect(installed).toContain('portal.example.com, www.portal.example.com');
    expect(validated).toEqual([installed]);
    expect(reloads).toBe(1);
  });

  it('leaves the original file byte-for-byte intact when candidate validation fails', () => {
    const original = `unrelated.example.net {
  reverse_proxy 127.0.0.1:8080
}
`;
    fs.writeFileSync(caddyPath, original);
    let reloads = 0;
    const runner: CaddyCommandRunner = {
      validate(): void {
        throw new Error('invalid candidate');
      },
      reload(): void {
        reloads += 1;
      },
    };

    expect(() => updatePortalCaddyConfig('portal.example.com', '203.0.113.14', true, {
      caddyPath,
      commandRunner: runner,
    })).toThrow('Existing configuration was left unchanged');
    expect(fs.readFileSync(caddyPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(tempDir)).toEqual(['Caddyfile']);
    expect(reloads).toBe(0);
  });

  it('refuses ambiguous managed markers without touching the existing file', () => {
    const original = `${buildPortalManagedCaddyBlock('first.example.com', '203.0.113.22', true)}\n${buildPortalManagedCaddyBlock('second.example.com', '203.0.113.23', true)}`;
    fs.writeFileSync(caddyPath, original);
    let validations = 0;
    let reloads = 0;

    expect(() => updatePortalCaddyConfig('new.example.com', '203.0.113.24', true, {
      caddyPath,
      commandRunner: {
        validate(): void { validations += 1; },
        reload(): void { reloads += 1; },
      },
    })).toThrow('malformed or duplicate');

    expect(fs.readFileSync(caddyPath, 'utf8')).toBe(original);
    expect(validations).toBe(0);
    expect(reloads).toBe(0);
  });

  it('atomically restores the exact original file and reloads it when candidate reload fails', () => {
    const original = `first.example.net {
  reverse_proxy 127.0.0.1:8080
}

second.example.net {
  respond "preserve me" 200
}
`;
    fs.writeFileSync(caddyPath, original);
    const validated: string[] = [];
    let reloads = 0;
    const runner = successfulRunner(validated, () => {
      reloads += 1;
      if (reloads === 1) throw new Error('reload rejected');
    });

    expect(() => updatePortalCaddyConfig('portal.example.com', '203.0.113.15', true, {
      caddyPath,
      commandRunner: runner,
    })).toThrow('Restored the previous Caddy configuration');
    expect(validated).toHaveLength(1);
    expect(validated[0]).toContain('portal.example.com, www.portal.example.com');
    expect(fs.readFileSync(caddyPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(tempDir)).toEqual(['Caddyfile']);
    expect(reloads).toBe(2);
  });

  it('installs one path-limited app-content site without exposing Portal routes', () => {
    const block = buildAppContentManagedCaddyBlock('Apps.Example.NET');

    expect(block).toContain('apps.example.net {');
    expect(block).toContain('path /share /share/* /hosted /hosted/*');
    expect(block).toContain('respond "Not found" 404');
    expect(block).not.toContain('/api');
    expect(block.match(new RegExp(APP_CONTENT_CADDY_BLOCK_BEGIN, 'g'))).toHaveLength(1);
  });

  it('atomically adds Portal and isolated app-content blocks while preserving unrelated sites', () => {
    const unrelated = `mail.example.net {
  reverse_proxy 127.0.0.1:8080
}
`;
    fs.writeFileSync(caddyPath, unrelated);
    const validated: string[] = [];
    let reloads = 0;

    const changed = updatePortalAndAppContentCaddyConfig(
      'portal.example.com',
      '203.0.113.25',
      true,
      'apps.example.net',
      {
        caddyPath,
        commandRunner: successfulRunner(validated, () => { reloads += 1; }),
      },
    );

    const installed = fs.readFileSync(caddyPath, 'utf8');
    expect(changed).toBe(true);
    expect(installed.startsWith(unrelated)).toBe(true);
    expect(installed).toContain('portal.example.com, www.portal.example.com');
    expect(installed).toContain('apps.example.net {');
    expect(validated).toEqual([installed]);
    expect(reloads).toBe(1);
  });

  it('replaces only the marked app-content block', () => {
    const before = `mail.example.net {
  respond "preserve" 200
}

`;
    const existing = `${before}${buildAppContentManagedCaddyBlock('old.example.net')}`;
    const updated = replaceAppContentManagedCaddyBlock(
      existing,
      buildAppContentManagedCaddyBlock('new.example.org'),
    );

    expect(updated.startsWith(before)).toBe(true);
    expect(updated).toContain('new.example.org {');
    expect(updated).not.toContain('old.example.net');
    expect(updated.match(new RegExp(APP_CONTENT_CADDY_BLOCK_BEGIN, 'g'))).toHaveLength(1);
  });

  it('derives a DNS-backed separate-site fallback and honors an explicit domain', async () => {
    expect(defaultAppContentDomain('203.0.113.26')).toBe('app-content.203.0.113.26.sslip.io');
    expect(configuredAppContentDomain('203.0.113.26', {
      APP_CONTENT_DOMAIN: 'Apps.Example.NET',
    } as NodeJS.ProcessEnv)).toBe('apps.example.net');

    jest.spyOn(dns, 'resolve4').mockResolvedValue(['203.0.113.26']);
    await expect(resolveAppContentDomain('portal.example.com', '203.0.113.26', {} as NodeJS.ProcessEnv))
      .resolves.toEqual({
        domain: 'app-content.203.0.113.26.sslip.io',
        origin: 'https://app-content.203.0.113.26.sslip.io',
        externalDnsFallback: true,
      });
  });

  it('rejects sibling domains, alternate ports, and DNS pointing elsewhere', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['198.51.100.99']);

    await expect(resolveAppContentDomain('portal.example.com', '203.0.113.27', {
      APP_CONTENT_DOMAIN: 'apps.example.com',
    } as NodeJS.ProcessEnv)).rejects.toThrow('different registrable site');

    await expect(resolveAppContentDomain('portal.example.com', '203.0.113.27', {
      APP_CONTENT_ORIGIN: 'https://portal.example.com:8443',
    } as NodeJS.ProcessEnv)).rejects.toThrow('different registrable site');

    await expect(resolveAppContentDomain('portal.example.com', '203.0.113.27', {
      APP_CONTENT_DOMAIN: 'apps.example.net',
    } as NodeJS.ProcessEnv)).rejects.toThrow('resolves to 198.51.100.99');
  });
});
