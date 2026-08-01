import fs from 'fs';
import path from 'path';

const directory = __dirname;
const bridgeSource = fs.readFileSync(path.join(directory, 'OllamaProjectModelBridge.ts'), 'utf8');
const qualificationSource = fs.readFileSync(path.join(directory, 'OllamaProjectQualification.ts'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(directory, 'OllamaProjectToolRuntime.ts'), 'utf8');
const providerSource = fs.readFileSync(path.join(directory, 'OllamaProjectProvider.ts'), 'utf8');
const backendSourceRoot = path.resolve(directory, '../../..');
const authoritySource = fs.readFileSync(
  path.join(backendSourceRoot, 'services/ollamaBackendAuthority.ts'),
  'utf8',
);
const modelSource = fs.readFileSync(
  path.join(backendSourceRoot, 'services/ollamaProjectModel.ts'),
  'utf8',
);
const projectRoutesSource = fs.readFileSync(
  path.join(backendSourceRoot, 'routes/projects.ts'),
  'utf8',
);
const installerSource = fs.readFileSync(
  path.resolve(backendSourceRoot, '../../installer/install.sh'),
  'utf8',
);

describe('Ollama Project security static contract', () => {
  test('installer attests the networkless tool image without requiring local Ollama', () => {
    const start = installerSource.indexOf('ensure_ollama_project_sandbox_image() {');
    const end = installerSource.indexOf('\nensure_agent_zero_project_sandbox_image() {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const ensureImage = installerSource.slice(start, end);

    expect(ensureImage).toContain('command -v docker');
    expect(ensureImage).toContain('verify_ollama_project_sandbox_image');
    expect(ensureImage).toContain('record_installer_image_id');
    expect(ensureImage).not.toContain('$SKIP_OLLAMA');
    expect(ensureImage).not.toContain('command -v ollama');
    expect(ensureImage).not.toContain('clear_installer_image_id');
  });

  test('tool container is networkless and carries no model or proxy credential path', () => {
    expect(runtimeSource).toContain("'--network', 'none'");
    expect(runtimeSource).toContain("host.NetworkMode !== 'none'");
    expect(runtimeSource).toContain('exactly one writable Project bind');
    expect(runtimeSource).toContain("'--cap-drop', 'ALL'");
    expect(runtimeSource).toContain("'no-new-privileges:true'");
    expect(runtimeSource).not.toMatch(/HTTP_PROXY|HTTPS_PROXY|host\.docker\.internal|docker\.sock/);
  });

  test('model bridge has an exact loopback API allowlist and no model mutation endpoint', () => {
    expect(bridgeSource).toContain("'/api/tags' | '/api/show' | '/api/chat'");
    expect(bridgeSource).toContain("server.listen(0, '127.0.0.1'");
    expect(bridgeSource).toContain('crypto.timingSafeEqual');
    expect(bridgeSource).not.toMatch(/\/api\/(?:pull|push|create|delete|copy|generate)/);
  });

  test('provider requires a real tool probe instead of text-only model parity', () => {
    expect(providerSource).toContain('did not prove native tool-call capability');
    expect(providerSource).toContain("capabilities.includes('tools')");
    expect(providerSource).toContain("type: 'tool_start'");
    expect(providerSource).toContain("type: 'tool_update'");
    expect(providerSource).toContain("type: 'tool_end'");
  });

  test('qualification and turns stay centralized-authority and backend identity pinned', () => {
    expect(projectRoutesSource).toContain(
      '? await resolveAllowedOllamaProjectModel(',
    );
    expect(modelSource).toContain('resolveOllamaBackendAuthority');
    expect(modelSource).toContain('requestResolvedOllamaJson');
    expect(authoritySource).toContain('if (bindingView.authority)');
    expect(authoritySource).toContain("if (!local.enabled) throw authorityError('LOCAL_DISABLED'");
    expect(qualificationSource).toContain('backendFingerprint: input.proof.backendFingerprint');
    expect(bridgeSource).toContain('assertAuthorityMatches(scope, await resolveAuthority())');
    expect(bridgeSource).toContain('const upstream = await requestResolved(resolved');
    expect(bridgeSource).toContain('const upstream = await streamResolved(');
    expect(bridgeSource).toContain('await relayStreamChunk(res, chunk, controller)');
    expect(providerSource).toContain('expectedBackend.backendFingerprint !== proof.backendFingerprint');
    expect(providerSource).toContain('expectedBackend.backendGeneration !== proof.backendGeneration');
  });
});
