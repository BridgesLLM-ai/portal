import fs from 'fs';
import path from 'path';

const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const terminalSource = fs.readFileSync(path.resolve(__dirname, '../routes/exec.ts'), 'utf8');
const gatewaySource = fs.readFileSync(path.resolve(__dirname, '../routes/gateway.ts'), 'utf8');
const agentBrowserSource = fs.readFileSync(path.resolve(__dirname, '../routes/agentBrowser.ts'), 'utf8');
const accessAuthorizationSource = fs.readFileSync(
  path.resolve(__dirname, '../services/accessTokenAuthorization.ts'),
  'utf8',
);
const transportAuthorizationSource = fs.readFileSync(
  path.resolve(__dirname, '../services/portalTransportAuthorization.ts'),
  'utf8',
);

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
    expect(serverSource).toContain('createSocketAccessAuthorizationMiddleware()');
    expect(transportAuthorizationSource).toContain("socket.nsp?.name === '/authorization'");
    expect(transportAuthorizationSource).toContain('authorizationPendingEvents');
    expect(accessAuthorizationSource.indexOf('subscribeAuthorization(input.payload.userId'))
      .toBeLessThan(accessAuthorizationSource.indexOf('authorizeAccessTokenPayload(input.payload'));
    expect(accessAuthorizationSource.indexOf('subscribeSession('))
      .toBeLessThan(accessAuthorizationSource.indexOf('authorizeAccessTokenPayload(input.payload'));
  });

  it('rejects socket handshakes from an older durable authorization generation', () => {
    expect(accessAuthorizationSource).toContain('authorizationVersion: true');
    expect(accessAuthorizationSource).toContain('(payload.authorizationVersion ?? 1) !== authorizationVersion');
    expect(transportAuthorizationSource).toContain('Authorization changed; sign in again');
  });

  it('server-revokes every already-open privileged transport after authorization changes', () => {
    expect(accessAuthorizationSource).toContain('subscribeGlobalFence(() => revoke');
    expect(accessAuthorizationSource).toContain('subscribeAuthorization(input.payload.userId');
    expect(accessAuthorizationSource).toContain('subscribeSession(');
    expect(transportAuthorizationSource).toContain('socket.disconnect(true)');

    expect(terminalSource).toContain('establishLongLivedAccessAuthorization({');
    expect(terminalSource).toContain('authorizationControl.revoked = true');
    expect(terminalSource).toContain('authorizationControl.requestTermination?.()');
    expect(terminalSource).toContain('acquireGlobalWorkspaceAuthorizationMutationLease()');
    expect(terminalSource).toContain('await prepared.stop()');
    expect(terminalSource).not.toContain('pty.kill(');
    expect(terminalSource).toContain('socket.disconnect(true)');

    expect(serverSource).toContain("isExactWebSocketPath(req.url, '/novnc/websockify')");
    expect(serverSource).toContain("isExactWebSocketPath(req.url, '/novnc/audio')");
    expect(serverSource).toContain('handleRemoteDesktopWebSocketUpgrade(req, socket, head, novncWsProxy');
    expect(serverSource).toContain('handleRemoteDesktopWebSocketUpgrade(req, socket, head, audioWsProxy');
    expect(serverSource).toContain('authorizeRemoteDesktopWebSocketTransport(payload, onRevoke)');
    expect(serverSource).toContain('completeAuthorizedWebSocketUpgrade({');
  });

  it('generation-binds and actively revokes gateway and agent-browser WebSockets', () => {
    const gatewayUpgrade = gatewaySource.slice(gatewaySource.indexOf("httpServer.on('upgrade'"));
    expect(gatewayUpgrade).toContain('completeAuthorizedWebSocketUpgrade({');
    expect(gatewayUpgrade).toContain('authorizeGatewayWebSocketTransport(');
    expect(gatewayUpgrade).toContain('authorizationBinding.revoked = true');

    const browserUpgrade = agentBrowserSource.slice(agentBrowserSource.indexOf("httpServer.on('upgrade'"));
    expect(browserUpgrade).toContain('completeAuthorizedWebSocketUpgrade({');
    expect(browserUpgrade).toContain('authorizeAgentBrowserWebSocketTransport(tokenUser, onRevoke)');
    expect(transportAuthorizationSource).toContain('socket.once(\'close\', result.dispose)');
  });

  it('tears down long-lived Agent Chat and approval SSE streams on revocation', () => {
    const sendStart = gatewaySource.indexOf("router.post('/send'");
    const sendEnd = gatewaySource.indexOf("router.post('/abort'", sendStart);
    const send = gatewaySource.slice(sendStart, sendEnd);
    expect(send).toContain('establishLongLivedAccessAuthorization({');
    expect(send).toContain('disposeStreamAuthority()');
    expect(send).toContain('provider.abortActiveRun?.(sessionId, routeRunId)');
    expect(send).toContain('finishSse()');
    expect(send).toContain("'private, no-store, no-transform, max-age=0'");

    const approvalsStart = gatewaySource.indexOf("router.get('/approvals/stream'");
    const approvalsEnd = gatewaySource.indexOf('/* ═', approvalsStart);
    const approvals = gatewaySource.slice(approvalsStart, approvalsEnd);
    expect(approvals).toContain('establishLongLivedAccessAuthorization({');
    expect(approvals).toContain('disposeStreamAuthority()');
    expect(approvals).toContain('res.destroy()');
    expect(approvals).toContain("'private, no-store, no-transform, max-age=0'");
  });
});
