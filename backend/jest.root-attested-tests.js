const fs = require('fs');
const path = require('path');

const rootAttestedTests = [
  'src/agents/providers/native/projectSandbox/CodexProjectEgressRuntime.test.ts',
  'src/agents/providers/native/projectSandbox/CodexProjectSandbox.test.ts',
  'src/agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime.test.ts',
  'src/agents/providers/native/projectSandbox/NativeCliProjectManagedState.test.ts',
  'src/agents/providers/native/projectSandbox/NativeCliProjectProviders.test.ts',
  'src/cli/projectRuntimeUninstallPreflight.test.ts',
  'src/services/hostAgentRunActivationGate.test.ts',
  'src/services/openClawGatewayAuthorizationFence.test.ts',
  'src/services/openclawProjectQualification.test.ts',
  'src/services/projectRuntimeOwnership.test.ts',
  'src/services/remoteDesktopOpenPath.test.ts',
  'src/tests/agentZeroProjectSandbox.test.ts',
  'src/tests/agentZeroSetupControl.test.ts',
  'src/tests/backupContainerFence.test.ts',
  'src/tests/backupQuiescenceTransaction.test.ts',
  'src/tests/backupRequestReceipt.test.ts',
  'src/tests/backupService.test.ts',
  'src/tests/backupStatusReconciliation.test.ts',
  'src/tests/portalSelfUpdateProgress.test.ts',
  'src/tests/systemMaintenanceAdmission.test.ts',
  'src/tests/updatePreparation.test.ts',
];

const seen = new Set();

for (const relativePath of rootAttestedTests) {
  if (
    typeof relativePath !== 'string'
    || path.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.startsWith('../')
    || !relativePath.endsWith('.test.ts')
  ) {
    throw new Error(`Invalid root-attested Jest path: ${String(relativePath)}`);
  }

  if (seen.has(relativePath)) {
    throw new Error(`Duplicate root-attested Jest path: ${relativePath}`);
  }
  seen.add(relativePath);

  const absolutePath = path.join(__dirname, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Root-attested Jest path is not a regular file: ${relativePath}`);
  }
}

module.exports = Object.freeze(rootAttestedTests);
