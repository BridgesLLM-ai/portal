/** Real filesystem, real POSIX ACLs and a real unprivileged account (no mocks). */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { ensureDesktopAccountTraversal } from './projectDesktopDeployment';

const ACCOUNT = { uid: 65534, gid: 65534, groups: [65534] };
const OTHER_GROUP = 12345; // stands in for the Agent Zero bridge group
const ready = process.getuid?.() === 0 && fs.existsSync('/usr/bin/setfacl') && fs.existsSync('/usr/bin/setpriv');
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const desktopRoots = ['desktop-projects', 'desktop-project-state'];
const acl = (target: string) => spawnSync('/usr/bin/getfacl', ['-cpnE', target], { encoding: 'utf8' }).stdout;
const asAccount = (script: string, groups?: number[]) => spawnSync('/usr/bin/setpriv', [`--reuid=${ACCOUNT.uid}`, `--regid=${ACCOUNT.gid}`, ...(groups ? [`--groups=${groups.join(',')}`] : ['--clear-groups']), '/bin/sh', '-c', script], { encoding: 'utf8' });
const dir = (target: string, mode: number, gid = 0) => { fs.mkdirSync(target, { recursive: true }); fs.chownSync(target, 0, gid); fs.chmodSync(target, mode); };
const file = (target: string, content: string, mode: number) => { fs.writeFileSync(target, content); fs.chmodSync(target, mode); };

/** The installed TEST shape reported for /var/lib/bridgesllm on 2026-10-23. */
function installedLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-traversal-')); roots.push(base); fs.chmodSync(base, 0o755);
  const parent = path.join(base, 'bridgesllm'); dir(parent, 0o700);
  const generation = path.join(parent, 'desktop-projects/p1/generations/g1');
  for (const part of ['desktop-projects', 'desktop-projects/p1', 'desktop-projects/p1/generations', 'desktop-projects/p1/generations/g1']) dir(path.join(parent, part), 0o755);
  file(path.join(generation, 'app.sh'), '#!/bin/sh\necho desktop-app-ran\n', 0o755);
  file(path.join(parent, 'desktop-projects/p1/deployment.json'), '{}', 0o600);
  const state = path.join(parent, 'desktop-project-state/p1');
  dir(path.join(parent, 'desktop-project-state'), 0o755); dir(state, 0o755);
  dir(path.join(state, 'logs'), 0o700); fs.chownSync(path.join(state, 'logs'), ACCOUNT.uid, ACCOUNT.gid);
  file(path.join(state, 'promotion.json'), '{"version":1}', 0o600);
  dir(path.join(parent, 'agent-zero-project-model-bridge'), 0o750, OTHER_GROUP);
  file(path.join(parent, 'agent-zero-project-model-bridge/bridge.env'), 'TOKEN=x', 0o640);
  for (const name of ['opencode', 'backup-trust', 'hermes', 'desktop-build-jobs']) { dir(path.join(parent, name), 0o700); file(path.join(parent, name, 'private'), 'x', 0o644); }
  file(path.join(parent, 'remote-desktop-ai-launchers.lock'), '', 0o600);
  dir(path.join(parent, 'remote-desktop-ai-launchers'), 0o755);
  file(path.join(parent, 'remote-desktop-ai-launchers/manifest.tsv'), '# bridgesllm-ai-runtime-launchers-v2\n', 0o644);
  return { parent, generation, state };
}

