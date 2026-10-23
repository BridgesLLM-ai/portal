import fs from 'fs';
import path from 'path';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
const root = path.resolve(__dirname, '../../..');
const installer = fs.readFileSync(path.join(root, 'installer/install.sh'), 'utf8');
const pin = (name: string): string => {
  const match = new RegExp(`^readonly ${name}="([^"]+)"$`, 'm').exec(installer);
  if (!match) throw new Error(`Missing installer runtime pin ${name}`);
  return match[1];
};
test('managed runtime and CLI display pins agree with the installer and exact bridge contract', () => {
  expect(PORTAL_TOOL_VERSIONS.openClaw).toBe(pin('PIN_OPENCLAW_CORE_PACKAGE_VERSION'));
  expect(PORTAL_TOOL_VERSIONS.codexCli).toBe(pin('PIN_CODEX_CLI_VERSION'));
  expect(PORTAL_TOOL_VERSIONS.claudeCode).toBe(pin('PIN_CLAUDE_CODE_VERSION'));
  const contract = JSON.parse(fs.readFileSync(path.join(root, `installer/openclaw-${PORTAL_TOOL_VERSIONS.openClaw}-portal-contract.json`), 'utf8'));
  expect(contract.version).toBe(PORTAL_TOOL_VERSIONS.openClaw);
  expect(contract.commit).toBe(pin('PIN_OPENCLAW_CORE_COMMIT'));
  expect(contract.node).toBe(pin('OPENCLAW_NODE_ENGINE_RANGE'));
});
