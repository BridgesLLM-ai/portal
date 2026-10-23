import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { copyDesktopBuildGeneration, DESKTOP_CHILD_SUPERVISOR } from './projectDesktopDeployment';
const roots: string[] = [];
const directory = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-generation-')); roots.push(value); return value; };
afterEach(() => { roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })); });
it('promotes built output without compiler caches or writable source', async () => {
  const source = directory(), parent = directory(), target = path.join(parent, 'generation');
  fs.mkdirSync(path.join(source, '.desktop-out')); fs.writeFileSync(path.join(source, '.desktop-out/app'), 'compiled', { mode: 0o777 });
  fs.mkdirSync(path.join(source, 'target')); fs.writeFileSync(path.join(source, 'target/large-cache'), 'cache');
  fs.mkdirSync(path.join(source, '.venv')); fs.writeFileSync(path.join(source, '.venv/unsafe-interpreter'), 'cache');
  fs.writeFileSync(path.join(source, 'main.ts'), 'source', { mode: 0o666 });
  const digest = await copyDesktopBuildGeneration(source, target);
  expect(digest).toMatch(/^[a-f0-9]{64}$/); expect(fs.existsSync(path.join(target, 'target'))).toBe(false);
  expect(fs.existsSync(path.join(target, '.venv'))).toBe(false);
  expect(fs.readFileSync(path.join(target, '.desktop-out/app'), 'utf8')).toBe('compiled');
  expect(fs.statSync(path.join(target, '.desktop-out/app')).mode & 0o777).toBe(0o755);
  expect(fs.statSync(path.join(target, 'main.ts')).mode & 0o777).toBe(0o644);
});
it('retains contained dependency links but refuses escaped ones', async () => {
  const source = directory(), parent = directory(), outside = directory();
  fs.mkdirSync(path.join(source, 'node_modules')); fs.mkdirSync(path.join(source, 'node_modules/.bin'));
  fs.writeFileSync(path.join(source, 'node_modules/tool.js'), 'tool'); fs.symlinkSync('../tool.js', path.join(source, 'node_modules/.bin/tool'));
  await copyDesktopBuildGeneration(source, path.join(parent, 'good'));
  expect(fs.readFileSync(path.join(parent, 'good/node_modules/.bin/tool'), 'utf8')).toBe('tool');
  fs.writeFileSync(path.join(outside, 'secret'), 'private'); fs.symlinkSync(path.join(outside, 'secret'), path.join(source, 'escape'));
  await expect(copyDesktopBuildGeneration(source, path.join(parent, 'bad'))).rejects.toThrow('escaping');
});
it.each([0, 7])('observes the actual child exit %i and captures logs', code => {
  const root = directory(), log = path.join(root, 'output.log'), exit = path.join(root, 'exit.json');
  const input = { generation: 'fixture', cwd: root, executable: process.execPath,
    args: ['-e', 'console.log("actual-output");console.error("actual-error");process.exit(' + code + ')'],
    environment: { BRIDGESLLM_APP_DATA: root }, log, exit };
  const result = spawnSync(process.execPath, ['-e', DESKTOP_CHILD_SUPERVISOR, Buffer.from(JSON.stringify(input)).toString('base64url')], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status).toBe(code); expect(JSON.parse(fs.readFileSync(exit, 'utf8')).exitCode).toBe(code);
  const output = fs.readFileSync(log, 'utf8'); expect(output).toContain('actual-output'); expect(output).toContain('actual-error');
});