(ready ? describe : describe.skip)('Desktop account traversal of the private state parent', () => {
  it('runs the app and writes its log on the installed layout, repeatedly, without exposing private siblings', async () => {
    const { parent, generation, state } = installedLayout();
    expect(asAccount(`"${generation}/app.sh"`).status).not.toBe(0); // RED: the 0700 parent blocks the app.
    const before = acl(parent);
    for (let launch = 0; launch < 3; launch++) await ensureDesktopAccountTraversal(ACCOUNT, [{ parent, desktopRoots }]);
    const ran = asAccount(`"${generation}/app.sh" && printf supervisor-log > "${state}/logs/output.log" && cat "${state}/logs/output.log"`);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('desktop-app-ran\nsupervisor-log');
    expect(acl(parent).split('\n').filter(Boolean).sort()).toEqual([...before.split('\n').filter(Boolean), `user:${ACCOUNT.uid}:--x`, 'mask::--x'].sort());
    expect(asAccount(`ls "${parent}"`).status).not.toBe(0);
    for (const secret of ['opencode/private', 'backup-trust/private', 'hermes/private', 'desktop-build-jobs/private', 'agent-zero-project-model-bridge/bridge.env', 'remote-desktop-ai-launchers.lock', 'desktop-projects/p1/deployment.json']) {
      expect(asAccount(`cat "${parent}/${secret}"`).status).not.toBe(0);
    }
    expect(asAccount(`cat "${state}/promotion.json"`).status).not.toBe(0);
    expect(asAccount(`cat "${parent}/remote-desktop-ai-launchers/manifest.tsv"`).status).toBe(0); // shared by design
    expect(fs.statSync(parent).mode & 0o007).toBe(0);
  });

  it('refuses rather than widening an unexpected sibling', async () => {
    const { parent, generation } = installedLayout();
    dir(path.join(parent, 'unexpected-shared'), 0o755);
    await expect(ensureDesktopAccountTraversal(ACCOUNT, [{ parent, desktopRoots }])).rejects.toThrow(/unexpected-shared/);
    expect(acl(parent)).not.toContain(`user:${ACCOUNT.uid}`);
    expect(asAccount(`"${generation}/app.sh"`).status).not.toBe(0);
  });

  it('never re-masks an unrelated named entry and keeps the owning group effective permissions', async () => {
    const masked = installedLayout().parent;
    expect(spawnSync('/usr/bin/setfacl', ['-n', '-m', 'u:12346:rwx,m::---', masked]).status).toBe(0);
    const before = acl(masked);
    await expect(ensureDesktopAccountTraversal(ACCOUNT, [{ parent: masked, desktopRoots }])).rejects.toThrow(/other access-control entries/);
    expect(acl(masked)).toBe(before);
    const grouped = installedLayout().parent; fs.chmodSync(grouped, 0o750);
    await ensureDesktopAccountTraversal(ACCOUNT, [{ parent: grouped, desktopRoots }]);
    expect(acl(grouped)).toContain('group::r-x');
    expect(acl(grouped)).toContain('mask::r-x');
    expect(acl(grouped)).toContain(`user:${ACCOUNT.uid}:--x`);
  });

  it('refuses when a private sibling grants the account (or one of its groups) access through an ACL', async () => {
    // Fixture proof: opening the parent really would expose such siblings.
    const named = installedLayout().parent;
    expect(spawnSync('/usr/bin/setfacl', ['-m', `u:${ACCOUNT.uid}:r-x`, path.join(named, 'hermes')]).status).toBe(0);
    expect(spawnSync('/usr/bin/setfacl', ['-n', '-m', `u:${ACCOUNT.uid}:--x,m::--x`, named]).status).toBe(0);
    expect(asAccount(`cat "${named}/hermes/private"`).status).toBe(0);
    // Fail closed on a fresh parent: the guard sees the named entry and changes nothing.
    const guarded = installedLayout().parent;
    expect(spawnSync('/usr/bin/setfacl', ['-m', `u:${ACCOUNT.uid}:r-x`, path.join(guarded, 'hermes')]).status).toBe(0);
    await expect(ensureDesktopAccountTraversal(ACCOUNT, [{ parent: guarded, desktopRoots }])).rejects.toThrow(/hermes/);
    expect(acl(guarded)).not.toContain(`user:${ACCOUNT.uid}`);
    expect(asAccount(`cat "${guarded}/hermes/private"`).status).not.toBe(0);
    // A supplementary group of the account counts like its primary group.
    const grouped = installedLayout().parent;
    fs.chownSync(path.join(grouped, 'opencode'), 0, 12347); fs.chmodSync(path.join(grouped, 'opencode'), 0o750);
    await expect(ensureDesktopAccountTraversal({ ...ACCOUNT, groups: [65534, 12347] }, [{ parent: grouped, desktopRoots }])).rejects.toThrow(/opencode/);
    expect(acl(grouped)).not.toContain(`user:${ACCOUNT.uid}`);
    expect(spawnSync('/usr/bin/setfacl', ['-n', '-m', `u:${ACCOUNT.uid}:--x,m::--x`, grouped]).status).toBe(0);
    expect(asAccount(`cat "${grouped}/opencode/private"`, [12347]).status).toBe(0); // the exposure the refusal prevents
  });

  it('refuses rather than unmasking an owning group hidden by the current mask', async () => {
    const { parent, generation } = installedLayout();
    fs.chownSync(parent, 0, 12348);
    expect(spawnSync('/usr/bin/setfacl', ['-n', '-m', 'g::r-x,m::---', parent]).status).toBe(0);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700); // looks private through mode bits
    const groupMember = (script: string) => spawnSync('/usr/bin/setpriv', ['--reuid=65533', '--regid=65533', '--groups=12348', '/bin/sh', '-c', script], { encoding: 'utf8' });
    expect(groupMember(`ls "${parent}"`).status).not.toBe(0);
    const before = acl(parent);
    await expect(ensureDesktopAccountTraversal(ACCOUNT, [{ parent, desktopRoots }])).rejects.toThrow(/masks its owning group/);
    expect(acl(parent)).toBe(before);
    expect(groupMember(`ls "${parent}"`).status).not.toBe(0); // unrelated group stays denied
    expect(asAccount(`"${generation}/app.sh"`).status).not.toBe(0);
  });
});
