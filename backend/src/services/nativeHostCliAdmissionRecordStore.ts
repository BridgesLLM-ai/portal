/**
 * Pure helpers for admission records (the second accept path of
 * nativeHostCliAdmission.ts), kept for the backend tests that need fixture
 * records. The backend never writes records: toolctl
 * (installer/tools/bridgesllm-toolctl.py, `requalify` and npm updates) is the
 * only writer, as root. A record says the staged official release was verified
 * (registry integrity, `npm audit signatures`, provenance where published) and
 * that the installed tree hashed to the staged tree's digest.
 */
import {
  NATIVE_HOST_CLI_ADMISSION_RECORD_SCHEMA,
  officialNpmTarballUrl,
  parseNativeHostCliAdmissionRecord,
  type NativeHostCliAdmissionRecord,
  type NativeHostCliRecordToolId,
} from './nativeHostCliAdmissionRecord';

/** Tree facts computed with the admission walker (`snapshotTree`). */
export type NativeHostCliTreeFacts = Readonly<{
  treeSha256: string;
  criticalFiles: Readonly<Record<string, string>>;
  hardlinkGroups: readonly (readonly string[])[];
  platformPackageRelative: string | null;
  platformPackageName: string | null;
  platformPackageVersion: string | null;
  platformBinRelative: string | null;
}>;

/** What a verifier proved about the official release, from its staged install. */
export type VerifiedNpmRelease = Readonly<{
  packageName: string;
  version: string;
  tarball: string;
  integrity: string;
  signatures: 'verified';
  provenance: 'verified' | 'unavailable';
  stagedTree: NativeHostCliTreeFacts;
}>;

export type InstalledNativeHostCliTree = Readonly<{
  packageName: string;
  packageRoot: string;
  version: string;
  platform: string;
  tree: NativeHostCliTreeFacts;
}>;

function sameTreeFacts(left: NativeHostCliTreeFacts, right: NativeHostCliTreeFacts): boolean {
  const canonical = (facts: NativeHostCliTreeFacts) => JSON.stringify({
    treeSha256: facts.treeSha256,
    criticalFiles: Object.entries(facts.criticalFiles).sort(([a], [b]) => a.localeCompare(b)),
    hardlinkGroups: facts.hardlinkGroups.map((group) => [...group].sort()).sort(),
    platform: [facts.platformPackageRelative, facts.platformPackageName, facts.platformPackageVersion, facts.platformBinRelative],
  });
  return canonical(left) === canonical(right);
}

/**
 * Builds a record from a verified release and the installed tree. Refuses
 * unless the installed tree is the staged official tree, then round-trips the
 * result through the strict parser so only a valid record can exist.
 */
export function buildNativeHostCliAdmissionRecord(
  toolId: NativeHostCliRecordToolId,
  release: VerifiedNpmRelease,
  installed: InstalledNativeHostCliTree,
  provenanceOf: Readonly<{ admittedBy: string; now: Date }>,
): NativeHostCliAdmissionRecord {
  if (release.packageName !== installed.packageName || release.version !== installed.version) {
    throw new Error(`The verified release ${release.packageName}@${release.version} is not the installed ${installed.packageName}@${installed.version}.`);
  }
  if (release.tarball !== officialNpmTarballUrl(installed.packageName, installed.version)) {
    throw new Error('The verified release did not come from the official npm registry tarball.');
  }
  if (!sameTreeFacts(release.stagedTree, installed.tree)) {
    throw new Error(`The installed ${toolId} ${installed.version} files differ from the official release; it is not admitted.`);
  }
  return parseNativeHostCliAdmissionRecord({
    schema: NATIVE_HOST_CLI_ADMISSION_RECORD_SCHEMA,
    toolId,
    packageName: installed.packageName,
    version: installed.version,
    platform: installed.platform,
    packageRoot: installed.packageRoot,
    treeSha256: installed.tree.treeSha256,
    criticalFiles: { ...installed.tree.criticalFiles },
    hardlinkGroups: installed.tree.hardlinkGroups.map((group) => [...group]),
    platformPackageRelative: installed.tree.platformPackageRelative,
    platformPackageName: installed.tree.platformPackageName,
    platformPackageVersion: installed.tree.platformPackageVersion,
    platformBinRelative: installed.tree.platformBinRelative,
    source: {
      kind: 'npm-registry',
      tarball: release.tarball,
      integrity: release.integrity,
      signatures: release.signatures,
      provenance: release.provenance,
      verifier: 'npm-audit-signatures',
    },
    admittedAt: provenanceOf.now.toISOString(),
    admittedBy: provenanceOf.admittedBy,
  }, {
    toolId,
    packageName: installed.packageName,
    packageRoot: installed.packageRoot,
    platform: installed.platform,
  });
}
