import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DEFAULT_STALWART_URL = 'http://127.0.0.1:8580';
const DKIM_METADATA_FILE = 'dkim-public-records.json';
const LEGACY_DKIM_RECORD_FILE = 'dkim-dns-record.txt';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024;

type FetchLike = typeof fetch;

interface DkimSpec {
  algorithm: 'Rsa' | 'Ed25519';
  keyType: 'rsa' | 'ed25519';
  signatureId: string;
  selector: string;
}

export interface StalwartDkimDnsRecord {
  algorithm: 'rsa' | 'ed25519';
  signatureId: string;
  selector: string;
  name: string;
  value: string;
}

interface StoredDkimMetadata {
  schemaVersion: 1;
  domain: string;
  generatedAt: string;
  records: StalwartDkimDnsRecord[];
}

export interface ProvisionStalwartDkimOptions {
  domain: string;
  adminPass: string;
  mailDir: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  if (
    normalized.length < 3
    || normalized.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
    || normalized.includes('..')
    || !normalized.includes('.')
  ) {
    throw new Error('Stalwart DKIM provisioning requires a valid DNS domain');
  }
  return normalized;
}

function validateLoopbackUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('Stalwart management API must use a loopback HTTP address');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function specsForDomain(domain: string): DkimSpec[] {
  return [
    {
      algorithm: 'Rsa',
      keyType: 'rsa',
      signatureId: `portal-rsa-${domain}`,
      selector: 'portal-rsa',
    },
    {
      algorithm: 'Ed25519',
      keyType: 'ed25519',
      signatureId: `portal-ed25519-${domain}`,
      selector: 'portal-ed25519',
    },
  ];
}

function validatePublicKey(keyType: DkimSpec['keyType'], value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`Stalwart returned an invalid ${keyType} DKIM public key`);
  }
  if (keyType === 'rsa' && value.length < 300) {
    throw new Error('Stalwart returned an unexpectedly short RSA DKIM public key');
  }
  if (keyType === 'ed25519' && value.length !== 44) {
    throw new Error('Stalwart returned an invalid Ed25519 DKIM public key length');
  }
  return value;
}

async function readBoundedJson(response: Awaited<ReturnType<FetchLike>>): Promise<any> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Stalwart management API returned an oversized response');
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Stalwart management API returned malformed JSON');
  }
}

