/** Execute the shipping route's archive-completion block with real archiver
 * and file streams. Inject only a filesystem close that misses its deadline. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { Writable } from 'stream';
import { feedProjectDownloadArchive, closeProjectDownloadSource } from '../services/projectDownloadSnapshot';
const { ZipArchive } = require('archiver');
const source = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
const file = ts.createSourceFile('projects.ts', source, ts.ScriptTarget.Latest, true);
const route = file.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(file) === 'router.get'
  && node.expression.arguments[0]?.getText(file) === "'/:name/download'") as ts.ExpressionStatement;
const call = route.expression as ts.CallExpression;
const body = (call.arguments[call.arguments.length - 1] as ts.ArrowFunction).body as ts.Block;
const attempt = body.statements.find(ts.isTryStatement)!;
const start = attempt.tryBlock.statements.findIndex(n => ts.isVariableStatement(n)
  && n.declarationList.declarations.some(d => d.name.getText(file) === 'fed'));
if (start < 0) throw new Error('Shipping archive completion block missing');
const completion = attempt.tryBlock.statements.slice(start).map(n => n.getText(file)).join('\n');
const js = ts.transpileModule(`async function finish() { let activeArchiveSource = null; ${completion} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

describe('Project download finalization', () => {
  test.each([false, true])('close-timeout=%s cannot produce a successful partial ZIP', async delayedClose => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-completion-'));
    const archive = new ZipArchive(), lifecycle = new AbortController();
    const chunks: Buffer[] = [];
    const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    archive.on('error', () => undefined);
    archive.pipe(response);
    lifecycle.signal.addEventListener('abort', () => archive.abort(), { once: true });
    const finalize = jest.spyOn(archive, 'finalize');
    const plan = ['first.txt', 'last.txt'].map(relPath => {
      const fullPath = path.join(root, relPath); fs.writeFileSync(fullPath, relPath);
      return { fullPath, relPath, mode: 0o100644, mtime: new Date(), strip: false, store: false };
    });
    let held: fs.ReadStream | undefined, heldDestroy: (() => fs.ReadStream) | undefined, feedResult: any;
    const onSourceError = jest.fn();
    const feed = async (input: Parameters<typeof feedProjectDownloadArchive>[0]) => {
      feedResult = await feedProjectDownloadArchive({ ...input, closeTimeoutMs: 40,
        onSourceError: error => { onSourceError(error); input.onSourceError?.(error); },
        onSourceOpened: source => {
          input.onSourceOpened?.(source);
          if (delayedClose && !held) {
            held = source; heldDestroy = source.destroy.bind(source);
            (source as fs.ReadStream & { autoClose: boolean }).autoClose = false; source.destroy = () => source;
          }
        },
      });
      return feedResult;
    };
    const deps = { archive, archivePlan: plan, res: response, exportLifecycle: lifecycle,
      feedProjectDownloadArchive: feed, stripCommentsFromCode: (s: string) => s,
      path, name: 'fixture', mode: 'clean', console: { warn: jest.fn(), log: jest.fn() } };
    try {
      await new Function(...Object.keys(deps), `${js}; return finish;`)(...Object.values(deps))();
      const zip = Buffer.concat(chunks), end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (delayedClose) {
        expect(feedResult.failed).toBe(true); expect(feedResult.openSource).toBe(held);
        expect(onSourceError).not.toHaveBeenCalled(); // Original missed condition: no cancellation or error event.
        expect(lifecycle.signal.aborted).toBe(true); expect(response.destroyed).toBe(true);
        expect(finalize).not.toHaveBeenCalled(); expect(end).toBe(-1);
      } else {
        expect(feedResult.failed).toBe(false); expect(lifecycle.signal.aborted).toBe(false);
        expect(finalize).toHaveBeenCalledTimes(1); expect(end).toBeGreaterThan(0);
        expect(zip.readUInt16LE(end + 10)).toBe(2);
      }
    } finally {
      if (held && heldDestroy) { held.destroy = heldDestroy; heldDestroy(); await closeProjectDownloadSource(held); }
      archive.abort(); response.destroy(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
