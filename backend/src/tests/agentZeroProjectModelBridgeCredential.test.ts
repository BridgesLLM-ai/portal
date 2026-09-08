import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  agentZeroProjectModelBridgeCredentialPath,
  authenticateAgentZeroProjectModelBridgeCredential,
  issueAgentZeroProjectModelBridgeCredential,
  readAgentZeroProjectModelBridgeCredentialRecord,
  revokeAgentZeroProjectModelBridgeCredential,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';

const PROJECT_KEY = 'a'.repeat(64);
const TOKEN_RANDOM = 'B'.repeat(43);
const NOW = Date.parse('2026-07-20T04:00:00.000Z');
const TEST_OWNER_UID = typeof process.getuid === 'function' ? process.getuid() : 0;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-project-model-bridge-credentials-'));
  fs.chmodSync(root, 0o750);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function issue(random = TOKEN_RANDOM) {
  return issueAgentZeroProjectModelBridgeCredential({
    projectKey: PROJECT_KEY,
    actorUserId: 'owner-user-id',
    projectIdentityId: '11111111-1111-4111-8111-111111111111',
  }, {
    providerId: 'codex_oauth',
    model: 'gpt-5.2-codex',
  }, {
    credentialRoot: root,
    now: () => NOW,
    tokenFactory: () => random,
    generationFactory: () => '22222222-2222-4222-8222-222222222222',
    expectedOwnerUid: TEST_OWNER_UID,
  });
}

describe('Agent Zero Project model bridge credentials', () => {
  test('stores only a protected hash and authenticates the exact provider binding', () => {
    const credential = issue();
    const filePath = agentZeroProjectModelBridgeCredentialPath(PROJECT_KEY, root);
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain(credential.token);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o640);
    expect(readAgentZeroProjectModelBridgeCredentialRecord(PROJECT_KEY, {
      credentialRoot: root,
      expectedOwnerUid: TEST_OWNER_UID,
    })).toEqual(credential.record);
    expect(authenticateAgentZeroProjectModelBridgeCredential(
      credential.token,
      'codex_oauth',
      { credentialRoot: root, now: () => NOW + 1, expectedOwnerUid: TEST_OWNER_UID },
    )).toEqual(credential.record);
    expect(authenticateAgentZeroProjectModelBridgeCredential(
      credential.token,
      'xai_grok_oauth',
      { credentialRoot: root, now: () => NOW + 1, expectedOwnerUid: TEST_OWNER_UID },
    )).toBeNull();
  });

  test('rotation atomically revokes the old bearer and accepts only the new generation', () => {
    const first = issue('B'.repeat(43));
    const second = issueAgentZeroProjectModelBridgeCredential({
      projectKey: PROJECT_KEY,
      actorUserId: 'owner-user-id',
      projectIdentityId: '11111111-1111-4111-8111-111111111111',
    }, {
      providerId: 'xai_grok_oauth',
      model: 'grok-code-fast-1',
    }, {
      credentialRoot: root,
      now: () => NOW + 1000,
      tokenFactory: () => 'C'.repeat(43),
      generationFactory: () => '33333333-3333-4333-8333-333333333333',
      expectedOwnerUid: TEST_OWNER_UID,
    });
    expect(authenticateAgentZeroProjectModelBridgeCredential(
      first.token,
      'codex_oauth',
      { credentialRoot: root, now: () => NOW + 2000, expectedOwnerUid: TEST_OWNER_UID },
    )).toBeNull();
    expect(authenticateAgentZeroProjectModelBridgeCredential(
      second.token,
      'xai_grok_oauth',
      { credentialRoot: root, now: () => NOW + 2000, expectedOwnerUid: TEST_OWNER_UID },
    )?.generation).toBe('33333333-3333-4333-8333-333333333333');
  });

  test('expiry, tampering, permissive modes, and revocation fail closed', () => {
    const credential = issue();
    expect(authenticateAgentZeroProjectModelBridgeCredential(
      credential.token,
      'codex_oauth',
      {
        credentialRoot: root,
        now: () => Date.parse(credential.record.expiresAt),
        expectedOwnerUid: TEST_OWNER_UID,
      },
    )).toBeNull();

    const filePath = agentZeroProjectModelBridgeCredentialPath(PROJECT_KEY, root);
    fs.chmodSync(filePath, 0o666);
    expect(() => readAgentZeroProjectModelBridgeCredentialRecord(PROJECT_KEY, {
      credentialRoot: root,
      expectedOwnerUid: TEST_OWNER_UID,
    })).toThrow(/not protected/i);
    fs.chmodSync(filePath, 0o640);
    expect(revokeAgentZeroProjectModelBridgeCredential(PROJECT_KEY, {
      credentialRoot: root,
      expectedOwnerUid: TEST_OWNER_UID,
    })).toBe(true);
    expect(revokeAgentZeroProjectModelBridgeCredential(PROJECT_KEY, {
      credentialRoot: root,
      expectedOwnerUid: TEST_OWNER_UID,
    })).toBe(false);
    expect(authenticateAgentZeroProjectModelBridgeCredential(
      credential.token,
      'codex_oauth',
      { credentialRoot: root, now: () => NOW + 1, expectedOwnerUid: TEST_OWNER_UID },
    )).toBeNull();
  });
});
