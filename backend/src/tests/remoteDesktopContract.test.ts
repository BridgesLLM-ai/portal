import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const readRepo = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('Remote Desktop release contract', () => {
  test('the embedded noVNC client uses the authenticated exact bridge and reports real RFB state', () => {
    const html = readRepo('static/novnc/vnc_portal.html');
    expect(html).toContain('`${proto}://${location.host}/novnc/websockify`');
    expect(html).not.toContain("readParam('host'");
    expect(html).not.toContain("readParam('path'");
    expect(html).toContain("type: 'bridgesllm.remoteDesktopStatus'");
    expect(html).toContain("status('Connected', 'connected', 'connected')");
    expect(html).toContain('cleanupSmartResizeHooks()');
    expect(html).toContain("window.removeEventListener('message', onParentMessage)");
    expect(html).toContain('MAX_TYPED_CHARACTERS');
    expect(html).toContain('maxlength="262144"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('aria-label="Toggle clipboard panel"');
  });

  test('the Portal upgrade boundary rejects prefix-confused WebSocket paths', () => {
    const server = readRepo('backend/src/server.ts');
    expect(server).toContain("isExactWebSocketPath(req.url, '/novnc/websockify')");
    expect(server).toContain("isExactWebSocketPath(req.url, '/novnc/audio')");
    expect(server).not.toContain("req.url?.startsWith('/novnc/websockify')");
    expect(server).not.toContain("req.url?.startsWith('/novnc/audio')");
    expect(server).toContain("const novncWsTarget = 'http://127.0.0.1:6080'");
    expect(server).not.toContain('process.env.RD_NOVNC_TARGET');
    expect(server).not.toContain('process.env.RD_AUDIO_TARGET');
    expect(server).toContain("frame-ancestors 'self'");
  });

  test('high-impact mutations require typed confirmation and serialized admission', () => {
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    expect(route).toContain('PRIVILEGED_CONFIRMATION.remoteDesktopSetup');
    expect(route).toContain('PRIVILEGED_CONFIRMATION.remoteDesktopRecovery');
    expect(route).toContain("router.post('/auto-setup', async");
    expect(route).not.toContain("router.post('/auto-setup', requireOwner");
    expect(route).toContain("acquireRemoteDesktopMutationLock('recover Remote Desktop services')");
    expect(route).toContain("acquireRemoteDesktopMutationLock('set up Remote Desktop')");
    expect(route).toContain('MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES');
  });

  test('automatic OpenClaw restarts are authorization-fenced and system-unit-only', () => {
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    const restartHelper = route.slice(
      route.indexOf('async function restartOpenClawGatewaySystemUnit'),
      route.indexOf('type DesktopClipboardSelection'),
    );

    expect(restartHelper.indexOf('await assertOpenClawGatewayAuthorizationFenceReleased()'))
      .toBeLessThan(restartHelper.indexOf("execFile(\n      '/usr/bin/systemctl'"));
    expect(restartHelper).toContain("['restart', 'openclaw-gateway.service']");
    expect(restartHelper).toContain("fs.existsSync('/run/systemd/system')");
    expect(restartHelper).toContain("fs.existsSync('/usr/bin/systemctl')");
    expect(route.match(/restartOpenClawGatewaySystemUnit\(/g)).toHaveLength(3);
    expect(route).not.toContain("runShell('openclaw gateway restart'");
    expect(route).not.toContain("runShell('systemctl restart openclaw-gateway.service'");
  });

  test('fresh install and repair converge on the same bundled launcher', () => {
    const installer = readRepo('installer/install.sh');
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    const launcher = readRepo('installer/scripts/bridges-rd-xtigervnc-start.sh');
    const guard = readRepo('installer/scripts/bridges-rd-session-guard.sh');
    expect(installer).toContain('$PORTAL_DIR/installer/scripts/bridges-rd-xtigervnc-start.sh');
    expect(route).toContain("copyBundledStaticFile('installer/scripts/bridges-rd-xtigervnc-start.sh'");
    expect(route).toContain("copyBundledStaticFile('installer/scripts/bridges-rd-session-guard.sh'");
    expect(route).not.toContain('fs.writeFileSync(vncLauncher, `#!/bin/bash');
    expect(route).not.toContain('fs.writeFileSync(windowFitScript, `#!/bin/bash');
    expect(route).not.toContain('Fallback: write minimal launcher');
    expect(route).toContain('Signed Remote Desktop browser launchers are missing from the installed Portal bundle');
    expect(installer).not.toContain('--no-sandbox');
    expect(route).not.toContain('--no-sandbox');
    expect(installer).toContain('User=bridgesrd\nGroup=bridgesrd\nExecStart=/usr/bin/python3 /usr/bin/websockify');
    expect(route).toContain('User=bridgesrd\nGroup=bridgesrd\nExecStart=${webLauncher}');
    expect(installer).toContain('NoNewPrivileges=true');
    expect(route).toContain('NoNewPrivileges=true');
    expect(installer).toContain('NotifyAccess=main');
    expect(route).toContain('NotifyAccess=main');
    expect(installer).not.toContain('NotifyAccess=all');
    expect(route).not.toContain('NotifyAccess=all');
    expect(route).toContain("$1 == \\\"bridgesrd\\\"");
    expect(launcher).toContain('-AcceptSetDesktopSize=1');
    expect(launcher).toContain('-auth "$XAUTHORITY_FILE"');
    expect(launcher).not.toMatch(/^\s*-ac\s*&/m);
    expect(launcher).toContain('export XAUTHORITY=$XAUTHORITY_FILE');
    expect(launcher).toContain('run_as_rd DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE"');
    expect(guard).toContain('xset -dpms');
    expect(launcher).toContain('vncconfig -nowin');
    expect(launcher).toContain('/usr/local/bin/bridges-rd-window-fit.sh');
    expect(launcher).toContain('/usr/local/bin/bridges-rd-session-guard.sh');
    expect(launcher).toContain('run_as_rd()');
    expect(launcher).toContain('/usr/bin/setpriv');
    expect(launcher).toContain('--reuid="$RD_USER"');
    expect(launcher).toContain('--pdeathsig=TERM');
    expect(launcher).not.toMatch(/^[ \t]*(?:exec[ \t]+)?su[ \t]+-/m);
    expect(launcher).toContain('systemd-notify --pid=parent --ready');
    expect(launcher).toContain('exec "$SESSION_GUARD" watch "$VNC_PID" "$XFCE_PID"');
    expect(launcher).not.toContain('wait -n "$VNC_PID" "$XFCE_PID" "$GUARD_PID"');
    expect(guard).toContain('xfce4-session');
    expect(guard).toContain('xfwm4');
    expect(guard).toContain('xfdesktop');
    expect(guard).toContain("-s /bin/true");
    expect(guard).toContain('Hidden=true');
    expect(route).toContain('desktopSessionHealthy: desktopSessionPolicy.healthy');
    expect(route).toContain('sessionGuardSupervised');
  });

  test('automatic desktop recovery is signed, timer-supervised, and reported from bounded state', () => {
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    const healthcheck = readRepo('installer/scripts/bridges-rd-healthcheck.sh');

    expect(route).toContain("copyBundledStaticFile('installer/scripts/bridges-rd-healthcheck.sh'");
    expect(route).toContain("'installer/scripts/bridges-rd-healthcheck.sh', REMOTE_DESKTOP_HEALTHCHECK");
    expect(route).toContain('ExecStart=${REMOTE_DESKTOP_HEALTHCHECK}');
    expect(route).toContain('OnUnitActiveSec=30s');
    expect(route).toContain('systemctl enable bridges-rd-xtigervnc.service bridges-rd-websockify.service ${REMOTE_DESKTOP_HEALTHCHECK_TIMER}');
    expect(route).toContain('checkSystemdUnitActive(REMOTE_DESKTOP_HEALTHCHECK_TIMER)');
    expect(route).toContain('automaticRecovery: {');
    expect(route).toContain('REMOTE_DESKTOP_HEALTH_STATE_MAX_BYTES = 4096');
    expect(route).toContain('fs.constants.O_NOFOLLOW');
    expect(route).toContain('(stat.mode & 0o022) !== 0');
    expect(route).toContain('automaticHealthReady');
    expect(healthcheck).toContain("readonly MUTATION_LOCK='/run/bridgesllm-remote-desktop.lock'");
    expect(healthcheck).toContain('MAX_RESTARTS=3');
    expect(healthcheck).toContain('SUPPRESSION_SECONDS=900');
  });

  test('the shared browser stream is account-gated, bounded, and exact-path only', () => {
    const route = readRepo('backend/src/routes/agentBrowser.ts');
    expect(route).toContain('canAccessPortal((dbUser as any).accountStatus, dbUser.isActive)');
    expect(route).toContain("isExactWebSocketPath(url, '/api/agent-browser/stream')");
    expect(route).toContain('MAX_AGENT_BROWSER_BUFFERED_BYTES');
    expect(route).toContain('validateSharedBrowserUrl(req.body?.url)');
  });

  test('shipped desktop browser launchers retain Chrome sandboxing and private state', () => {
    const shared = readRepo('static/scripts/bridges-rd-shared-chrome.sh');
    const openclaw = readRepo('static/scripts/bridges-rd-openclaw-ui.sh');
    const aiProviders = readRepo('static/scripts/bridges-rd-ai-launchers.sh');
    const agentBrowser = readRepo('backend/src/routes/agentBrowser.ts');
    const remoteDesktop = readRepo('backend/src/routes/remote-desktop.ts');
    const inventory = readRepo('installer/release-required-members.txt').split('\n');

    for (const launcher of [shared, openclaw]) {
      expect(launcher).not.toMatch(/--(?:no-sandbox|disable-gpu-sandbox|disable-setuid-sandbox)/);
      expect(launcher).not.toMatch(/\b(?:exec\s+)?su\s+-/);
      expect(launcher).toContain('umask 077');
      expect(launcher).toContain('export XAUTHORITY="${XAUTHORITY:-/home/bridgesrd/.Xauthority}"');
    }
    expect(aiProviders).not.toMatch(/--(?:no-sandbox|disable-gpu-sandbox|disable-setuid-sandbox)/);
    expect(aiProviders).not.toMatch(/\b(?:exec\s+)?su\s+-/);
    expect(aiProviders).toContain('umask 077');
    expect(aiProviders).toContain('export XAUTHORITY="${XAUTHORITY:-${RD_HOME}/.Xauthority}"');
    expect(shared).toContain('STATE_ROOT="/home/bridgesrd/.config/bridges-agent-browser"');
    expect(shared).toContain('/usr/bin/setpriv');
    expect(shared).toContain('SESSION_ROOT="${STATE_ROOT}/session"');
    expect(shared).toContain('LOG_DIR="${STATE_ROOT}/logs"');
    expect(shared).not.toContain('/tmp/bridges-agent-browser');
    expect(agentBrowser).toContain("const SHARED_BROWSER_STATE_DIR = '/home/bridgesrd/.config/bridges-agent-browser';");
    expect(agentBrowser).toContain("const SHARED_BROWSER_SYSTEMD_UNIT = 'bridgesllm-shared-browser.service';");
    expect(agentBrowser).toContain('desktopExecDetached(chromeCmd, SHARED_BROWSER_SYSTEMD_UNIT)');
    expect(agentBrowser).toContain('sharedProfileDir: SHARED_BROWSER_PROFILE_DIR');
    expect(agentBrowser).toContain('logPath: SHARED_BROWSER_LOG_PATH');
    expect(agentBrowser).not.toContain('/tmp/bridges-agent-browser');
    expect(remoteDesktop).not.toContain("copyBundledStaticFile('skills/bridgesllm-portal/scripts/bridges-rd-shared-chrome.sh'");
    expect(inventory).toContain('portal/installer/scripts/bridges-rd-xtigervnc-start.sh');
    expect(inventory).toContain('portal/installer/scripts/bridges-rd-session-guard.sh');
    expect(inventory).toContain('portal/installer/scripts/bridges-rd-window-fit.sh');
    expect(inventory).toContain('portal/static/scripts/bridges-rd-openclaw-ui.sh');
    expect(inventory).toContain('portal/static/scripts/bridges-rd-shared-chrome.sh');
    expect(inventory).toContain('portal/static/scripts/bridges-rd-ai-launchers.sh');
    for (const runtime of ['agent-zero', 'antigravity', 'claude-code', 'codex', 'grok-build', 'ollama']) {
      expect(inventory).toContain(`portal/static/icons/bridges-ai-${runtime}.svg`);
    }
    expect(aiProviders).toContain('runtime_catalog()');
    expect(aiProviders).toContain('Claude Code (Terminal Runtime)');
    expect(aiProviders).toContain('OpenAI Codex (Terminal Runtime)');
    expect(aiProviders).toContain('Grok Build (Terminal Runtime)');
    expect(aiProviders).toContain('Google Antigravity (Terminal Runtime)');
    expect(aiProviders).toContain('Ollama (Local Runtime Terminal)');
    // Agent Zero ships a web-UI launcher opened via a click-time backend
    // session exchange; the Agent Zero password never touches the desktop.
    expect(aiProviders).toContain('Agent Zero (Web UI)');
    expect(aiProviders).toContain('backend-session-exchange-v2');
    expect(aiProviders).toContain('launch_agent_zero_web');
    expect(aiProviders).toContain('/api/agent-runtime/agent-zero/desktop-session');
    expect(aiProviders).toContain('Network.setCookie');
    // The old always-blocked stub and its security-spec wall are gone.
    expect(aiProviders).not.toContain('secure-one-time-exchange-v1');
    expect(aiProviders).not.toContain('single-use session exchange bound to the current Portal user');
    expect(aiProviders).toContain('native-gui|local-web|terminal-tui|vendor-site');
    expect(aiProviders).toContain('X-BridgesLLM-Intent=${intent}');
    expect(aiProviders).toContain('X-BridgesLLM-Mode=${mode}');
    expect(aiProviders).not.toContain("chatgpt) printf");
    expect(aiProviders).not.toContain("'https://chatgpt.com'");
    expect(aiProviders).not.toContain("'https://claude.ai'");
    expect(aiProviders).not.toContain("'https://gemini.google.com'");
    expect(aiProviders).not.toContain("'https://grok.com'");
    expect(aiProviders).toContain('remove_legacy_assets');
    expect(openclaw).toContain('OpenClawControlUI');
    expect(aiProviders).not.toContain('OpenClawControlUI');
    expect(remoteDesktop).toContain("'static/scripts/bridges-rd-ai-launchers.sh'");
    expect(remoteDesktop).toContain('AI_PROVIDER_LAUNCHER_PATH');
  });

  test('the operator guide documents the current host-managed 4.0 topology', () => {
    const guide = readRepo('docs/REMOTE_DESKTOP.md');
    expect(guide).toContain('127.0.0.1:4001');
    expect(guide).toContain('bridges-rd-xtigervnc.service');
    expect(guide).toContain('bridges-rd-websockify.service');
    expect(guide).toContain('/home/bridgesrd/.Xauthority');
    expect(guide).toContain('/home/bridgesrd/.config/bridges-agent-browser/logs/launcher.log');
    expect(guide).toContain('/home/bridgesrd/.config/openclaw-control-ui-browser');
    expect(guide).toContain('/novnc/vnc_portal.html?reconnect=1&resize=smart');
    expect(guide).toContain('POST /api/remote-desktop/recover');
    expect(guide).toContain('POST /api/agent-browser/open-in-desktop');
    expect(guide).not.toContain('docker `portal` container');
    expect(guide).not.toContain('127.0.0.1:3001');
    expect(guide).not.toContain('bridges-rd-vnc.service` |');
  });

  test('audio streaming is capacity bounded and shutdown cancels every restart path', () => {
    const proxy = readRepo('backend/src/services/audioProxy.ts');
    expect(proxy).toContain('MAX_AUDIO_CLIENTS');
    expect(proxy).toContain('MAX_AUDIO_CLIENT_BUFFERED_BYTES');
    expect(proxy).toContain('client.bufferedAmount > MAX_AUDIO_CLIENT_BUFFERED_BYTES');
    expect(proxy).toContain('perMessageDeflate: false');
    expect(proxy).toContain('clearTimeout(serverRestartTimer)');
    expect(proxy).toContain('audioProxyStopping = true');
  });

  test('desktop launch helpers propagate the Xauthority boundary', () => {
    const desktopEnv = readRepo('backend/src/utils/desktopEnv.ts');
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    expect(desktopEnv).toContain('XAUTHORITY');
    expect(desktopEnv).toContain("execFileSync('/usr/bin/setpriv'");
    expect(desktopEnv).toContain("execFileSync('systemd-run'");
    expect(desktopEnv).toContain("execFileSync('systemctl', ['stop', unitName]");
    expect(desktopEnv).not.toContain(`su - ${'bridgesrd'}`);
    expect(desktopEnv).not.toContain("'-lc'");
    expect(route).toContain("XAUTHORITY: '/home/bridgesrd/.Xauthority'");
    expect(route).toContain('vncProcessHardened: vncProcessPolicy.hardened');
    expect(route).toContain('websockifyProcessHardened: websockifyProcessPolicy.hardened');
    expect(route).toContain('externalUrlSafe');
  });

  test('chat-linked host files retain elevated, snapshot-only, shell-free opening', () => {
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    const service = readRepo('backend/src/services/remoteDesktopOpenPath.ts');
    const desktopEnv = readRepo('backend/src/utils/desktopEnv.ts');
    const server = readRepo('backend/src/server.ts');

    expect(route.indexOf('router.use(authenticateToken, requireAdmin)'))
      .toBeLessThan(route.indexOf("router.post('/open-path'"));
    expect(route).toContain('const workspaceOwnerId = actorUserId;');
    expect(route).not.toContain('getWorkspaceOwnerId(req.user!)');
    expect(route).toContain("gatewayRpcCall('agents.list', {}, 5_000)");
    expect(route).toContain('selectOpenClawAgentWorkspace(result.data?.agents, rawAgentId)');
    expect(service).toContain("export const REMOTE_DESKTOP_OPEN_ROOT = '/var/lib/bridgesllm/remote-desktop-open'");
    expect(service).toContain('The RPC result is the only workspace authority accepted here.');
    expect(service).not.toContain('readConfiguredAgentWorkspaceRoots');
    expect(service).not.toContain('openClawConfigPath');
    expect(service).toContain('fs.constants.O_NOFOLLOW');
    expect(service).toContain('sameFileIdentity(admission.stat, openedStat)');
    expect(service).toContain("targetType: 'file'");
    expect(service).not.toContain("targetType: 'directory'");
    expect(desktopEnv).toContain('managedDesktopSystemdRunArgv');
    expect(desktopEnv).toContain("'--',\n    executable,\n    ...args");
    expect(server).toContain('await startRemoteDesktopOpenPathCleanup()');
    expect(server).toContain('stopRemoteDesktopOpenPathCleanup();');
  });

  test('the managed Portal skill ships bounded file-link guidance and converges at startup', () => {
    const skill = readRepo('skills/bridgesllm-portal/SKILL.md');
    const guide = readRepo('skills/bridgesllm-portal/references/files-and-projects.md');
    const inventory = readRepo('installer/release-required-members.txt').split('\n');
    const route = readRepo('backend/src/routes/remote-desktop.ts');
    const server = readRepo('backend/src/server.ts');
    const managedSkillReconcile = route.slice(
      route.indexOf('export function reconcilePortalManagedSkill'),
      route.indexOf('export async function reconcileRemoteDesktopLauncherAssets'),
    );
    const visibleDefaults = route.slice(
      route.indexOf('async function ensurePortalVisibleBrowserDefaults'),
      route.indexOf('export function reconcilePortalManagedSkill'),
    );

    expect(skill).toContain('return a real Markdown link');
    expect(skill).toContain('never guess a host root');
    expect(skill).toContain('`/api/files/<encoded-file-id>`');
    expect(skill).toContain('references/files-and-projects.md');
    expect(guide).toContain(
      '[Open the handoff](/root/.openclaw/workspace-main/audit/HANDOFF-project-chat-and-backups.md)',
    );
    expect(guide).toContain(
      '[Open the Project handoff](/workspace/project/audit/HANDOFF-project-chat-and-backups.md)',
    );
    expect(guide).toContain('[Open uploaded report](/api/files/abc123)');
    expect(guide).toContain('Never substitute a signed');
    expect(inventory).toContain('portal/skills/bridgesllm-portal/SKILL.md');
    expect(inventory).toContain('portal/skills/bridgesllm-portal/references/files-and-projects.md');
    expect(server).toContain('reconcilePortalManagedSkill();');
    expect(managedSkillReconcile).toContain('ensurePortalSkillInstalled()');
    expect(managedSkillReconcile).not.toContain('restartOpenClawGatewaySystemUnit');
    expect(visibleDefaults).not.toContain('ensurePortalSkillInstalled()');
  });
});
