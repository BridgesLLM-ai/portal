import dns from 'dns';
import net from 'net';
import { domainToASCII } from 'url';

export const PROJECT_EGRESS_POLICY_VERSION = 'portal-project-egress-v1';
export const PROJECT_EGRESS_ALLOWED_PORTS = Object.freeze({
  'http:': 80,
  'https:': 443,
} as const);

export const PROJECT_EGRESS_BLOCKED_IPV4_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const);

export const PROJECT_EGRESS_BLOCKED_IPV6_CIDRS = Object.freeze([
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
] as const);

const FORBIDDEN_HOST_SUFFIXES = Object.freeze([
  '.arpa',
  '.example',
  '.home',
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localdomain',
  '.localhost',
  '.onion',
  '.test',
] as const);

export class ProjectEgressPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectEgressPolicyError';
    this.code = code;
  }
}

export interface ProjectEgressLookupRecord {
  address: string;
  family: 4 | 6;
}

export type ProjectEgressResolver = (
  hostname: string,
) => Promise<readonly ProjectEgressLookupRecord[]>;

export interface ProjectEgressTargetPolicy {
  extraDeniedCidrs?: readonly string[];
  resolver?: ProjectEgressResolver;
}

export interface ResolvedProjectEgressTarget {
  url: URL;
  hostname: string;
  port: number;
  addresses: readonly ProjectEgressLookupRecord[];
  selectedAddress: string;
  selectedFamily: 4 | 6;
}

interface ParsedIp {
  family: 4 | 6;
  value: bigint;
}

interface ParsedCidr extends ParsedIp {
  prefix: number;
}

