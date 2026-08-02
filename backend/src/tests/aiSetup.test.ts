jest.mock('node-pty', () => ({ spawn: jest.fn() }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { __resetClaudeSetupStartLeaseForTests, applyPortalOwnedProviderFileRemoval, applyProviderRemovalConfigPatch, buildPortalOwnedProviderFileRemoval, buildProviderRegistrationSeedModels, buildProviderRemovalConfigPatch, captureFileSnapshot, classifyPortalOwnedApiKeyRemoval, classifyProviderRuntimeFailure, classifyRcSafeProviderRemoval, createAiSetupRouter, credentialEntryProofSummary, credentialWriteRequestFingerprint, ExclusiveProviderOperationGate, filterXaiChatModels, getExpectedXaiProbeModel, getOAuthRequestOwnerId, getProviderDefaultModelPayload, getProviderRemovalCapability, getSafeXaiChatModelCatalog, matchesProviderModel, mergeDiscoveredProviderModelsIntoConfig, normalizeModelPayload, portalCredentialProfileContainsSubmittedSecret, presentProviderCredentialEnvironmentVariables, ProviderRemovalPreflightBlockedError, providerCredentialAliases, providerRemovalUsesUnverifiableCredentialSurface, readJsonStrictIfPresent, readStableCredentialWriteProof, removeProviderCredentialRoutingReferences, resolveModelRegistrationProvider, restoreSnapshotsWithCompareAndSwap, runClaudeSetupCompletionOnce, runClaudeSetupStartOnce, runNativeCliCompletionFinalizerOnce, runOAuthCompletionFinalizerOnce, runOpenClawWithSecretInput, shouldParkProviderRemovalFailure } from '../routes/ai-setup';
import { __deleteOAuthSessionForTests, __setOAuthSessionForTests, type OAuthSession } from '../services/oauthFlowManager';
import {
  __clearProviderCredentialLifecycleLedgerForTests,
  __readProviderCredentialLifecycleLedgerForTests,
  __setProviderCredentialLifecycleLedgerPathForTests,
  claimProviderCredentialWriteLifecycle,
  parkProviderCredentialRemovalLifecycle,
} from '../services/providerCredentialLifecycleLedger';

describe('xAI provider operation serialization', () => {
  test('prevents setup and disconnect from overlapping in either direction', () => {
    const gate = new ExclusiveProviderOperationGate();
    const setupToken = gate.acquire('oauth');
    expect(() => gate.acquire('disconnect')).toThrow(/still open/i);
    gate.release(setupToken);

    const disconnectToken = gate.acquire('disconnect');
    expect(() => gate.acquire('api-key')).toThrow(/still open/i);
    gate.release(disconnectToken);
    expect(() => gate.acquire('oauth')).not.toThrow();
  });

  test('tells the operator how to recover instead of only refusing', () => {
    const gate = new ExclusiveProviderOperationGate();
    gate.acquire('oauth');
    expect(() => gate.acquire('disconnect')).toThrow(/use Reset to clear it/i);
  });

  test('reclaims an abandoned operation whose release path never ran', () => {
    // A crashed, cancelled, or abandoned sign-in never releases the gate.
    // Without an expiry that locked xAI out until the Portal restarted.
    const held = new ExclusiveProviderOperationGate(60_000);
    held.acquire('oauth');
    expect(() => held.acquire('disconnect')).toThrow(/still open/i);

    const expired = new ExclusiveProviderOperationGate(0);
    expired.acquire('oauth');
    expect(() => expired.acquire('disconnect')).not.toThrow();
  });

  test('requires the selected xAI primary model in the post-save credential probe', () => {
    expect(getExpectedXaiProbeModel('xai', true, 'xai/grok-build-0.1')).toBe('xai/grok-build-0.1');
    expect(getExpectedXaiProbeModel('xai', false, 'xai/grok-build-0.1')).toBeUndefined();
    expect(getExpectedXaiProbeModel('anthropic', true, 'anthropic/claude-sonnet-4-6')).toBeUndefined();
  });

  test('CAS rollback never overwrites concurrent provider configuration bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-xai-cas-'));
    const configPath = path.join(dir, 'openclaw.json');
    try {
      fs.writeFileSync(configPath, 'before');
      const before = captureFileSnapshot(configPath);
      fs.writeFileSync(configPath, 'portal-mutation');
      const expected = captureFileSnapshot(configPath);
      fs.writeFileSync(configPath, 'newer-unrelated-change');

      expect(() => restoreSnapshotsWithCompareAndSwap([before], [expected])).toThrow(/changed concurrently/i);
      expect(fs.readFileSync(configPath, 'utf8')).toBe('newer-unrelated-change');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('durable credential-write route contracts', () => {
  test('rejects manual-only providers before key validation or credential admission', async () => {
    const router = createAiSetupRouter();
    const manualOnlyProviders = [
      'opencode',
      'ollama',
      'huggingface',
      'moonshot',
      'venice',
      'cerebras',
      'kilocode',
      'cloudflare-ai-gateway',
      'byteplus',
      'volcengine',
      'custom',
    ];

    for (const routePath of ['/validate-key', '/save-key']) {
      const layer = (router as any).stack.find((entry: any) => (
        entry.route?.path === routePath && entry.route?.methods?.post
      ));
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      for (const provider of manualOnlyProviders) {
        const response: any = { status: jest.fn(), json: jest.fn() };
        response.status.mockReturnValue(response);
        response.json.mockReturnValue(response);
        await handler({
          body: {
            provider,
            apiKey: 'must-not-be-validated-or-saved',
            operationId: 'e635fcbf-66f9-4d0d-ad3d-c8d13d44512c',
          },
          user: { userId: 'manual-only-provider-owner' },
        }, response);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
          error: expect.stringMatching(/guided API-key setup is not available/i),
        }));
      }
    }
  });

  test('requires exact submitted material in the fixed Portal JSON target profile', () => {
    const exactApiKey = { type: 'api_key', provider: 'openai', key: 'submitted-secret' };
    const exactToken = { type: 'token', provider: 'anthropic', token: 'submitted-token' };
    expect(portalCredentialProfileContainsSubmittedSecret(exactApiKey, 'openai', 'submitted-secret')).toBe(true);
    expect(portalCredentialProfileContainsSubmittedSecret(exactApiKey, 'openai', 'older-secret')).toBe(false);
    expect(portalCredentialProfileContainsSubmittedSecret(exactApiKey, 'google', 'submitted-secret')).toBe(false);
    expect(portalCredentialProfileContainsSubmittedSecret(exactToken, 'anthropic', 'submitted-token')).toBe(true);
    expect(portalCredentialProfileContainsSubmittedSecret({
      type: 'api_key',
      provider: 'openai',
      key: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' },
    }, 'openai', 'OPENAI_API_KEY')).toBe(false);
  });

  test('parks recovery after a crash immediately after the Portal profile write', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-credential-write-recovery-'));
    fs.chmodSync(directory, 0o700);
    const ledgerPath = path.join(directory, 'provider-lifecycle.sqlite3');
    __setProviderCredentialLifecycleLedgerPathForTests(ledgerPath);
    try {
      const operationId = '0b7a8ec0-79d3-4b78-a7a2-6e56a1e32f65';
      const ownerId = 'user:recovery-owner';
      const requestFingerprint = credentialWriteRequestFingerprint({
        provider: 'openai',
        secret: 'already-written-but-unsettled-secret',
        setDefault: false,
        model: null,
      });
      const firstAdmission = claimProviderCredentialWriteLifecycle(
        'credential-domain:openai',
        ownerId,
        operationId,
        requestFingerprint,
        'openclaw-and-portal',
      );
      expect(firstAdmission.disposition).toBe('admitted');
      // Simulate process loss after the first Portal JSON profile write but
      // before auth-order/model routing and a durable completion receipt.
      parkProviderCredentialRemovalLifecycle(firstAdmission.claim);

      const router = createAiSetupRouter();
      const layer = (router as any).stack.find((entry: any) => (
        entry.route?.path === '/save-key' && entry.route?.methods?.post
      ));
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const response: any = { status: jest.fn(), json: jest.fn() };
      response.status.mockReturnValue(response);
      response.json.mockReturnValue(response);

      await handler({
        body: {
          provider: 'openai',
          apiKey: 'already-written-but-unsettled-secret',
          operationId,
        },
        user: { userId: 'recovery-owner' },
      }, response);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        credentialSaved: false,
        credentialState: 'indeterminate',
        error: expect.stringMatching(/full credential and routing transaction/i),
      }));
      expect(response.json.mock.calls[0][0]).not.toHaveProperty('operationDisposition');
      const records = Object.values(__readProviderCredentialLifecycleLedgerForTests().records);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        lifecycleKind: 'api-key-save-openclaw-and-portal',
        state: 'indeterminate',
        processPid: null,
        processStartTicks: null,
        bindingState: 'attested-processless',
      });
    } finally {
      __clearProviderCredentialLifecycleLedgerForTests();
      __setProviderCredentialLifecycleLedgerPathForTests(null);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('canonicalizes SecretRefs without their resolved value and treats unknown material as present', () => {
    const secretRef = credentialEntryProofSummary({
      provider: 'openai',
      type: 'api_key',
      key: { id: 'OPENAI_API_KEY', provider: 'default', source: 'env', ignored: 'metadata' },
    });
    expect(secretRef).toMatchObject({ present: true, externallyManaged: true, unknownShape: false });

    const sameSecretRef = credentialEntryProofSummary({
      provider: 'openai',
      type: 'api_key',
      key: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' },
    });
    expect(sameSecretRef.fingerprint).toBe(secretRef.fingerprint);
    for (const source of ['file', 'exec'] as const) {
      expect(credentialEntryProofSummary({
        provider: 'openai',
        type: 'api_key',
        key: { source, provider: 'default', id: `openai-${source}` },
      })).toMatchObject({ present: true, externallyManaged: true, unknownShape: false });
    }

    const unknown = credentialEntryProofSummary({
      provider: 'openai',
      type: 'api_key',
      key: { futureSecretBackend: 'opaque-value-must-not-be-treated-as-absent' },
    });
    expect(unknown).toMatchObject({ present: true, externallyManaged: false, unknownShape: true });
    expect(unknown.fingerprint).not.toContain('opaque-value-must-not-be-treated-as-absent');
  });

  test('includes only the known alias-family environment credential names in proof', () => {
    const environment = {
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_OAUTH_TOKEN: 'anthropic-oauth-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
      CODEX_API_KEY: 'codex-secret',
      OPENAI_API_KEY: 'openai-secret',
      GEMINI_API_KEY: 'gemini-secret',
      GOOGLE_API_KEY: '',
      XAI_API_KEY: 'xai-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      MISTRAL_API_KEY: 'mistral-secret',
      GROQ_API_KEY: 'groq-secret',
      TOGETHER_API_KEY: 'together-secret',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENCODE_API_KEY: 'opencode-secret',
      OPENCODE_ZEN_API_KEY: 'opencode-zen-secret',
      AWS_ACCESS_KEY_ID: 'aws-access-id',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-bearer',
      AWS_PROFILE: 'production-profile',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/run/secrets/aws-token',
      UNRELATED_SECRET: 'ignore-me',
    };
    expect(presentProviderCredentialEnvironmentVariables('anthropic', 'anthropic', environment)).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(presentProviderCredentialEnvironmentVariables('openai-codex', 'openai', environment)).toEqual([
      'CODEX_API_KEY',
      'OPENAI_API_KEY',
    ]);
    expect(presentProviderCredentialEnvironmentVariables('google-gemini-cli', 'google-gemini-cli', environment)).toEqual([
      'GEMINI_API_KEY',
    ]);
    expect(presentProviderCredentialEnvironmentVariables('xai', 'xai', environment)).toEqual(['XAI_API_KEY']);
    expect(presentProviderCredentialEnvironmentVariables('openrouter', 'openrouter', environment)).toEqual(['OPENROUTER_API_KEY']);
    expect(presentProviderCredentialEnvironmentVariables('mistral', 'mistral', environment)).toEqual(['MISTRAL_API_KEY']);
    expect(presentProviderCredentialEnvironmentVariables('groq', 'groq', environment)).toEqual(['GROQ_API_KEY']);
    expect(presentProviderCredentialEnvironmentVariables('together', 'together', environment)).toEqual(['TOGETHER_API_KEY']);
    expect(presentProviderCredentialEnvironmentVariables('deepseek', 'deepseek', environment)).toEqual(['DEEPSEEK_API_KEY']);
    expect(presentProviderCredentialEnvironmentVariables('opencode', 'opencode', environment)).toEqual([
      'OPENCODE_API_KEY',
      'OPENCODE_ZEN_API_KEY',
    ]);
    expect(presentProviderCredentialEnvironmentVariables('amazon-bedrock', 'amazon-bedrock', environment)).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_PROFILE',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
    ]);
  });

  test('fingerprints the secret and every mutation-affecting request field', () => {
    const first = credentialWriteRequestFingerprint({
      provider: 'anthropic',
      secret: 'secret-one',
      setDefault: true,
      model: 'anthropic/claude-fable-5',
    });
    const same = credentialWriteRequestFingerprint({
      provider: 'anthropic',
      secret: 'secret-one',
      setDefault: true,
      model: 'anthropic/claude-fable-5',
    });
    const changed = credentialWriteRequestFingerprint({
      provider: 'anthropic',
      secret: 'secret-two',
      setDefault: true,
      model: 'anthropic/claude-fable-5',
    });

    expect(first).toBe(same);
    expect(changed).not.toBe(first);
    expect(first).not.toContain('secret-one');
  });

  test('fails closed when credential readback changes between recovery reads', async () => {
    const reader = jest.fn()
      .mockResolvedValueOnce({ fingerprint: 'before', absent: false })
      .mockResolvedValueOnce({ fingerprint: 'after', absent: false });

    await expect(readStableCredentialWriteProof(reader, {
      stableReads: 2,
      intervalMs: 1,
      delay: async () => undefined,
    })).rejects.toThrow(/unstable/i);
  });

  test('treats every OpenClaw/native alias family as one credential domain', () => {
    expect([...providerCredentialAliases('anthropic', 'anthropic')]).toEqual(
      expect.arrayContaining(['anthropic', 'claude-cli']),
    );
    expect([...providerCredentialAliases('openai-codex', 'openai')]).toEqual(
      expect.arrayContaining(['openai', 'openai-codex', 'codex', 'codex-cli']),
    );
    expect([...providerCredentialAliases('google-gemini-cli', 'google-gemini-cli')]).toEqual(
      expect.arrayContaining(['google', 'google-gemini-cli', 'gemini']),
    );
  });

  test('removes auth order and model references for the full credential alias family', () => {
    const config = {
      auth: { order: { openai: ['profile'], codex: ['profile'], anthropic: ['keep'] } },
      agents: { defaults: {
        model: {
          primary: 'openai/gpt-5.5',
          fallbacks: ['codex/gpt-5.5', 'anthropic/claude-fable-5'],
        },
        models: {
          'openai-codex/gpt-5.5': {},
          'anthropic/claude-fable-5': {},
        },
        compaction: {
          provider: 'OpenAI',
          model: 'codex-cli/gpt-5.5',
          memoryFlush: { model: 'openai/gpt-5.5' },
        },
        heartbeat: { model: 'openai-codex/gpt-5.5' },
      } },
    };
    removeProviderCredentialRoutingReferences(
      config,
      providerCredentialAliases('openai-codex', 'openai'),
    );
    expect(config.auth.order).toEqual({ anthropic: ['keep'] });
    expect(config.agents.defaults.model).toEqual({
      fallbacks: ['anthropic/claude-fable-5'],
    });
    expect(config.agents.defaults.models).toEqual({
      'anthropic/claude-fable-5': {},
    });
    expect(config.agents.defaults.compaction).toEqual({ memoryFlush: {} });
    expect(config.agents.defaults.heartbeat).toEqual({});
  });

  test('hard-disables authoritative credentials while allowing credential-absent routing cleanup', () => {
    const aliases = providerCredentialAliases('openai-codex', 'openai');
    const safeInventory = {
      aliases,
      authoritativeProfiles: {
        'openai:oauth': {
          type: 'oauth', provider: 'openai', managedBy: 'openclaw-auth-store',
          access: 'oauth-access', refresh: 'oauth-refresh', expires: Date.now() + 60_000,
        },
      },
      legacyAuthProfiles: { version: 1, profiles: {} },
      config: {
        auth: {
          profiles: { 'openai:oauth': { provider: 'openai', mode: 'oauth' } },
          order: { openai: ['openai:oauth'] },
        },
        agents: { defaults: {
          model: {},
          models: {},
          compaction: { provider: 'OpenAI' },
        } },
      },
      models: { providers: { openai: {
        apiKey: 'oauth:openai',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'openai/gpt-5.5' }],
      } } },
      environmentCredentials: [],
    };
    const before = JSON.parse(JSON.stringify({
      ...safeInventory,
      aliases: [...safeInventory.aliases],
    }));
    expect(classifyRcSafeProviderRemoval(safeInventory)).toEqual({
      allowed: false,
      blockers: ['authoritative-oauth'],
      authStoreProviders: ['openai'],
    });
    expect(JSON.parse(JSON.stringify({
      ...safeInventory,
      aliases: [...safeInventory.aliases],
    }))).toEqual(before);

    const credentialAbsentInventory = { ...safeInventory, authoritativeProfiles: {} };
    expect(classifyRcSafeProviderRemoval(credentialAbsentInventory)).toEqual({
      allowed: true,
      blockers: [],
      authStoreProviders: [],
    });

    const blockedInventories = [
      { ...safeInventory, authoritativeProfiles: { bad: { type: 'api_key', provider: 'openai', key: 'key' } } },
      { ...safeInventory, legacyAuthProfiles: { version: 1, profiles: { old: { type: 'oauth', provider: 'openai', access: 'old' } } } },
      { ...safeInventory, legacyAuthProfiles: { version: 1, profiles: { old: { type: 'oauth', provider: 'codex-cli', access: 'old' } } } },
      { ...safeInventory, legacyAuthProfiles: { version: 1, profiles: { old: { type: 'oauth', provider: 'OpenAI', access: 'old' } } } },
      { ...safeInventory, config: { models: { providers: { openai: { apiKey: 'inline-key' } } } } },
      { ...safeInventory, config: { models: { providers: { openai: {
        request: { auth: {
          mode: 'authorization-bearer',
          token: { source: 'env', provider: 'default', id: 'OPENAI_PROXY_TOKEN' },
        } },
      } } } } },
      { ...safeInventory, config: { models: { providers: { openai: {
        request: { tls: { key: { source: 'file', provider: 'default', id: 'OPENAI_TLS_KEY' } } },
      } } } } },
      { ...safeInventory, config: { models: { providers: { openai: {
        baseUrl: 'https://user:password@example.invalid/v1',
      } } } } },
      { ...safeInventory, config: { models: { providers: { openai: {
        params: { futureCredentialEnvelope: { opaque: true } },
      } } } } },
      { ...safeInventory, config: { models: { providers: { openai: {
        futureCredentialField: { opaque: true },
      } } } } },
      { ...safeInventory, models: { providers: { codex: { headers: { Authorization: 'Bearer secret' } } } } },
      { ...safeInventory, models: { providers: { codex: { localService: { env: { PRIVATE_TOKEN: 'secret' } } } } } },
      { ...safeInventory, environmentCredentials: ['OPENAI_API_KEY'] },
      { ...safeInventory, models: { providers: [] as any } },
      { ...safeInventory, config: { agents: { defaults: { compaction: { model: 42 } } } } },
      { ...safeInventory, config: { agents: { defaults: { heartbeat: { model: ['openai/gpt-5.5'] } } } } },
      { ...safeInventory, config: { auth: {
        profiles: { 'openai:oauth': { provider: 'openai', mode: 'oauth' } },
        order: { anthropic: ['openai:oauth'] },
      } } },
      { ...safeInventory, config: { auth: { order: { openai: 'openai:oauth' } } } },
      { ...safeInventory, config: { agents: { list: [{ id: 'other', model: 'openai/gpt-5.5' }] } } },
      { ...safeInventory, config: { agents: { defaults: {
        memorySearch: { provider: 'openai', model: 'text-embedding-3-small' },
      } } } },
      { ...safeInventory, config: { tools: { media: { providers: {
        openai: { apiKey: { source: 'env', provider: 'default', id: 'OPENAI_MEDIA_KEY' } },
      } } } } },
    ];
    for (const inventory of blockedInventories) {
      expect(classifyRcSafeProviderRemoval(inventory).allowed).toBe(false);
    }
  });

  test('strict inventory reads fail closed on malformed JSON and non-object roots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-provider-removal-inventory-'));
    try {
      const malformed = path.join(dir, 'malformed.json');
      const arrayRoot = path.join(dir, 'array.json');
      fs.writeFileSync(malformed, '{not-json');
      fs.writeFileSync(arrayRoot, '[]');
      expect(() => readJsonStrictIfPresent(malformed)).toThrow(/inventory .* unreadable/i);
      expect(() => readJsonStrictIfPresent(arrayRoot)).toThrow(/root value is not an object/i);
      expect(readJsonStrictIfPresent(path.join(dir, 'missing.json'))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps resumed removal fences parked and rejects unverifiable native credential surfaces', () => {
    expect(shouldParkProviderRemovalFailure({ namespace: 'provider-removal:openai', leaseId: 'lease' }, false)).toBe(false);
    expect(shouldParkProviderRemovalFailure({
      namespace: 'provider-removal:openai',
      leaseId: 'lease',
      resumed: true,
    }, false)).toBe(true);
    expect(shouldParkProviderRemovalFailure({ namespace: 'provider-removal:openai', leaseId: 'lease' }, true)).toBe(true);
    expect(providerRemovalUsesUnverifiableCredentialSurface(['native_cli'])).toBe(true);
    expect(providerRemovalUsesUnverifiableCredentialSurface(['aws_sdk'])).toBe(true);
    expect(providerRemovalUsesUnverifiableCredentialSurface(['oauth', 'api_key'])).toBe(false);
  });

  test('builds a minimal alias-wide config patch without replaying unrelated config', () => {
    const plan = buildProviderRemovalConfigPatch({
      unrelated: { retained: true },
      auth: {
        profiles: {
          target: { provider: 'openai', mode: 'oauth' },
          keep: { provider: 'anthropic', mode: 'oauth' },
        },
        order: { openai: ['target'], codex: ['target'], 'codex-cli': ['target'], anthropic: ['keep'] },
      },
      models: { providers: { openai: { models: [] }, anthropic: { models: [] } } },
      agents: { defaults: {
        model: { primary: 'openai/gpt-5.5', fallbacks: ['codex/gpt-5.5', 'anthropic/claude-fable-5'] },
        models: { 'openai-codex/gpt-5.5': {}, 'anthropic/claude-fable-5': {} },
        compaction: {
          provider: 'OpenAI',
          model: 'codex-cli/gpt-5.5',
          memoryFlush: { enabled: true, model: 'openai/gpt-5.5' },
        },
        heartbeat: { interval: '30m', model: 'openai-codex/gpt-5.5' },
      } },
    }, providerCredentialAliases('openai-codex', 'openai'));
    expect(plan).toEqual({
      changed: true,
      replacePaths: ['agents.defaults.model.fallbacks'],
      patch: {
        auth: { profiles: { target: null }, order: { openai: null, codex: null, 'codex-cli': null } },
        models: { providers: { openai: null } },
        agents: { defaults: {
          model: { primary: null, fallbacks: ['anthropic/claude-fable-5'] },
          models: { 'openai-codex/gpt-5.5': null },
          compaction: { provider: null, model: null, memoryFlush: { model: null } },
          heartbeat: { model: null },
        } },
      },
    });
    expect(JSON.stringify(plan.patch)).not.toContain('unrelated');
    expect(JSON.stringify(plan.patch)).not.toContain('keep');
  });

  test('cleans the valid string shorthand for the default model through the same CAS patch', () => {
    expect(buildProviderRemovalConfigPatch({
      agents: { defaults: { model: 'OpenAI/gpt-5.5' } },
    }, providerCredentialAliases('openai', 'openai'))).toEqual({
      changed: true,
      replacePaths: [],
      patch: { agents: { defaults: { model: null } } },
    });
  });

  test('revalidates before mutation and retries config CAS only from a fresh snapshot', async () => {
    const aliases = providerCredentialAliases('openai-codex', 'openai');
    const config = { auth: { order: { openai: ['profile'] } } };
    const blockedRpc = jest.fn();
    await expect(applyProviderRemovalConfigPatch({
      aliases,
      initialSnapshot: { config, hash: 'hash-one' },
      assertLease: jest.fn(),
      revalidate: async () => { throw new ProviderRemovalPreflightBlockedError('blocked'); },
      rpc: blockedRpc as any,
    })).rejects.toThrow('blocked');
    expect(blockedRpc).not.toHaveBeenCalled();

    const rpc = jest.fn()
      .mockResolvedValueOnce({ ok: false, error: 'config changed since last load; re-run config.get and retry' })
      .mockResolvedValueOnce({ ok: true, data: { config, hash: 'hash-two' } })
      .mockResolvedValueOnce({ ok: true, data: { ok: true } });
    const assertLease = jest.fn();
    const revalidate = jest.fn(async () => undefined);
    await expect(applyProviderRemovalConfigPatch({
      aliases,
      initialSnapshot: { config, hash: 'hash-one' },
      assertLease,
      revalidate,
      rpc: rpc as any,
    })).resolves.toMatchObject({ patched: true });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['config.patch', 'config.get', 'config.patch']);
    expect(rpc.mock.calls[0][1]).toMatchObject({ baseHash: 'hash-one' });
    expect(rpc.mock.calls[2][1]).toMatchObject({ baseHash: 'hash-two' });
    expect(JSON.parse(rpc.mock.calls[2][1].raw)).toEqual({ auth: { order: { openai: null } } });
    expect(assertLease).toHaveBeenCalledTimes(2);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  test('pipes setup-token through stdin and never exposes it through argv or a child error', () => {
    const childProcess = require('child_process');
    const secret = 'setup-token-super-secret';
    const success = jest.spyOn(childProcess, 'execFileSync').mockReturnValueOnce('ok');

    expect(runOpenClawWithSecretInput([
      'models', 'auth', 'paste-token', '--provider', 'anthropic', '--profile-id', 'anthropic:portal-setup-token',
    ], secret)).toBeUndefined();
    const [, argv, options] = success.mock.calls[0];
    expect(argv).not.toContain(secret);
    expect((options as any).input).toBe(`${secret}\n`);
    success.mockRestore();

    const failure = jest.spyOn(childProcess, 'execFileSync').mockImplementationOnce(() => {
      const error: any = new Error(`child echoed ${secret}`);
      error.stderr = secret;
      throw error;
    });
    let caught: Error | null = null;
    try {
      runOpenClawWithSecretInput(['models', 'auth', 'paste-token'], secret);
    } catch (error: any) {
      caught = error;
    }
    expect(caught?.message).toContain('OpenClaw did not accept the setup-token');
    expect(caught?.message).not.toContain(secret);
    failure.mockRestore();
  });

  test('fences gateway restarts and uses only the installed systemd system unit', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai-setup.ts'), 'utf8');
    const restart = source.slice(
      source.indexOf('async function restartGateway()'),
      source.indexOf('async function finalizeNativeCliCompletion'),
    );

    expect(restart.indexOf('await assertOpenClawGatewayAuthorizationFenceReleased()'))
      .toBeLessThan(restart.indexOf("execFileSync('/usr/bin/systemctl', ['restart', 'openclaw-gateway.service']"));
    expect(restart).toContain("fs.existsSync('/run/systemd/system')");
    expect(restart).toContain("fs.existsSync('/usr/bin/systemctl')");
    expect(restart).not.toContain("runOpenClaw(['gateway', 'restart']");
    expect(restart).not.toContain('SIGUSR1');
    expect(restart).not.toContain('pgrep');
    expect(restart).not.toContain('falling back');
  });

  test('admits both secret-write routes before mutation and receipts before responding', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai-setup.ts'), 'utf8');
    const saveKeyRoute = source.slice(
      source.indexOf("router.post('/save-key'"),
      source.indexOf('// ── Claude setup-token flow'),
    );
    const setupTokenRoute = source.slice(
      source.indexOf("router.post('/save-setup-token'"),
      source.indexOf("router.post('/set-default-model'"),
    );

    expect(saveKeyRoute.indexOf('claimProviderCredentialWriteLifecycle('))
      .toBeLessThan(saveKeyRoute.indexOf("beginXaiSetup('api-key'"));
    expect(saveKeyRoute.indexOf('claimProviderCredentialWriteLifecycle('))
      .toBeLessThan(saveKeyRoute.indexOf('saveProviderApiKey(provider, apiKey)'));
    expect(saveKeyRoute.lastIndexOf('completeProviderCredentialWriteLifecycle('))
      .toBeLessThan(saveKeyRoute.lastIndexOf('res.json(responsePayload)'));
    const recoveredKeyBranch = saveKeyRoute.slice(
      saveKeyRoute.indexOf("admission.disposition === 'recovered'"),
      saveKeyRoute.indexOf('} else {', saveKeyRoute.indexOf("admission.disposition === 'recovered'")),
    );
    expect(recoveredKeyBranch).not.toContain('saveProviderApiKey');
    expect(recoveredKeyBranch).not.toContain('portalCredentialTargetContainsSubmittedSecret');
    expect(recoveredKeyBranch).toContain('credentialCommitIndeterminate = true');
    expect(recoveredKeyBranch).toContain('full credential and routing transaction');
    expect(recoveredKeyBranch).not.toContain('attestProviderCredentialLifecycleFingerprint');

    expect(setupTokenRoute.indexOf('claimProviderCredentialWriteLifecycle('))
      .toBeLessThan(setupTokenRoute.indexOf('runOpenClawWithSecretInput(['));
    expect(setupTokenRoute).not.toContain("'--token'");
    expect(setupTokenRoute.lastIndexOf('completeProviderCredentialWriteLifecycle('))
      .toBeLessThan(setupTokenRoute.lastIndexOf('res.json(responsePayload)'));
    const recoveredBranch = setupTokenRoute.slice(
      setupTokenRoute.indexOf("admission.disposition === 'recovered'"),
      setupTokenRoute.indexOf('} else {', setupTokenRoute.indexOf("admission.disposition === 'recovered'")),
    );
    expect(recoveredBranch).not.toContain('runOpenClawWithSecretInput');
    expect(recoveredBranch).not.toContain('readOpenClawAndPortalCredentialProof');
  });

  test('publishes removal only for exact Portal-owned API-key namespaces', () => {
    for (const providerId of ['openrouter', 'mistral', 'groq', 'together', 'deepseek']) {
      expect(getProviderRemovalCapability(providerId)).toMatchObject({
        supported: true,
        code: 'PORTAL_OWNED_API_KEY',
        requiresExactConfirmation: true,
      });
    }
    for (const providerId of [
      'openai', 'google', 'anthropic', 'xai', 'openai-codex',
      'google-gemini-cli', 'google-antigravity', 'github-copilot',
      'amazon-bedrock', 'ollama', 'agent-zero',
    ]) {
      expect(getProviderRemovalCapability(providerId)).toMatchObject({
        supported: false,
        code: 'UNSUPPORTED_CREDENTIAL_SURFACE',
      });
    }
  });

  test('accepts only matching fixed Portal JSON credentials and cleanable routing', () => {
    const provider = 'openrouter';
    const key = 'sk-or-exact';
    const safeInventory = {
      aliases: new Set([provider]),
      authoritativeProfiles: {},
      legacyAuthProfiles: {
        version: 2,
        profiles: {
          'openrouter:default': { type: 'api_key', provider, key },
          'mistral:default': { type: 'api_key', provider: 'mistral', key: 'keep' },
        },
      },
      config: {
        auth: {
          profiles: {
            'openrouter:default': { provider, mode: 'api_key' },
            'mistral:default': { provider: 'mistral', mode: 'api_key' },
          },
          order: { openrouter: ['openrouter:default'], mistral: ['mistral:default'] },
        },
        models: {
          providers: {
            openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', models: [] },
            mistral: { baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions', models: [] },
          },
        },
        agents: { defaults: {
          model: { primary: 'openrouter/model', fallbacks: ['mistral/model'] },
          models: { 'openrouter/model': {}, 'mistral/model': {} },
        } },
      },
      models: {
        providers: {
          openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', apiKey: key, models: [] },
          mistral: { baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions', apiKey: 'keep', models: [] },
        },
      },
      environmentCredentials: [],
    };
    expect(classifyPortalOwnedApiKeyRemoval(provider, safeInventory)).toEqual({
      allowed: true,
      blockers: [],
      authStoreProviders: [],
      portalCredentialPresent: true,
    });

    const partialInventory = {
      ...safeInventory,
      legacyAuthProfiles: { version: 2, profiles: {} },
    };
    expect(classifyPortalOwnedApiKeyRemoval(provider, partialInventory)).toMatchObject({
      allowed: true,
      portalCredentialPresent: true,
    });
    expect(classifyPortalOwnedApiKeyRemoval(provider, {
      ...partialInventory,
      models: { providers: {} },
    })).toMatchObject({
      allowed: true,
      portalCredentialPresent: false,
    });
  });

  test('blocks OAuth, external writers, ambiguous rows, changed secrets, and unsupported routing', () => {
    const provider = 'openrouter';
    const base = {
      aliases: new Set([provider]),
      authoritativeProfiles: {},
      legacyAuthProfiles: {
        version: 2,
        profiles: { 'openrouter:default': { type: 'api_key', provider, key: 'first' } },
      },
      config: {
        auth: {
          profiles: { 'openrouter:default': { provider, mode: 'api_key' } },
          order: { openrouter: ['openrouter:default'] },
        },
      },
      models: { providers: { openrouter: { apiKey: 'first', models: [] } } },
      environmentCredentials: [],
    };
    const blocked = [
      { ...base, authoritativeProfiles: { oauth: { provider, type: 'oauth', managedBy: 'openclaw-auth-store' } } },
      { ...base, legacyAuthProfiles: { version: 2, profiles: { other: { type: 'api_key', provider, key: 'first' } } } },
      { ...base, models: { providers: { openrouter: { apiKey: 'second', models: [] } } } },
      { ...base, models: { providers: { openrouter: { apiKey: { source: 'env', provider: 'default', id: 'OPENROUTER_API_KEY' } } } } },
      { ...base, models: { providers: { OpenRouter: { apiKey: 'first', models: [] } } } },
      { ...base, models: { providers: { openrouter: { apiKey: 'first', models: [{ id: 'safe', token: 'hidden' }] } } } },
      { ...base, environmentCredentials: ['OPENROUTER_API_KEY'] },
      { ...base, config: { agents: { list: [{ id: 'other', model: 'openrouter/model' }] } } },
      { ...base, config: {
        auth: {
          profiles: { 'openrouter:default': { provider, mode: 'api_key', type: 'oauth' } },
          order: { openrouter: ['openrouter:default'] },
        },
      } },
      { ...base, config: {
        auth: base.config.auth,
        models: { providers: { OpenRouter: { models: [] } } },
      } },
    ];
    for (const inventory of blocked) {
      expect(classifyPortalOwnedApiKeyRemoval(provider, inventory as any).allowed).toBe(false);
    }
    expect(classifyPortalOwnedApiKeyRemoval('openai', {
      ...base,
      aliases: new Set(['openai']),
    }).blockers).toContain('unsupported-provider');
  });

  test('removes only the exact Portal profile and provider catalog entry', () => {
    const result = buildPortalOwnedProviderFileRemoval('openrouter', {
      version: 2,
      profiles: {
        'openrouter:default': { type: 'api_key', provider: 'openrouter', key: 'remove' },
        'mistral:default': { type: 'api_key', provider: 'mistral', key: 'keep' },
      },
      usageStats: { 'openrouter:default': { errorCount: 2 }, 'mistral:default': { errorCount: 0 } },
      lastGood: { openrouter: 'openrouter:default', mistral: 'mistral:default', alias: 'openrouter:default' },
    }, {
      providers: {
        openrouter: { apiKey: 'remove', models: [{ id: 'model' }] },
        mistral: { apiKey: 'keep', models: [{ id: 'keep' }] },
      },
      unrelated: { retained: true },
    });
    expect(result.changedAuthProfiles).toBe(true);
    expect(result.changedModels).toBe(true);
    expect(result.authProfiles).toEqual({
      version: 2,
      profiles: {
        'mistral:default': { type: 'api_key', provider: 'mistral', key: 'keep' },
      },
      usageStats: { 'mistral:default': { errorCount: 0 } },
      lastGood: { mistral: 'mistral:default' },
    });
    expect(result.models).toEqual({
      providers: {
        mistral: { apiKey: 'keep', models: [{ id: 'keep' }] },
      },
      unrelated: { retained: true },
    });
  });

  test('rolls back a partial Portal-file failure and preserves a concurrent external writer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-provider-removal-files-'));
    const authPath = path.join(dir, 'auth-profiles.json');
    const modelsPath = path.join(dir, 'models.json');
    const originalAuth = {
      version: 2,
      profiles: { 'openrouter:default': { type: 'api_key', provider: 'openrouter', key: 'remove' } },
    };
    const originalModels = {
      providers: { openrouter: { apiKey: 'remove', models: [] } },
    };
    fs.writeFileSync(authPath, `${JSON.stringify(originalAuth, null, 2)}\n`);
    fs.writeFileSync(modelsPath, `${JSON.stringify(originalModels, null, 2)}\n`);
    let writes = 0;
    expect(() => applyPortalOwnedProviderFileRemoval('openrouter', {
      authProfilesPath: authPath,
      modelsPath,
      writer: (targetPath, data) => {
        writes += 1;
        if (writes === 2) throw new Error('second write failed');
        fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`);
      },
    })).toThrow('second write failed');
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual(originalAuth);
    expect(JSON.parse(fs.readFileSync(modelsPath, 'utf8'))).toEqual(originalModels);

    const external = { version: 2, profiles: { external: { provider: 'other', type: 'api_key', key: 'new' } } };
    expect(() => applyPortalOwnedProviderFileRemoval('openrouter', {
      authProfilesPath: authPath,
      modelsPath,
      writer: (targetPath, data) => {
        fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`);
        if (targetPath === authPath) fs.writeFileSync(targetPath, `${JSON.stringify(external, null, 2)}\n`);
      },
    })).toThrow(/changed|overwrite/i);
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual(external);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('blocks unsafe provider rows and invalid exact confirmation before lifecycle admission', async () => {
    const router = createAiSetupRouter();
    const layer = (router as any).stack.find((entry: any) => (
      entry.route?.path === '/provider/:id' && entry.route?.methods?.delete
    ));
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    for (const providerId of [
      'openai', 'google', 'anthropic', 'xai', 'google-antigravity',
      'amazon-bedrock', 'ollama',
    ]) {
      const response: any = { status: jest.fn(), json: jest.fn() };
      response.status.mockReturnValue(response);
      response.json.mockReturnValue(response);
      await handler({ params: { id: providerId }, body: {} }, response);
      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        code: 'PROVIDER_REMOVAL_UNSUPPORTED',
      }));
    }

    const unknownResponse: any = { status: jest.fn(), json: jest.fn() };
    unknownResponse.status.mockReturnValue(unknownResponse);
    unknownResponse.json.mockReturnValue(unknownResponse);
    await handler({ params: { id: 'agent-zero' }, body: {} }, unknownResponse);
    expect(unknownResponse.status).toHaveBeenCalledWith(404);

    const invalidResponse: any = { status: jest.fn(), json: jest.fn() };
    invalidResponse.status.mockReturnValue(invalidResponse);
    invalidResponse.json.mockReturnValue(invalidResponse);
    await handler({
      params: { id: 'openrouter' },
      body: {
        operationId: 'e635fcbf-66f9-4d0d-ad3d-c8d13d44512c',
        confirmationProvider: 'mistral',
      },
    }, invalidResponse);
    expect(invalidResponse.status).toHaveBeenCalledWith(400);
    expect(invalidResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INVALID_PROVIDER_REMOVAL_REQUEST',
    }));
  });

  test('orders removal admission, preflight, mutation, readback, and redacted failure', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai-setup.ts'), 'utf8');
    const removeRoute = source.slice(
      source.indexOf("router.delete('/provider/:id'"),
      source.indexOf("router.post('/restart-gateway'"),
    );
    expect(removeRoute.indexOf('claimProviderCredentialRemovalOperationLifecycle('))
      .toBeLessThan(removeRoute.indexOf('readGatewayConfigSnapshot('));
    expect(removeRoute.indexOf('readGatewayConfigSnapshot('))
      .toBeLessThan(removeRoute.indexOf('applyPortalOwnedProviderFileRemoval('));
    expect(removeRoute.indexOf('applyPortalOwnedProviderFileRemoval('))
      .toBeLessThan(removeRoute.indexOf('applyProviderRemovalConfigPatch('));
    expect(removeRoute.indexOf('applyProviderRemovalConfigPatch('))
      .toBeLessThan(removeRoute.indexOf('verifyAndReleaseProviderCredentialRemovalLifecycle('));
    expect(removeRoute).toContain("operationDisposition: 'retained'");
    expect(removeRoute).toContain("operationDisposition: 'not_admitted'");
    expect(removeRoute).toContain('completionReceipt:');
    expect(source).toContain('presentGatewayProviderCredentialEnvironmentVariables');
    expect(removeRoute).not.toContain('error?.message');
    expect(removeRoute).not.toContain('models.authLogout');
  });

  test('rotates a client operation UUID only for the dedicated pre-admission envelope mismatch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai-setup.ts'), 'utf8');
    expect(source).toContain('error instanceof DurableCredentialOperationEnvelopeMismatchError');
    expect(source).toContain("operationNotAdmitted ? { operationDisposition: 'not_admitted' } : {}");
    expect(source).not.toContain('error instanceof DurableCredentialLifecycleConflictError');
  });
});

