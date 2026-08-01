import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  encodeSignedReleaseEvidence,
  verifySignedReleaseDetails,
  verifyStoredReleaseEvidence,
} from './releaseUpdateDetails';

const VERSION = '4.1.0';

type ManifestVector = {
  name: string;
  accepted: boolean;
  highlights?: string[];
  repeatHighlight?: { value: string; count: number };
  lineMutation?: 'internal-blank-after-schema' | 'leading-blank' | 'extra-trailing-blank';
};

const manifestVectors = (JSON.parse(fs.readFileSync(path.resolve(
  __dirname,
  '../../../scripts/validation/fixtures/release-manifest-vectors.json',
), 'utf8')) as { cases: ManifestVector[] }).cases;

function vectorHighlights(vector: ManifestVector): string[] {
  if (vector.repeatHighlight) {
    return [vector.repeatHighlight.value.repeat(vector.repeatHighlight.count)];
  }
  return vector.highlights || [];
}

function vectorManifest(vector: ManifestVector): Buffer {
  const highlights = Buffer.from(JSON.stringify(vectorHighlights(vector)), 'utf8').toString('base64url');
  const lines = [
    'schema=2',
    `version=${VERSION}`,
    'artifact=portal.tar.gz',
    `sha256=${'a'.repeat(64)}`,
    'size=12345',
    'released=2026-07-20',
    'release_class=feature',
    `highlights=${highlights}`,
  ];
  if (vector.lineMutation === 'internal-blank-after-schema') lines.splice(1, 0, '');
  if (vector.lineMutation === 'leading-blank') lines.unshift('');
  return Buffer.from(`${lines.join('\n')}\n${vector.lineMutation === 'extra-trailing-blank' ? '\n' : ''}`, 'utf8');
}

function fixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const expectedPublicKeySha256 = crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  const highlights = Buffer.from(JSON.stringify([
    'Project Chat now supports qualified provider lanes.',
    'Update details are verified before display.',
  ]), 'utf8').toString('base64url');
  const manifest = Buffer.from([
    'schema=2',
    `version=${VERSION}`,
    'artifact=portal.tar.gz',
    `sha256=${'a'.repeat(64)}`,
    'size=12345',
    'released=2026-07-20',
    'release_class=feature',
    `highlights=${highlights}`,
    '',
  ].join('\n'), 'utf8');
  const signature = crypto.sign(null, manifest, privateKey);
  const trustRoot = { publicKey, expectedPublicKeySha256 };
  return { manifest, signature, trustRoot };
}

describe('signed dashboard update details', () => {
  test.each(manifestVectors)('matches the installer golden vector: $name', (vector) => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const expectedPublicKeySha256 = crypto.createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    const manifest = vectorManifest(vector);
    const result = verifySignedReleaseDetails(
      manifest,
      crypto.sign(null, manifest, privateKey),
      VERSION,
      { publicKey, expectedPublicKeySha256 },
    );
    expect(Boolean(result)).toBe(vector.accepted);
    if (vector.accepted) expect(result?.highlights).toEqual(vectorHighlights(vector));
  });

  test('accepts only bounded metadata covered by the release signature', () => {
    const { manifest, signature, trustRoot } = fixture();
    expect(verifySignedReleaseDetails(manifest, signature, VERSION, trustRoot)).toEqual({
      version: VERSION,
      releasedAt: '2026-07-20',
      releaseClass: 'feature',
      highlights: [
        'Project Chat now supports qualified provider lanes.',
        'Update details are verified before display.',
      ],
      provenance: 'signed-release-manifest',
    });
  });

  test('rejects tampering, wrong trust roots, and a version mismatch', () => {
    const { manifest, signature, trustRoot } = fixture();
    const tampered = Buffer.from(manifest.toString('utf8').replace('feature', 'hotfix'));
    expect(verifySignedReleaseDetails(tampered, signature, VERSION, trustRoot)).toBeNull();
    expect(verifySignedReleaseDetails(manifest, signature, '4.1.1', trustRoot)).toBeNull();
    expect(verifySignedReleaseDetails(manifest, signature, VERSION, {
      ...trustRoot,
      expectedPublicKeySha256: '0'.repeat(64),
    })).toBeNull();
  });

  test('does not treat legacy manifests or unbounded highlights as display metadata', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const expectedPublicKeySha256 = crypto.createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    const trustRoot = { publicKey, expectedPublicKeySha256 };
    const legacy = Buffer.from([
      'schema=1',
      `version=${VERSION}`,
      'artifact=portal.tar.gz',
      `sha256=${'a'.repeat(64)}`,
      'size=12345',
      '',
    ].join('\n'));
    expect(verifySignedReleaseDetails(legacy, crypto.sign(null, legacy, privateKey), VERSION, trustRoot)).toBeNull();

    const oversized = Buffer.from(JSON.stringify(Array.from({ length: 6 }, (_, i) => `Highlight ${i}`)))
      .toString('base64url');
    const invalid = Buffer.from([
      'schema=2',
      `version=${VERSION}`,
      'artifact=portal.tar.gz',
      `sha256=${'a'.repeat(64)}`,
      'size=12345',
      'released=2026-07-20',
      'release_class=feature',
      `highlights=${oversized}`,
      '',
    ].join('\n'));
    expect(verifySignedReleaseDetails(invalid, crypto.sign(null, invalid, privateKey), VERSION, trustRoot)).toBeNull();
  });

  test('re-verifies cached evidence instead of trusting parsed database prose', () => {
    const { manifest, signature, trustRoot } = fixture();
    const evidence = encodeSignedReleaseEvidence(manifest, signature);
    expect(evidence).not.toBeNull();
    expect(verifyStoredReleaseEvidence(evidence, VERSION, trustRoot)?.releaseClass).toBe('feature');

    const parsed = JSON.parse(evidence!);
    parsed.manifest = Buffer.from(
      Buffer.from(parsed.manifest, 'base64url').toString('utf8').replace('feature', 'security'),
    ).toString('base64url');
    expect(verifyStoredReleaseEvidence(JSON.stringify(parsed), VERSION, trustRoot)).toBeNull();
  });
});
