import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import sharp from 'sharp';
import { prepareColorRaster, validateRasterJpeg } from './imageRaster';
import { runSandboxed } from './chatImageSandbox';

describe('shipping photo worker in real namespaces', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-photo-worker-')); fs.chmodSync(root, 0o755);
    // Test-only transpilation, not a product build or a change to dist/.
    for (const file of ['imageRasterWorker', 'imageRasterContract']) {
      const source = fs.readFileSync(path.join(__dirname, `${file}.ts`), 'utf8');
      fs.writeFileSync(path.join(root, `${file}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, { mode: 0o644 });
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  it('rasterizes a real photo through the bounded, read-only, networkless worker', async () => {
    const input = await sharp({ create: { width: 17, height: 11, channels: 3, background: 'blue' } }).png().toBuffer();
    const result = await prepareColorRaster({ appDir: root, script: '/mnt/app/imageRasterWorker.js',
      modulesDir: fs.realpathSync(path.resolve(__dirname, '../../../node_modules')) }, input);
    expect(result).toMatchObject({ ok: true, width: 17, height: 11 });
    expect(validateRasterJpeg(Buffer.from(result.data, 'base64'), 17, 11)).toBe(true);
  }, 20_000);
  it('has no host environment, runs unprivileged and cannot read hidden state or write its source', async () => {
    fs.writeFileSync(path.join(root, 'probe.js'), `const fs=require('fs'); const can=p=>{try{fs.readdirSync(p);return true}catch{return false}};
      let writable=true;try{fs.writeFileSync('/mnt/app/altered','bad')}catch{writable=false};
      console.log(JSON.stringify({uid:process.getuid(),env:process.env.DATABASE_URL||null,root:fs.readdirSync('/root'),writable,net:fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length}));`);
    const result = await runSandboxed({ binds: [{ source: root, name: 'app' }], script: '/mnt/app/probe.js', input: Buffer.alloc(0),
      dataBytes: 1536 * 1024 * 1024, cpuSeconds: 5, heapMegabytes: 128, maxOutputBytes: 4096, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout.toString())).toEqual({ uid: 65534, env: null, root: [], writable: false, net: 1 });
  }, 15_000);
  it('kills a worker that exceeds output or wall-clock limits', async () => {
    const options = { binds: [{ source: root, name: 'app' }], script: '/mnt/app/limit.js', input: Buffer.alloc(0),
      dataBytes: 1536 * 1024 * 1024, cpuSeconds: 5, heapMegabytes: 128, maxOutputBytes: 32, timeoutMs: 2000 };
    fs.writeFileSync(path.join(root, 'limit.js'), "process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000);");
    const output = await runSandboxed(options);
    expect(output.outputTruncated).toBe(true); expect(output.stdout.length).toBeLessThanOrEqual(32);
    fs.writeFileSync(path.join(root, 'limit.js'), 'setInterval(()=>{},1000);');
    const timeout = await runSandboxed({ ...options, timeoutMs: 500 });
    expect(timeout.timedOut).toBe(true); expect(timeout.signal).toBe('SIGKILL');
  }, 10_000);

});