describe('ai-setup model normalization', () => {
  test('keeps provider intent separate from canonical model namespace', () => {
    expect(resolveModelRegistrationProvider('openai/gpt-5.5', 'openai-codex', {})).toBe('openai-codex');
    expect(resolveModelRegistrationProvider('google/gemini-3.1-pro-preview', 'google-gemini-cli', {})).toBe('google-gemini-cli');
    expect(resolveModelRegistrationProvider('google/gemini-3.1-pro-preview', 'google', {})).toBe('google');
  });

  test('recovers Gemini CLI runtime intent from existing canonical config for legacy callers', () => {
    expect(resolveModelRegistrationProvider('google/gemini-3-flash-preview', null, {
      'google/gemini-3-flash-preview': { agentRuntime: { id: 'google-gemini-cli' } },
    })).toBe('google-gemini-cli');
  });

  test('does not prefix providerHint onto already-prefixed string model ids', () => {
    expect(normalizeModelPayload(['openai-codex/gpt-5.4'], 'google-gemini-cli')).toEqual([
      {
        id: 'openai/gpt-5.4',
        name: 'openai/gpt-5.4',
        provider: 'openai',
      },
    ]);
  });

  test('does not incorrectly force another provider onto providerless gateway payload rows', () => {
    expect(normalizeModelPayload([{ name: 'gpt-5.5' }], 'google-gemini-cli')).toEqual([
      {
        id: 'openai/gpt-5.5',
        name: 'gpt-5.5',
        provider: 'openai',
        raw: { name: 'gpt-5.5' },
      },
    ]);
  });

  test('keeps explicit provider ids on object payloads when filtering by another provider', () => {
    expect(normalizeModelPayload([{ id: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }], 'google-gemini-cli')).toEqual([
      {
        id: 'openrouter/deepseek/deepseek-v3.2',
        name: 'DeepSeek V3.2',
        provider: 'openrouter',
        raw: { id: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' },
      },
    ]);
  });

  test('still prefixes providerHint for bare runtime ids', () => {
    expect(normalizeModelPayload(['gemini-2.5-pro'], 'google-gemini-cli')).toEqual([
      {
        id: 'google/gemini-2.5-pro',
        name: 'google/gemini-2.5-pro',
        provider: 'google',
      },
    ]);
  });

  test('keeps same-family OpenAI rows on the canonical openai namespace when filtering for Codex OAuth', () => {
    expect(normalizeModelPayload([{ id: 'openai/gpt-5.5', provider: 'openai', name: 'GPT-5.5' }], 'openai-codex')).toEqual([
      {
        id: 'openai/gpt-5.5',
        name: 'GPT-5.5',
        provider: 'openai-codex',
        raw: { id: 'openai/gpt-5.5', provider: 'openai', name: 'GPT-5.5' },
      },
    ]);
  });

  test('rewrites same-family Gemini rows into the Antigravity namespace when filtering for Antigravity', () => {
    expect(normalizeModelPayload([{ id: 'google/gemini-3-flash', provider: 'google', name: 'Gemini 3 Flash' }], 'google-antigravity')).toEqual([
      {
        id: 'google-antigravity/gemini-3.5-flash',
        name: 'Gemini 3 Flash',
        provider: 'google-antigravity',
        raw: { id: 'google/gemini-3-flash', provider: 'google', name: 'Gemini 3 Flash' },
      },
    ]);
  });

  test('register merge persists discovered provider models into allowlist and fallbacks', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-5.5',
            fallbacks: ['openai/gpt-5.4'],
          },
          models: {
            'openai-codex/gpt-5.5': {},
          },
        },
      },
    }, 'openai-codex', [
      'codex/gpt-5.5',
      'openai/gpt-5.4',
      'openai/gpt-5.4-mini',
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.addedAllowlist).toEqual(['openai/gpt-5.4', 'openai/gpt-5.4-mini']);
    expect(merged.addedFallbacks).toEqual(['openai/gpt-5.4-mini']);
    expect(merged.config.agents.defaults.model.fallbacks).toEqual(['openai/gpt-5.4', 'openai/gpt-5.4-mini']);
    expect(merged.config.agents.defaults.models['openai/gpt-5.4']).toEqual({});
    expect(merged.config.agents.defaults.models['openai/gpt-5.4-mini']).toEqual({});
    expect(merged.config.agents.defaults.models['openai/gpt-5.5']).toEqual({});
    expect(merged.config.agents.defaults.models['openai-codex/gpt-5.5']).toBeUndefined();
    expect(merged.config.agents.defaults.models['codex/gpt-5.5']).toBeUndefined();
  });

  test('register merge repairs Codex model-scoped runtime metadata', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'openai-codex/gpt-5.5', fallbacks: [] },
          models: {
            'openai/gpt-5.5': { agentRuntime: { id: 'codex' } },
            'codex/gpt-5.5': { agentRuntime: { id: 'codex' } },
          },
        },
      },
    }, 'openai-codex', ['codex/gpt-5.5']);

    expect(merged.changed).toBe(true);
    expect(merged.addedAllowlist).toEqual([]);
    expect(merged.addedFallbacks).toEqual([]);
    expect(merged.config.agents.defaults.models['openai/gpt-5.5']).toEqual({});
    expect(merged.config.agents.defaults.models['codex/gpt-5.5']).toBeUndefined();
  });

  test('register merge preserves Antigravity provider namespace before persisting models', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({}, 'google-antigravity', [
      'google-antigravity/gemini-3.5-flash',
      'google-antigravity/gemini-3.1-pro-high',
    ]);

    expect(merged.config.agents.defaults.models).toMatchObject({
      'google-antigravity/gemini-3.5-flash': {},
      'google-antigravity/gemini-3.1-pro-high': {},
    });
    expect(merged.config.agents.defaults.model.fallbacks).toEqual([
      'google-antigravity/gemini-3.5-flash',
      'google-antigravity/gemini-3.1-pro-high',
    ]);
  });

  test('register merge migrates Gemini CLI aliases to canonical Google ids with runtime policy', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'google-gemini-cli/gemini-3.1-pro-preview', fallbacks: [] },
          models: {
            'google-gemini-cli/gemini-3.1-pro-preview': {},
          },
        },
      },
    }, 'google-gemini-cli', [
      'google-gemini-cli/gemini-3.1-pro-preview',
      'google/gemini-3-flash-preview',
    ]);

    expect(merged.config.agents.defaults.models['google-gemini-cli/gemini-3.1-pro-preview']).toBeUndefined();
    expect(merged.config.agents.defaults.models['google/gemini-3.1-pro-preview']).toEqual({
      agentRuntime: { id: 'google-gemini-cli' },
    });
    expect(merged.config.agents.defaults.models['google/gemini-3-flash-preview']).toEqual({
      agentRuntime: { id: 'google-gemini-cli' },
    });
    expect(merged.config.agents.defaults.model.fallbacks).toEqual(['google/gemini-3-flash-preview']);
  });

  test('register merge removes stale Claude CLI runtime metadata from Anthropic models', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-haiku-4-5', fallbacks: [] },
          models: {
            'anthropic/claude-haiku-4-5': { agentRuntime: { id: 'claude-cli' } },
          },
        },
      },
    }, 'anthropic', ['anthropic/claude-haiku-4-5'], { version: 2, profiles: {} });

    expect(merged.changed).toBe(true);
    expect(merged.config.agents.defaults.models['anthropic/claude-haiku-4-5']).toEqual({});
  });

  test('provider filter accepts google runtime alias models from the gateway catalog', () => {
    expect(matchesProviderModel('google-antigravity', 'google/gemini-3-flash')).toBe(true);
    expect(matchesProviderModel('google-antigravity', 'google-gemini-cli/gemini-3-flash')).toBe(true);
    expect(matchesProviderModel('google-antigravity', 'google-antigravity/gemini-3.5-flash')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'google/gemini-3.1-pro-preview')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'google-gemini-cli/gemini-3.1-pro-preview')).toBe(true);
    expect(matchesProviderModel('google-gemini-cli', 'google-antigravity/gemini-3.1-pro-high')).toBe(false);
    expect(matchesProviderModel('google-gemini-cli', 'openai/gpt-5.4')).toBe(false);
    expect(matchesProviderModel('google-gemini-cli', 'google-gemini-cli/openai/gpt-5.4')).toBe(false);
  });

  test('provider filter accepts OpenAI runtime alias models from the gateway catalog', () => {
    expect(matchesProviderModel('openai-codex', 'openai/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'openai-codex/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'codex/gpt-5.4')).toBe(true);
    expect(matchesProviderModel('openai-codex', 'google/gemini-3.1-pro-preview')).toBe(false);
    expect(matchesProviderModel('openai-codex', 'openai-codex/google/gemini-3.1-pro-preview')).toBe(false);
  });

  test('setup model fallback exposes provider defaults without requiring OpenClaw model discovery', () => {
    expect(getProviderDefaultModelPayload('openai-codex').map((model) => model.id)).toEqual(
      expect.arrayContaining(['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']),
    );
    expect(getProviderDefaultModelPayload('openai-codex').map((model) => model.id)).toContain('openai/gpt-5.5');
    expect(getProviderDefaultModelPayload('google-gemini-cli').map((model) => model.id)).toEqual([
      'google/gemini-3.1-pro-preview',
      'google/gemini-3-flash-preview',
      'google/gemini-3.1-flash-lite',
    ]);
    // Sonnet 5 is intentionally absent: unusable on the claude-cli route in
    // OpenClaw 2026.7.1 (off-only thinking profile, empty turns).
    expect(getProviderDefaultModelPayload('anthropic').map((model) => model.id)).not.toContain('anthropic/claude-sonnet-5');
    expect(getProviderDefaultModelPayload('anthropic').map((model) => model.id)).toContain('anthropic/claude-fable-5');
    expect(getProviderDefaultModelPayload('google-antigravity').map((model) => model.id)).toContain('google-antigravity/gemini-3.1-pro-high');
    expect(getProviderDefaultModelPayload(null)).toEqual([]);
  });

  test('API-key fallbacks do not regress to retired GPT-4o or Gemini 2.5 recommendations', () => {
    expect(getProviderDefaultModelPayload('openai').map((model) => model.id)).toEqual([
      'openai/gpt-5.6-sol',
      'openai/gpt-5.5',
    ]);
    expect(getProviderDefaultModelPayload('google').map((model) => model.id)).toEqual([
      'google/gemini-3.1-pro-preview',
      'google/gemini-3-flash-preview',
      'google/gemini-3.1-flash-lite',
    ]);
  });

  test('xAI fallback catalog covers canonical ids plus the pass-through Grok 4.5 flagship', () => {
    expect(getProviderDefaultModelPayload('xai').map((model) => model.id)).toEqual([
      'xai/grok-4.5',
      'xai/grok-4.3',
      'xai/grok-build-0.1',
      'xai/grok-4.20-beta-latest-reasoning',
      'xai/grok-4.20-beta-latest-non-reasoning',
    ]);
  });

  test('carries only capability-safe xAI chat models into registration', () => {
    expect(buildProviderRegistrationSeedModels('xai', [
      'grok-4.3',
      'xai/grok-build-0.1',
      'openai/gpt-5.5',
      'xai/grok-imagine-image',
      'xai/grok-imagine-video',
      'grok-4.3',
    ], 'xai/account-preview-model', [
      'xai/grok-4.3',
      'xai/grok-build-0.1',
    ])).toEqual([
      'xai/grok-4.3',
      'xai/grok-build-0.1',
    ]);
    expect(buildProviderRegistrationSeedModels('openai', ['openai/gpt-5.5'], 'openai/gpt-5.5')).toEqual([]);
  });

  test('excludes xAI image and video families from default/fallback model choices', () => {
    const catalog = getSafeXaiChatModelCatalog([]);
    expect(filterXaiChatModels([
      'xai/grok-4.3',
      'xai/grok-imagine-image',
      'xai/grok-imagine-video',
    ], catalog)).toEqual(['xai/grok-4.3']);
  });

  test('allowlists xAI discovery without bulk-adding it to global fallbacks', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-5.5', fallbacks: ['anthropic/claude-haiku-4-5'] },
          models: {},
        },
      },
    }, 'xai', [
      'xai/grok-4.3',
      'xai/account-preview-model',
    ], { version: 2, profiles: {} }, { addFallbacks: false });

    expect(merged.addedAllowlist).toEqual(['xai/grok-4.3', 'xai/account-preview-model']);
    expect(merged.addedFallbacks).toEqual([]);
    expect(merged.config.agents.defaults.model.fallbacks).toEqual(['anthropic/claude-haiku-4-5']);
  });

  test('binds OAuth sessions to the authenticated Portal user or setup context', () => {
    expect(getOAuthRequestOwnerId({ user: { userId: 'user-123' } } as any)).toBe('user:user-123');
    expect(getOAuthRequestOwnerId({} as any)).toBe('setup:pending');
  });

  test('runs concurrent OAuth completion finalization exactly once', async () => {
    const sessionId = `oauth_test_${Date.now()}_${Math.random()}`;
    const action = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    await Promise.all([
      runOAuthCompletionFinalizerOnce(sessionId, action),
      runOAuthCompletionFinalizerOnce(sessionId, action),
    ]);
    await runOAuthCompletionFinalizerOnce(sessionId, action);

    expect(action).toHaveBeenCalledTimes(1);
  });

  test('joins concurrent native CLI completion finalization and retains verified success', async () => {
    const sessionId = `native_finalizer_success_${Date.now()}_${Math.random()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const action = jest.fn(async () => gate);

    const first = runNativeCliCompletionFinalizerOnce(sessionId, action);
    const second = runNativeCliCompletionFinalizerOnce(sessionId, action);
    expect(action).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    await runNativeCliCompletionFinalizerOnce(sessionId, action);

    expect(action).toHaveBeenCalledTimes(1);
  });

  test('shares native CLI finalizer failure and permits a verified retry', async () => {
    const sessionId = `native_finalizer_retry_${Date.now()}_${Math.random()}`;
    let rejectAttempt!: (error: Error) => void;
    const firstAttempt = new Promise<void>((_resolve, reject) => { rejectAttempt = reject; });
    const action = jest.fn()
      .mockImplementationOnce(async () => firstAttempt)
      .mockResolvedValueOnce(undefined);

    const first = runNativeCliCompletionFinalizerOnce(sessionId, action);
    const second = runNativeCliCompletionFinalizerOnce(sessionId, action);
    expect(action).toHaveBeenCalledTimes(1);

    rejectAttempt(new Error('finalizer failed'));
    await expect(first).rejects.toThrow('finalizer failed');
    await expect(second).rejects.toThrow('finalizer failed');

    await expect(runNativeCliCompletionFinalizerOnce(sessionId, action)).resolves.toBeUndefined();
    expect(action).toHaveBeenCalledTimes(2);
  });

  test('retains Claude setup admission for its live session and releases only after terminal credential proof', async () => {
    const ownerId = `user:claude-start-${Date.now()}-${Math.random()}`;
    const sessionId = `claude-session-${Date.now()}-${Math.random()}`;
    let release!: () => void;
    const pending = new Promise<{ success: true; sessionId: string }>((resolve) => {
      release = () => resolve({ success: true, sessionId });
    });
    const starter = jest.fn(async () => pending);
    const session = {
      id: sessionId,
      provider: 'anthropic',
      mode: 'oauth',
      ownerId,
      process: { kill: jest.fn() },
      processExited: false,
      status: 'awaiting_callback',
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      __resetClaudeSetupStartLeaseForTests();
      const first = runClaudeSetupStartOnce(ownerId, starter);
      const second = runClaudeSetupStartOnce(ownerId, starter);
      await expect(runClaudeSetupStartOnce(`${ownerId}:other`, starter)).rejects.toThrow(/already running/i);
      expect(starter).toHaveBeenCalledTimes(1);

      release();
      const expected = { success: true as const, sessionId };
      await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);
      await expect(runClaudeSetupStartOnce(ownerId, starter)).resolves.toEqual(expected);
      expect(starter).toHaveBeenCalledTimes(1);

      session.processExited = true;
      session.credentialResolution = 'indeterminate';
      await expect(runClaudeSetupStartOnce(`${ownerId}:other`, starter)).rejects.toThrow(/already running/i);

      session.credentialResolution = 'absent';
      const replacementStarter = jest.fn(async () => ({ success: true as const, sessionId: `${sessionId}:replacement` }));
      await expect(runClaudeSetupStartOnce(ownerId, replacementStarter)).resolves.toMatchObject({
        success: true,
        sessionId: `${sessionId}:replacement`,
      });
      expect(replacementStarter).toHaveBeenCalledTimes(1);
    } finally {
      __resetClaudeSetupStartLeaseForTests();
      __deleteOAuthSessionForTests(sessionId);
    }
  });

  test('keeps Claude setup-token start and completion free of native CLI import fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai-setup.ts'), 'utf8');
    const claudeRoutes = source.slice(
      source.indexOf("router.post('/claude/start'"),
      source.indexOf("router.post('/save-setup-token'"),
    );

    expect(claudeRoutes).not.toMatch(/importClaudeCliAuthProfile|completeClaudeCliImportForSession|usedCliImport/);
    expect(claudeRoutes).toMatch(/owned setup-token session did not produce a reusable token/);
  });

  test('joins Claude completion and retains only verified success', async () => {
    const sessionId = `claude-complete-${Date.now()}-${Math.random()}`;
    let release!: () => void;
    const pending = new Promise<{ success: true }>((resolve) => {
      release = () => resolve({ success: true });
    });
    const finalizer = jest.fn(async () => pending);

    const first = runClaudeSetupCompletionOnce(sessionId, finalizer);
    const second = runClaudeSetupCompletionOnce(sessionId, finalizer);
    await expect(runClaudeSetupCompletionOnce(`${sessionId}:other`, finalizer)).rejects.toThrow(/already running/i);
    expect(finalizer).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ success: true }, { success: true }]);
    await expect(runClaudeSetupCompletionOnce(sessionId, finalizer)).resolves.toEqual({ success: true });
    expect(finalizer).toHaveBeenCalledTimes(1);
  });

  test('register merge pins Fable 5 to the Claude CLI runtime when Claude OAuth is available', () => {
    const merged = mergeDiscoveredProviderModelsIntoConfig({
      agents: {
        defaults: {
          model: { primary: 'codex/gpt-5.5', fallbacks: [] },
          models: {},
        },
      },
    }, 'anthropic', ['anthropic/claude-fable-5'], {
      version: 2,
      profiles: {
        'anthropic:claude-cli': { provider: 'anthropic', type: 'oauth' },
      },
    });

    expect(merged.changed).toBe(true);
    expect(merged.config.agents.defaults.models['anthropic/claude-fable-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    expect(merged.config.agents.defaults.model.fallbacks).toEqual(['anthropic/claude-fable-5']);
  });

  test('Gemini CLI smoke failures get user-actionable messages', () => {
    expect(classifyProviderRuntimeFailure('FatalAuthenticationError: Manual authorization is required but the current session is non-interactive.')).toContain('server-side auth is not usable headlessly');
    expect(classifyProviderRuntimeFailure('IneligibleTierError: UNSUPPORTED_CLIENT')).toContain('Google rejected this Gemini CLI account/client');
  });
});