function parseIpv4(address: string): bigint | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(address: string): bigint | null {
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) return null;
  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(?:^|:)([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (ipv4 === null) return null;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    normalized = `${normalized.slice(0, normalized.length - ipv4Match[1].length)}${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function parseIp(address: string): ParsedIp | null {
  const unwrapped = address.startsWith('[') && address.endsWith(']')
    ? address.slice(1, -1)
    : address;
  if (net.isIPv4(unwrapped)) {
    const value = parseIpv4(unwrapped);
    return value === null ? null : { family: 4, value };
  }
  if (net.isIPv6(unwrapped)) {
    const value = parseIpv6(unwrapped);
    return value === null ? null : { family: 6, value };
  }
  return null;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const [address, prefixText, extra] = cidr.split('/');
  if (!address || prefixText === undefined || extra !== undefined) return null;
  const parsed = parseIp(address);
  const prefix = Number(prefixText);
  const maxPrefix = parsed?.family === 4 ? 32 : 128;
  if (!parsed || !Number.isSafeInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  return { ...parsed, prefix };
}

function cidrContains(cidr: ParsedCidr, address: ParsedIp): boolean {
  if (cidr.family !== address.family) return false;
  const bits = address.family === 4 ? 32 : 128;
  if (cidr.prefix === 0) return true;
  const shift = BigInt(bits - cidr.prefix);
  return (cidr.value >> shift) === (address.value >> shift);
}

function requireParsedCidrs(cidrs: readonly string[]): ParsedCidr[] {
  return cidrs.map((cidr) => {
    const parsed = parseCidr(cidr);
    if (!parsed) {
      throw new ProjectEgressPolicyError('INVALID_DENY_CIDR', `Invalid project egress deny CIDR: ${cidr}`);
    }
    return parsed;
  });
}

const BLOCKED_IPV4 = requireParsedCidrs(PROJECT_EGRESS_BLOCKED_IPV4_CIDRS);
const BLOCKED_IPV6 = requireParsedCidrs(PROJECT_EGRESS_BLOCKED_IPV6_CIDRS);
const GLOBAL_IPV6 = requireParsedCidrs(['2000::/3'])[0];

export function isPublicProjectEgressAddress(
  address: string,
  extraDeniedCidrs: readonly string[] = [],
): boolean {
  const parsed = parseIp(address);
  if (!parsed) return false;
  const blocked = parsed.family === 4 ? BLOCKED_IPV4 : BLOCKED_IPV6;
  if (blocked.some((cidr) => cidrContains(cidr, parsed))) return false;
  if (parsed.family === 6 && !cidrContains(GLOBAL_IPV6, parsed)) return false;
  return !requireParsedCidrs(extraDeniedCidrs).some((cidr) => cidrContains(cidr, parsed));
}

function normalizeHostname(rawHostname: string): string {
  const unwrapped = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const withoutTrailingDot = unwrapped.endsWith('.') ? unwrapped.slice(0, -1) : unwrapped;
  if (!withoutTrailingDot || withoutTrailingDot.length > 253 || /[\u0000-\u0020\u007f]/.test(withoutTrailingDot)) {
    throw new ProjectEgressPolicyError('INVALID_HOST', 'Project egress target host is invalid');
  }
  const parsedIp = parseIp(withoutTrailingDot);
  if (parsedIp) return withoutTrailingDot.toLowerCase();
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.includes('.') || ascii.split('.').some((label) => (
    !label
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    throw new ProjectEgressPolicyError('INVALID_HOST', 'Project egress target must use a public DNS hostname');
  }
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => ascii === suffix.slice(1) || ascii.endsWith(suffix))) {
    throw new ProjectEgressPolicyError('PRIVATE_HOSTNAME', 'Project egress target hostname is not public');
  }
  return ascii;
}

export function parseProjectEgressUrl(input: string): {
  url: URL;
  hostname: string;
  port: number;
} {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProjectEgressPolicyError('INVALID_URL', 'Project egress target URL is invalid');
  }
  if (!(url.protocol in PROJECT_EGRESS_ALLOWED_PORTS)) {
    throw new ProjectEgressPolicyError('UNSUPPORTED_SCHEME', 'Project egress allows HTTP and HTTPS only');
  }
  if (url.username || url.password) {
    throw new ProjectEgressPolicyError('URL_CREDENTIALS', 'Project egress URLs cannot contain credentials');
  }
  const protocol = url.protocol as keyof typeof PROJECT_EGRESS_ALLOWED_PORTS;
  const expectedPort = PROJECT_EGRESS_ALLOWED_PORTS[protocol];
  const port = url.port ? Number(url.port) : expectedPort;
  if (!Number.isSafeInteger(port) || port !== expectedPort) {
    throw new ProjectEgressPolicyError('DISALLOWED_PORT', `Project egress ${protocol} targets must use port ${expectedPort}`);
  }
  const hostname = normalizeHostname(url.hostname);
  url.hostname = hostname.includes(':') ? `[${hostname}]` : hostname;
  url.hash = '';
  return { url, hostname, port };
}

const defaultResolver: ProjectEgressResolver = async (hostname) => {
  const literal = parseIp(hostname);
  if (literal) return [{ address: hostname, family: literal.family }];
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
};

export async function resolveProjectEgressTarget(
  input: string,
  policy: ProjectEgressTargetPolicy = {},
): Promise<ResolvedProjectEgressTarget> {
  const { url, hostname, port } = parseProjectEgressUrl(input);
  const records = await (policy.resolver || defaultResolver)(hostname);
  if (!records.length) {
    throw new ProjectEgressPolicyError('DNS_EMPTY', 'Project egress target did not resolve');
  }
  const unique = new Map<string, ProjectEgressLookupRecord>();
  for (const record of records) {
    const parsed = parseIp(record.address);
    if (!parsed || parsed.family !== record.family) {
      throw new ProjectEgressPolicyError('DNS_INVALID', 'Project egress target returned an invalid DNS address');
    }
    if (!isPublicProjectEgressAddress(record.address, policy.extraDeniedCidrs)) {
      throw new ProjectEgressPolicyError('DNS_NON_PUBLIC', 'Project egress target resolved to a non-public address');
    }
    unique.set(`${record.family}:${record.address}`, { address: record.address, family: record.family });
  }
  const addresses = [...unique.values()].sort((a, b) => a.family - b.family || a.address.localeCompare(b.address));
  const selected = addresses[0];
  return {
    url,
    hostname,
    port,
    addresses,
    selectedAddress: selected.address,
    selectedFamily: selected.family,
  };
}

export const __projectEgressPolicyTest = {
  parseIp,
  parseCidr,
  cidrContains,
  normalizeHostname,
};
