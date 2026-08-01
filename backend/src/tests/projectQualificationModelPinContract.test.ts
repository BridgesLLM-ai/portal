import fs from 'fs';
import path from 'path';

const routes = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
const qualification = fs.readFileSync(path.resolve(
  __dirname,
  '../services/openclawProjectQualification.ts',
), 'utf8');

function block(source: string, signature: string, terminator: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf(terminator, start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('OpenClaw Project qualification model-pin contract', () => {
  test('the qualify route resolves an explicit OpenClaw model and passes it into qualification', () => {
    const route = block(routes, 'function qualifyProjectChatProviderRoute', '\nrouter.post(');
    expect(route).toContain('resolveAllowedOpenClawProjectModel');
    expect(route).toContain('deriveOpenClawProjectAgentId(executionContext)');
    expect(route).toContain('openClawModel');
    // An explicit request is honored, then an existing verified binding or
    // configured default may seed selection only if exact-agent auth allows it.
    expect(route.indexOf('requestedModel,')).toBeLessThan(route.indexOf("existingBinding?.model || '',"));
    expect(route.indexOf("existingBinding?.model || '',")).toBeLessThan(route.indexOf("getDefaultModel() || '',"));
    expect(route).not.toContain("'openai/gpt-5.6-sol',");
    expect(route.indexOf('ensureOpenClawProjectAgentCatalogScope(executionContext)'))
      .toBeLessThan(route.indexOf('resolveAllowedOpenClawProjectModel'));
  });

  test('production qualification evidence lives outside the replaceable release tree', () => {
    expect(qualification).toContain("process.env.NODE_ENV === 'production'");
    expect(qualification).toContain("'/var/lib/bridgesllm/project-qualifications'");
  });

  test('provider discovery returns the attested model as the browser authority', () => {
    expect(routes).toContain('const qualifiedModels = Object.fromEntries(');
    expect(routes).toContain('requireProjectQualification(provider,');
    expect(routes).toContain('qualifiedModels,');
  });

  test('the model probe pins its session model before the live challenge', () => {
    const probe = block(qualification, 'async function runDefaultModelProbe', '\nasync function ');
    const pinIndex = probe.indexOf('patchSessionModel(input.sessionKey, pinnedModel)');
    const sendIndex = probe.indexOf('provider.sendMessage(');
    expect(pinIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(pinIndex);
  });

  test('the model probe rejects non-embedded agent runtimes before spending a model turn', () => {
    const probe = block(qualification, 'async function runDefaultModelProbe', '\nasync function ');
    const runtimeGuard = probe.indexOf("pinnedRuntimeId !== 'openclaw'");
    const sendIndex = probe.indexOf('provider.sendMessage(');
    expect(runtimeGuard).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(runtimeGuard);
  });

  test('post-turn runtime binding verification precedes the tool-event challenge', () => {
    const probe = block(qualification, 'async function runDefaultModelProbe', '\nasync function ');
    const bindingIndex = probe.indexOf('readVerifiedOpenClawProjectExecutionBinding(session.data)');
    const challengeIndex = probe.indexOf('verifyOpenClawModelToolChallenge({');
    expect(bindingIndex).toBeGreaterThan(-1);
    expect(challengeIndex).toBeGreaterThan(bindingIndex);
    expect(probe).toContain('execution.model !== pinnedModel');
  });
});
