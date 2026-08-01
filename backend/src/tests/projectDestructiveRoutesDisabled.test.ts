import fs from 'fs';
import path from 'path';
import projectsRouter from '../routes/projects';
import { LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE } from '../services/legacyOpenClawRetirementPolicy';

const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');

type RouteMethod = 'delete' | 'post';

function routeBlock(signature: string): string {
  const start = routeSource.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = routeSource.indexOf('\nrouter.', start + signature.length);
  return routeSource.slice(start, next === -1 ? routeSource.length : next);
}

function destructiveRouteHandler(method: RouteMethod, routePath: string) {
  const layer = (projectsRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === routePath
    && candidate.route?.methods?.[method] === true
  ));
  expect(layer).toBeDefined();
  const handlers = layer.route.stack;
  expect(handlers.length).toBeGreaterThan(0);
  return handlers[handlers.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: () => void,
  ) => unknown;
}

describe('Portal 4.0 bounded destructive Project admission', () => {
  test.each([
    ['delete', '/:name/chat/history'],
    ['post', '/:name/assistant/reset'],
  ] as const)('%s %s keeps the stable release gate before inspecting the request', async (method, routePath) => {
    const handler = destructiveRouteHandler(method, routePath);
    const request = new Proxy(Object.create(null), {
      get(_target, property) {
        throw new Error(`destructive chat-reset route inspected request property ${String(property)}`);
      },
    });
    const json = jest.fn();
    const response = {
      status: jest.fn(),
      json,
    };
    response.status.mockReturnValue(response);
    const next = jest.fn();

    await handler(request, response, next);

    expect(response.status).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      error: LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE,
      code: 'LEGACY_OPENCLAW_PROJECT_RETIREMENT_PENDING',
      retryable: false,
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('fresh CURRENT identities follow the create-to-rename-to-delete route lane', () => {
    const create = routeBlock("router.post('/', authenticateToken");
    const rename = routeBlock("router.patch('/:name/rename'");
    const deletion = routeBlock("router.delete('/:name'");

    expect(create).toContain('createCurrentProjectIdentity({');
    expect(create).toContain('finalizeCurrentProjectIdentityCreation({');

    for (const mutation of [rename, deletion]) {
      expect(mutation).toContain('requireCurrentProjectDestructiveIdentity(');
      expect(mutation).toContain('assertLegacyOpenClawProjectMigrationInactive(');
      expect(mutation).not.toContain('rejectDestructiveProjectChatResetRouteForRelease');
      expect(mutation).not.toContain('assertLegacyOpenClawProjectDestructiveMutationSafe');
    }
    expect(rename.indexOf('requireCurrentProjectDestructiveIdentity('))
      .toBeLessThan(rename.indexOf('renameGrant = await beginProjectIdentityRename({'));
    expect(deletion.indexOf('requireCurrentProjectDestructiveIdentity('))
      .toBeLessThan(deletion.indexOf('await beginProjectIdentityDeletion({'));
  });

  test('project inventory exposes destructive capability before the user can act', () => {
    const inventory = routeBlock("router.get('/', authenticateToken");
    expect(routeSource).toContain("const allowed = identity.legacyOpenClawMigrationStatus === 'CURRENT';");
    expect(inventory).toContain('destructiveActions: projectDestructiveActionCapability(identity)');
    expect(routeSource).toContain('Move this older project into a new Portal project before renaming or deleting it.');
  });

  test('older Project Chat returns a routine move card before provider state is touched', () => {
    const providers = routeBlock("router.get('/:name/chat/providers'");
    const moveBranch = providers.indexOf("projectIdentity.legacyOpenClawMigrationStatus !== 'CURRENT'");
    const moveResponse = providers.indexOf('migration: {', moveBranch);
    const providerFence = providers.indexOf(
      'await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id)',
    );
    const providerRead = providers.indexOf('resolveProjectChatQualificationMatrix(');

    expect(moveBranch).toBeGreaterThan(-1);
    expect(moveResponse).toBeGreaterThan(moveBranch);
    expect(providers).toContain('required: true');
    expect(providers).toContain("title: 'Prepare this project for Project Chat'");
    expect(providers).toContain('message: PROJECT_CHAT_MOVE_REQUIRED_MESSAGE');
    expect(moveResponse).toBeLessThan(providerFence);
    expect(providerFence).toBeLessThan(providerRead);
    expect(providers.slice(moveBranch, providerFence)).toContain('res.json({');
    expect(providers.slice(moveBranch, providerFence)).toContain('return;');
  });

  test('/:name/share rejects unavailable app hosting before inspecting the request', async () => {
    const previousOriginMode = process.env.ORIGIN_MODE;
    const previousAppOrigin = process.env.APP_CONTENT_ORIGIN;
    process.env.ORIGIN_MODE = 'tailnet';
    delete process.env.APP_CONTENT_ORIGIN;
    try {
      const handler = destructiveRouteHandler('post', '/:name/share');
      const request = new Proxy(Object.create(null), {
        get(_target, property) {
          throw new Error(`Tailnet app-hosting guard inspected request property ${String(property)}`);
        },
      });
      const json = jest.fn();
      const response = {
        status: jest.fn(),
        json,
      };
      response.status.mockReturnValue(response);
      const next = jest.fn();

      await handler(request, response, next);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'PORTAL_FEATURE_UNAVAILABLE',
        feature: 'appHosting',
        retryable: false,
      }));
      expect(next).not.toHaveBeenCalled();
    } finally {
      if (previousOriginMode === undefined) delete process.env.ORIGIN_MODE;
      else process.env.ORIGIN_MODE = previousOriginMode;
      if (previousAppOrigin === undefined) delete process.env.APP_CONTENT_ORIGIN;
      else process.env.APP_CONTENT_ORIGIN = previousAppOrigin;
    }
  });

  test('/:name/deploy preserves Remote Desktop runtimes and gates hosted deployment before mutation', () => {
    const deploy = routeBlock("router.post('/:name/deploy'");
    const detection = deploy.indexOf('const deployType = detectDeployType(projectDir)');
    const hostedBranch = deploy.indexOf("if (deployType !== 'runtime')");
    const guard = deploy.indexOf("portalFeatureUnavailableResponse('appHosting')");
    const identityMutation = deploy.indexOf('const projectIdentity = await ensureProjectIdentity({');
    const databaseRead = deploy.indexOf('const existingProjectApp = await findProjectAppForIdentity({');
    const staticCopy = deploy.indexOf('copyStaticDeploymentTree(sourceDir, deployPath)');

    expect(detection).toBeGreaterThan(-1);
    expect(hostedBranch).toBeGreaterThan(detection);
    expect(guard).toBeGreaterThan(hostedBranch);
    expect(guard).toBeLessThan(identityMutation);
    expect(guard).toBeLessThan(databaseRead);
    expect(guard).toBeLessThan(staticCopy);
  });

  test('Tailnet share maintenance permits cleanup but gates exposure and email before mutation', () => {
    const update = routeBlock("router.patch('/:name/share/:linkId'");
    const cleanupOnly = update.indexOf('const cleanupOnly =');
    const updateGuard = update.indexOf("portalFeatureUnavailableResponse('appHosting')");
    const updateOwnerLookup = update.indexOf('const ownerId = await getScopedOwnerId(req)');
    expect(cleanupOnly).toBeGreaterThan(-1);
    expect(updateGuard).toBeGreaterThan(cleanupOnly);
    expect(updateGuard).toBeLessThan(updateOwnerLookup);

    const email = routeBlock("router.post('/:name/share/:linkId/email'");
    const hostingGuard = email.indexOf("portalFeatureUnavailableResponse('appHosting')");
    const mailGuard = email.indexOf("portalFeatureUnavailableResponse('mail')");
    const emailOwnerLookup = email.indexOf('const ownerId = await getScopedOwnerId(req)');
    expect(hostingGuard).toBeGreaterThan(-1);
    expect(mailGuard).toBeGreaterThan(hostingGuard);
    expect(mailGuard).toBeLessThan(emailOwnerLookup);

    const deletion = routeBlock("router.delete('/:name/share/:linkId'");
    expect(deletion).not.toContain('portalFeatureUnavailableResponse(');
  });
});
