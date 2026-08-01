import fs from 'fs';
import path from 'path';

const setupSource = fs.readFileSync(path.resolve(__dirname, '../routes/setup-v3.ts'), 'utf8');
const adminSource = fs.readFileSync(path.resolve(__dirname, '../routes/admin.ts'), 'utf8');
const mailSource = fs.readFileSync(path.resolve(__dirname, '../routes/mail.ts'), 'utf8');
const publicSettingsSource = fs.readFileSync(
  path.resolve(__dirname, '../routes/settings-public.ts'),
  'utf8',
);

function routeBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\nrouter.', start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('Tailnet origin unsupported-feature gates', () => {
  test('never promotes the private ts.net origin into public mail authority', () => {
    const start = setupSource.indexOf('function getDomain(req?: Request): string');
    const end = setupSource.indexOf('\n\nasync function waitForStalwartJmap', start);
    const body = setupSource.slice(start, end);

    expect(body).toContain("configuredPortalOriginMode() === 'tailnet'");
    expect(body.indexOf("configuredPortalOriginMode() === 'tailnet'"))
      .toBeLessThan(body.indexOf('process.env.CORS_ORIGIN'));
    expect(body.indexOf("configuredPortalOriginMode() === 'tailnet'"))
      .toBeLessThan(body.indexOf('req?.hostname'));
  });

  test('setup mail mutations reject before domain, Docker, network, or filesystem work', () => {
    for (const signature of [
      "router.post('/install-mail'",
      "router.post('/test-email'",
    ]) {
      const block = routeBlock(setupSource, signature);
      const guard = block.indexOf("portalFeatureUnavailableResponse('mail')");
      expect(guard).toBeGreaterThan(-1);
      for (const operation of ['getDomain(', "execSync('docker info", 'sendEmail({']) {
        const operationIndex = block.indexOf(operation);
        if (operationIndex >= 0) expect(guard).toBeLessThan(operationIndex);
      }
    }
  });

  test('admin mail installation rejects before domain discovery or Docker mutation', () => {
    const block = routeBlock(adminSource, "router.post('/install-mail'");
    const guard = block.indexOf("portalFeatureUnavailableResponse('mail')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(block.indexOf('process.env.MAIL_DOMAIN'));
    expect(guard).toBeLessThan(block.indexOf("execSync('docker info"));
  });

  test('authenticated mail routes reject before account discovery or provisioning', () => {
    const middleware = mailSource.indexOf(
      'router.use(authenticateToken, requireApproved, (req: Request, res: Response, next: NextFunction) => {',
    );
    const firstRoute = mailSource.indexOf("router.get('/accounts'", middleware);
    expect(middleware).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(middleware);
    const gate = mailSource.slice(middleware, firstRoute);
    expect(gate).toContain("portalFeatureUnavailableResponse('mail')");

    const accounts = routeBlock(mailSource, "router.get('/accounts'");
    expect(firstRoute).toBeGreaterThan(
      mailSource.indexOf("portalFeatureUnavailableResponse('mail')", middleware),
    );
    expect(accounts).toContain('getUserMailAccounts(req.user!.userId)');
  });

  test('authenticated admin mail surfaces reject before probes or mutations', () => {
    const cases = [
      {
        signature: "router.post('/settings/test-email'",
        operations: ['prisma.user.findUnique', 'sendEmail({'],
      },
      {
        signature: "router.get('/email-status'",
        operations: ['fetch(`${stalwartUrl}/.well-known/jmap`'],
      },
      {
        signature: "router.get('/mailboxes'",
        operations: ['getProvisionedMailboxes()'],
      },
      {
        signature: "router.delete('/mailboxes/:username'",
        operations: ['prisma.mailboxAccount.findUnique', 'deleteUserMailbox'],
      },
    ];

    for (const { signature, operations } of cases) {
      const block = routeBlock(adminSource, signature);
      const guard = block.indexOf("portalFeatureUnavailableResponse('mail')");
      expect(guard).toBeGreaterThan(-1);
      for (const operation of operations) {
        expect(guard).toBeLessThan(block.indexOf(operation));
      }
    }
  });

  test('setup and authenticated shells expose one sanitized capability contract', () => {
    const systemInfo = routeBlock(setupSource, "router.get('/system-info'");
    expect(systemInfo).toContain('originMode: configuredPortalOriginMode()');
    expect(systemInfo).toContain('featureCapabilities: getPortalFeatureCapabilities()');
    expect(publicSettingsSource).toContain('...getPortalFeatureCapabilities()');
  });
});
