import fs from 'fs';
import path from 'path';

const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const terminalSource = fs.readFileSync(path.resolve(__dirname, '../routes/exec.ts'), 'utf8');
const gatewaySource = fs.readFileSync(path.resolve(__dirname, '../routes/gateway.ts'), 'utf8');
const agentBrowserSource = fs.readFileSync(path.resolve(__dirname, '../routes/agentBrowser.ts'), 'utf8');

function namespaceBlock(namespace: string, nextNamespace: string): string {
  const start = serverSource.indexOf(`const ${namespace} =`);
  const end = serverSource.indexOf(`const ${nextNamespace} =`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return serverSource.slice(start, end);
}

describe('operator Socket.IO namespace authorization', () => {
  it('reloads the authenticated user before applying the elevated-role check', () => {
    const start = serverSource.indexOf('const socketElevatedRoleMiddleware');
    const end = serverSource.indexOf('// Metrics streaming namespace', start);
    const middleware = serverSource.slice(start, end);

    expect(middleware).toContain('isElevatedRole(socket.data.user?.role)');
    expect(middleware).toContain("next(new Error('Elevated role required'))");
  });

  it('protects server-wide alerts with authentication and elevated role middleware', () => {
    const block = namespaceBlock('alertsNs', 'openclawNs');
    expect(block).toContain('alertsNs.use(socketAuthMiddleware)');
    expect(block).toContain('alertsNs.use(socketElevatedRoleMiddleware)');
    expect(block.indexOf('socketAuthMiddleware')).toBeLessThan(block.indexOf('socketElevatedRoleMiddleware'));
  });

  it('protects OpenClaw status with authentication and elevated role middleware', () => {
    const block = namespaceBlock('openclawNs', 'agentJobsNs');
    expect(block).toContain('openclawNs.use(socketAuthMiddleware)');
    expect(block).toContain('openclawNs.use(socketElevatedRoleMiddleware)');
    expect(block.indexOf('socketAuthMiddleware')).toBeLessThan(block.indexOf('socketElevatedRoleMiddleware'));
  });

  it('protects retained agent-job output and completion events with elevated role middleware', () => {
    const start = serverSource.indexOf('const agentJobsNs =');
    const end = serverSource.indexOf('// Caddy/Cloudflare ingress', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = serverSource.slice(start, end);
    expect(block).toContain('agentJobsNs.use(socketAuthMiddleware)');
    expect(block).toContain('agentJobsNs.use(socketElevatedRoleMiddleware)');
    expect(block.indexOf('socketAuthMiddleware')).toBeLessThan(block.indexOf('socketElevatedRoleMiddleware'));
    expect(block).toContain("socket.on('subscribe'");
    expect(block).toContain("socket.emit('status'");
    expect(block).toContain("socket.emit('snapshot'");
    expect(block).toContain('readTranscript(jobId, { maxEntries: 500, maxReadBytes: 512 * 1024 })');
    expect(block).not.toContain('subscribe-tool-install');
  });

  it('does not accidentally remove the approved-user metrics namespace', () => {
    const block = namespaceBlock('metricsNs', 'alertsNs');
    expect(block).toContain('metricsNs.use(socketAuthMiddleware)');
    expect(block).not.toContain('socketElevatedRoleMiddleware');
  });

  it('binds authorization snapshots and change events to the authenticated user', () => {
    const block = namespaceBlock('authorizationNs', 'alertsNs');
    expect(block).toContain('authorizationNs.use(socketAuthMiddleware)');
    expect(block).toContain("socket.emit('authorization_snapshot'");
    expect(block).toContain("socket.data.authorizationChangeRelay = relay");
    expect(block).toContain('if (pendingEvents?.length)');
    expect(block).toContain('relay(latest)');
    expect(block.indexOf('if (pendingEvents?.length)'))
      .toBeLessThan(block.indexOf("socket.emit('authorization_snapshot'"));
    const middlewareStart = serverSource.indexOf('const socketAuthMiddleware');
    const middlewareEnd = serverSource.indexOf('const socketElevatedRoleMiddleware', middlewareStart);
    const middleware = serverSource.slice(middlewareStart, middlewareEnd);
    expect(middleware).toContain("socket.nsp?.name === '/authorization'");
    expect(middleware).toContain('subscribeToAuthorizationChanges(payload.userId');
    expect(middleware.indexOf('subscribeToAuthorizationChanges(payload.userId'))
      .toBeLessThan(middleware.indexOf('prisma.user.findUnique'));
  });

  it('rejects socket handshakes from an older durable authorization generation', () => {
    const start = serverSource.indexOf('const socketAuthMiddleware');
    const end = serverSource.indexOf('const socketElevatedRoleMiddleware', start);
    const middleware = serverSource.slice(start, end);
    expect(middleware).toContain('authorizationVersion: true');
    expect(middleware).toContain('(payload.authorizationVersion ?? 1) !== authorizationVersion');
    expect(middleware).toContain('Authorization changed; sign in again');
  });

  it('server-revokes every already-open privileged transport after authorization changes', () => {
    const sharedStart = serverSource.indexOf('const socketAuthMiddleware');
    const sharedEnd = serverSource.indexOf('const socketElevatedRoleMiddleware', sharedStart);
    const shared = serverSource.slice(sharedStart, sharedEnd);
    expect(shared).toContain("socket.nsp?.name === '/authorization'");
    expect(shared).toContain('subscribeToAuthorizationChanges(payload.userId');
    expect(shared).toContain('subscribeToGlobalWorkspaceAuthorizationFence(');
    expect(shared).toContain('if (!authorizationNamespace)');
    expect(shared.indexOf('subscribeToGlobalWorkspaceAuthorizationFence('))
      .toBeLessThan(shared.indexOf('prisma.user.findUnique'));
    expect(shared).toContain('socket.disconnect(true)');

    expect(terminalSource).toContain('subscribeToAuthorizationChanges(');
    expect(terminalSource).toContain('subscribeToGlobalWorkspaceAuthorizationFence(');
    expect(terminalSource.indexOf('subscribeToGlobalWorkspaceAuthorizationFence('))
      .toBeLessThan(terminalSource.indexOf('prisma.user.findUnique'));
    expect(terminalSource).toContain('authorizationControl.revoked = true');
    expect(terminalSource).toContain('authorizationControl.requestTermination?.()');
    expect(terminalSource).toContain('acquireGlobalWorkspaceAuthorizationMutationLease()');
    expect(terminalSource).toContain('await prepared.stop()');
    expect(terminalSource).not.toContain('pty.kill(');
    expect(terminalSource).toContain('socket.disconnect(true)');

    for (const path of ['/novnc/websockify', '/novnc/audio']) {
      const start = serverSource.indexOf(`isExactWebSocketPath(req.url, '${path}')`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextBranch = serverSource.indexOf('} else if (isExactWebSocketPath', start + 1);
      const end = nextBranch >= 0 ? nextBranch : serverSource.indexOf('// Legacy Guacamole', start);
      const block = serverSource.slice(start, end);
      expect(block).toContain('subscribeToAuthorizationChanges(payload.userId');
      expect(block).toContain('subscribeToGlobalWorkspaceAuthorizationFence(');
      expect(block.indexOf('subscribeToAuthorizationChanges(payload.userId'))
        .toBeLessThan(block.indexOf('prisma.user.findUnique'));
      expect(block.indexOf('subscribeToGlobalWorkspaceAuthorizationFence('))
        .toBeLessThan(block.indexOf('prisma.user.findUnique'));
      expect(block).toContain('unsubscribeGlobalFence()');
      expect(block).toContain('socket.destroy()');
    }
  });

  it('generation-binds and actively revokes gateway and agent-browser WebSockets', () => {
    expect(gatewaySource).toContain('(user.authorizationVersion ?? 1) !== Number((dbUser as any).authorizationVersion ?? 1)');
    const gatewayUpgrade = gatewaySource.slice(gatewaySource.indexOf("httpServer.on('upgrade'"));
    expect(gatewayUpgrade).toContain('subscribeToAuthorizationChanges(user.userId');
    expect(gatewayUpgrade).toContain('subscribeToGlobalWorkspaceAuthorizationFence(');
    expect(gatewayUpgrade.indexOf('subscribeToAuthorizationChanges(user.userId'))
      .toBeLessThan(gatewayUpgrade.indexOf('prisma.user.findUnique'));
    expect(gatewayUpgrade.indexOf('subscribeToGlobalWorkspaceAuthorizationFence('))
      .toBeLessThan(gatewayUpgrade.indexOf('prisma.user.findUnique'));
    expect(gatewayUpgrade).toContain("socket.write('HTTP/1.1 409 Conflict");
    expect(gatewayUpgrade).toContain('unsubscribeGlobalFence()');
    expect(gatewayUpgrade).toContain('socket.destroy()');

    expect(agentBrowserSource).toContain('(user.authorizationVersion ?? 1) !== Number((dbUser as any).authorizationVersion ?? 1)');
    const browserUpgrade = agentBrowserSource.slice(agentBrowserSource.indexOf("httpServer.on('upgrade'"));
    expect(browserUpgrade).toContain('subscribeToAuthorizationChanges(tokenUser.userId');
    expect(browserUpgrade).toContain('subscribeToGlobalWorkspaceAuthorizationFence(');
    expect(browserUpgrade.indexOf('subscribeToAuthorizationChanges(tokenUser.userId'))
      .toBeLessThan(browserUpgrade.indexOf('getAuthorizedAdminFromUpgrade(req, tokenUser)'));
    expect(browserUpgrade.indexOf('subscribeToGlobalWorkspaceAuthorizationFence('))
      .toBeLessThan(browserUpgrade.indexOf('getAuthorizedAdminFromUpgrade(req, tokenUser)'));
    expect(browserUpgrade).toContain("socket.write('HTTP/1.1 409 Conflict");
    expect(browserUpgrade).toContain('unsubscribeGlobalFence()');
    expect(browserUpgrade).toContain('socket.destroy()');
  });

  it('tears down long-lived Agent Chat and approval SSE streams on revocation', () => {
    const sendStart = gatewaySource.indexOf("router.post('/send'");
    const sendEnd = gatewaySource.indexOf("router.post('/abort'", sendStart);
    const send = gatewaySource.slice(sendStart, sendEnd);
    expect(send).toContain('subscribeToAuthorizationChanges(req.user!.userId');
    expect(send).toContain('provider.abortActiveRun?.(sessionId, routeRunId)');
    expect(send).toContain('finishSse()');
    expect(send).toContain("'private, no-store, no-transform, max-age=0'");

    const approvalsStart = gatewaySource.indexOf("router.get('/approvals/stream'");
    const approvalsEnd = gatewaySource.indexOf('/* ═', approvalsStart);
    const approvals = gatewaySource.slice(approvalsStart, approvalsEnd);
    expect(approvals).toContain('subscribeToAuthorizationChanges(req.user!.userId');
    expect(approvals).toContain('res.destroy()');
    expect(approvals).toContain("'private, no-store, no-transform, max-age=0'");
  });
});
