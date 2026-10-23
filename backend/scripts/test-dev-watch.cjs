// Exercises the actual npm dev command in a disposable workspace; never starts Portal.
// Explicit source paths preserve add/delete recovery without watching runtime storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dev-watch-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
let child;
let output = '';
let exit;
const observedPids = new Set();
const checks = [];
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
async function until(predicate, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; if (exit !== undefined) throw new Error(`watcher exited: ${JSON.stringify(exit)}\n${output.slice(-8000)}`); await delay(50); }
  throw new Error(`Timed out: ${label}\n${output.slice(-8000)}`);
}
function boots() {
  return output.split('\n').filter(line => line.startsWith('{"boot":')).map(line => {
    const entry = JSON.parse(line); observedPids.add(entry.pid); return entry;
  });
}
function write(rel, text) { const filename = path.join(fixture, rel); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); }
function entry(revision, extra = false) {
  return `import http from 'node:http';\nimport { value } from './value';\n${extra ? "import { extra } from './extra';" : ''}\nconst typed: number = ${revision};\nconst server = http.createServer((_req, res) => res.end(String(typed)));\nserver.listen(0, '127.0.0.1', () => console.log(JSON.stringify({boot: typed, value, extra: ${extra ? 'extra' : 'null'}, pid: process.pid})));\nprocess.on('SIGTERM', () => { console.log('STOP ' + process.pid); server.close(() => process.exit(0)); });\n`;
}
(async () => {
  try {
    fs.symlinkSync(path.join(backend, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    const tsconfig = JSON.parse(fs.readFileSync(path.join(backend, 'tsconfig.json')));
    write('tsconfig.json', JSON.stringify(tsconfig));
    write('src/value.ts', 'export const value: number = 1;\n');
    write('src/server.ts', entry(1));
    const dev = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'))).scripts.dev;
    write('package.json', JSON.stringify({ name: 'portal-dev-watch-fixture', private: true, type: 'commonjs', scripts: { dev } }));
    assert.equal(dev, 'node --watch --watch-path=src --watch-path=tsconfig.json --watch-path=package.json --watch-preserve-output -r ts-node/register src/server.ts');
    child = spawn(process.execPath, dev.split(' ').slice(1), {
      cwd: fixture, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, TS_NODE_PROJECT: path.join(fixture, 'tsconfig.json'), NO_COLOR: '1' }
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', (code, signal) => { exit = { code, signal }; });
    await until(() => boots().some(b => b.boot === 1), 'TypeScript initial boot');
    record('existing ts-node TypeScript execution and HTTP startup');
    let prior = boots().at(-1).pid;
    write('src/server.ts', entry(2));
    await until(() => boots().some(b => b.boot === 2), 'entry change');
    assert(!alive(prior), 'old entry process must exit');
    record('entry change restarts without surviving prior process');
    prior = boots().at(-1).pid;
    write('src/value.ts', 'export const value: number = 2;\n');
    await until(() => boots().some(b => b.value === 2), 'imported dependency change');
    assert(!alive(prior));
    record('imported dependency change restarts');
    write('src/extra.ts', 'export const extra: string = "added";\n');
    write('src/server.ts', entry(3, true));
    await until(() => boots().some(b => b.boot === 3 && b.extra === 'added'), 'new imported file');
    record('new source file is loaded when imported');
    const beforeDelete = boots().length;
    fs.unlinkSync(path.join(fixture, 'src/extra.ts'));
    await until(() => output.includes('TS2307') || output.includes('MODULE_NOT_FOUND'), 'deleted dependency reports failure');
    write('src/extra.ts', 'export const extra: string = "restored";\n');
    await until(() => boots().length > beforeDelete && boots().at(-1).extra === 'restored', 'deleted dependency restored');
    record('delete failure is visible and restoring file recovers');
    const count = boots().length;
    for (const dir of ['uploads', '.data', 'dist', 'storage']) write(`${dir}/unrelated.json`, '{"value":1}');
    await delay(1300);
    assert.equal(boots().length, count, 'unimported runtime data must not restart server');
    record('runtime data and build output changes do not restart');
    const lastPid = boots().at(-1).pid;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (exit === undefined || alive(lastPid))) await delay(50);
    assert(exit !== undefined, 'watch parent must stop');
    assert(!alive(lastPid), 'app child must stop');
    assert([...observedPids].every(pid => !alive(pid)), 'no fixture server may survive');
    record('SIGTERM stops watcher and all observed app processes');
    console.log(JSON.stringify({ status: 'PASS', node: process.version, checks, total: checks.length }));
  } finally {
    if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
