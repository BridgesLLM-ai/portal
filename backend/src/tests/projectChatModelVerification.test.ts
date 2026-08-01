import fs from 'fs';
import path from 'path';

function routeBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\nrouter.', start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('Project Chat OpenClaw model verification wiring', () => {
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
  const panel = fs.readFileSync(
    path.resolve(__dirname, '../../../frontend/src/components/chat/ProjectChatPanel.tsx'),
    'utf8',
  );

  test('switch, ensure, and send persist only through verified runtime readback', () => {
    const providerSwitch = routeBlock(routes, "router.post('/:name/chat/provider'");
    const ensureSession = routeBlock(routes, "router.post('/:name/assistant/ensure-session'");
    const send = routeBlock(routes, "router.post('/:name/assistant/send'");

    for (const block of [providerSwitch, ensureSession, send]) {
      expect(block).toContain('verifyAndPersistOpenClawProjectModel');
      expect(block).not.toContain('await patchSessionModel(');
    }
    expect(providerSwitch).toContain("modelVerified: provider === 'OPENCLAW' ? true");
    expect(ensureSession).toContain('modelVerified: true');
    expect(send).toContain('modelVerified: true');
    expect(routes).not.toContain("import { patchSessionModel");
    expect(providerSwitch).toContain('resolveAllowedOpenClawProjectModel');
    expect(routes).toContain('failProviderClosed: async () =>');
    expect(routes).toContain("status: 'error'");
  });

  test('active-model returns only authoritative verified model metadata', () => {
    const activeModel = routeBlock(routes, "router.get('/:name/assistant/active-model'");

    expect(activeModel).toContain('readVerifiedOpenClawSessionModel');
    expect(activeModel).toContain('verified: true');
    expect(activeModel).toContain("'PROJECT_MODEL_VERIFICATION_FAILED'");
    expect(activeModel).not.toContain('showing configured default model');
    expect(activeModel).toContain('activeModel: null');
    expect(activeModel).toContain('configuredModel');
  });

  test('session status never fabricates provider/model defaults from stale metadata', () => {
    const sessionStatus = routeBlock(routes, "router.get('/:name/chat/session-status'");

    expect(sessionStatus).toContain('readVerifiedOpenClawSessionModel');
    expect(sessionStatus).toContain('modelVerified: true');
    expect(sessionStatus).toContain('modelVerified: false');
    expect(sessionStatus).not.toContain("result.data.modelProvider || 'anthropic'");
    expect(sessionStatus).not.toContain("result.data.model || 'claude-sonnet-4-6'");
  });

  test('Project model discovery exposes only a live verified catalog', () => {
    const modelCatalog = routeBlock(routes, "router.get('/models/available'");
    const projectAgentCatalog = routeBlock(routes, "'/:name/chat/models',");

    expect(modelCatalog).toContain('verified: true');
    expect(modelCatalog).toContain('m?.available === false');
    expect(modelCatalog).toContain('m?.missing === true');
    expect(modelCatalog).toContain('m?.key');
    expect(modelCatalog).toContain("status(503)");
    expect(modelCatalog).toContain("'PROJECT_MODEL_CATALOG_UNAVAILABLE'");
    expect(modelCatalog).not.toContain('fallback: true');
    expect(modelCatalog).not.toContain("{ id: 'openai/gpt-5.6-sol'");
    expect(projectAgentCatalog).toContain('deriveOpenClawProjectAgentId(executionContext)');
    expect(projectAgentCatalog).toContain('listAvailableOpenClawProjectModels');
    expect(projectAgentCatalog).toContain("'Cache-Control', 'private, no-store, max-age=0'");
    expect(panel).toContain('projectsAPI.projectChatModels(projectName)');
  });

  test('explicit unavailable models are rejected before a Project binding can be changed', () => {
    const providerSwitch = routeBlock(routes, "router.post('/:name/chat/provider'");
    const ensureSession = routeBlock(routes, "router.post('/:name/assistant/ensure-session'");

    for (const block of [providerSwitch, ensureSession]) {
      expect(block.indexOf('ensureOpenClawProjectAgentCatalogScope'))
        .toBeLessThan(block.indexOf('resolveAllowedOpenClawProjectModel'));
      expect(block.indexOf('resolveAllowedOpenClawProjectModel'))
        .toBeLessThan(block.indexOf('ensureOpenClawProjectRuntime'));
    }
  });

  test('frontend validates model responses through server-declared capabilities', () => {
    expect(panel).toContain('if (!capability.supportsModelSelection) return');
    expect(panel).toContain('data?.modelValidated !== true || !model');
    expect(panel).toContain('resolveVerifiedProjectModelResponse(providerCapability, data)');
    expect(panel).not.toContain("provider === 'CODEX' && (data?.modelConfigured");
    expect(panel).toContain("modelData?.verified === true");
  });
});