async function requestStalwart(
  baseUrl: string,
  adminPass: string,
  requestPath: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<{ status: number; ok: boolean; body: any }> {
  const response = await fetchImpl(`${baseUrl}${requestPath}`, {
    ...init,
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await readBoundedJson(response),
  };
}

async function readExistingPublicKey(
  baseUrl: string,
  adminPass: string,
  spec: DkimSpec,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const response = await requestStalwart(
    baseUrl,
    adminPass,
    `/api/dkim/${encodeURIComponent(spec.signatureId)}`,
    { method: 'GET' },
    fetchImpl,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Stalwart could not verify ${spec.keyType} DKIM state (HTTP ${response.status})`);
  }
  return validatePublicKey(spec.keyType, response.body?.data);
}

async function ensureSignature(
  baseUrl: string,
  adminPass: string,
  domain: string,
  spec: DkimSpec,
  fetchImpl: FetchLike,
): Promise<StalwartDkimDnsRecord> {
  let publicKey = await readExistingPublicKey(baseUrl, adminPass, spec, fetchImpl);
  if (!publicKey) {
    const createResponse = await requestStalwart(
      baseUrl,
      adminPass,
      '/api/dkim',
      {
        method: 'POST',
        body: JSON.stringify({
          id: spec.signatureId,
          algorithm: spec.algorithm,
          domain,
          selector: spec.selector,
        }),
      },
      fetchImpl,
    );

    // A concurrent setup request can win the create race. In either case,
    // success means the exact Portal-owned signature must now be readable.
    if (!createResponse.ok && createResponse.status !== 409) {
      publicKey = await readExistingPublicKey(baseUrl, adminPass, spec, fetchImpl).catch(() => null);
      if (!publicKey) {
        throw new Error(`Stalwart could not create ${spec.keyType} DKIM state (HTTP ${createResponse.status})`);
      }
    } else {
      publicKey = await readExistingPublicKey(baseUrl, adminPass, spec, fetchImpl);
    }
  }

  if (!publicKey) {
    throw new Error(`Stalwart did not persist the ${spec.keyType} DKIM signature`);
  }

  return {
    algorithm: spec.keyType,
    signatureId: spec.signatureId,
    selector: spec.selector,
    name: `${spec.selector}._domainkey`,
    value: `v=DKIM1; k=${spec.keyType}; p=${publicKey}`,
  };
}

function atomicWrite(filePath: string, contents: string, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, mode);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function persistPublicMetadata(mailDir: string, domain: string, records: StalwartDkimDnsRecord[]): void {
  const metadata: StoredDkimMetadata = {
    schemaVersion: 1,
    domain,
    generatedAt: new Date().toISOString(),
    records,
  };
  atomicWrite(path.join(mailDir, DKIM_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, 0o600);

  const rsaRecord = records.find(record => record.algorithm === 'rsa');
  if (rsaRecord) {
    // Keep the old public-record filename accurate for older maintenance tooling.
    atomicWrite(path.join(mailDir, LEGACY_DKIM_RECORD_FILE), `${rsaRecord.value}\n`, 0o600);
  }

  // Older Portal versions created an unused private key beside the mail store.
  // It is not trusted or used, but tighten its permissions if it is still present.
  try { fs.chmodSync(path.join(mailDir, 'dkim.key'), 0o600); } catch {}
}

export function getStalwartDkimSigningConfig(): string {
  return `[auth.dkim.sign]\n"0.if" = "is_local_domain(sender_domain)"\n"0.then" = '["portal-rsa-" + sender_domain, "portal-ed25519-" + sender_domain]'\n"1.else" = "false"`;
}

export async function provisionStalwartDkim(
  options: ProvisionStalwartDkimOptions,
): Promise<StalwartDkimDnsRecord[]> {
  const domain = normalizeDomain(options.domain);
  if (!options.adminPass) throw new Error('Stalwart admin credentials are unavailable');
  const baseUrl = validateLoopbackUrl(options.baseUrl || process.env.STALWART_URL || DEFAULT_STALWART_URL);
  const fetchImpl = options.fetchImpl || fetch;

  const records: StalwartDkimDnsRecord[] = [];
  for (const spec of specsForDomain(domain)) {
    records.push(await ensureSignature(baseUrl, options.adminPass, domain, spec, fetchImpl));
  }
  persistPublicMetadata(options.mailDir, domain, records);
  return records;
}

export function readStoredStalwartDkimRecords(mailDir: string, rawDomain: string): StalwartDkimDnsRecord[] {
  const domain = normalizeDomain(rawDomain);
  try {
    const raw = fs.readFileSync(path.join(mailDir, DKIM_METADATA_FILE), 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) return [];
    const parsed = JSON.parse(raw) as StoredDkimMetadata;
    if (parsed.schemaVersion !== 1 || parsed.domain !== domain || !Array.isArray(parsed.records)) return [];
    const expected = specsForDomain(domain);
    if (parsed.records.length !== expected.length) return [];

    return expected.map(spec => {
      const record = parsed.records.find(candidate => candidate.signatureId === spec.signatureId);
      if (
        !record
        || record.algorithm !== spec.keyType
        || record.selector !== spec.selector
        || record.name !== `${spec.selector}._domainkey`
        || typeof record.value !== 'string'
        || !record.value.startsWith(`v=DKIM1; k=${spec.keyType}; p=`)
      ) {
        throw new Error('Stored DKIM metadata does not match the Portal signature contract');
      }
      validatePublicKey(spec.keyType, record.value.slice(record.value.indexOf('p=') + 2));
      return record;
    });
  } catch {
    return [];
  }
}
