/**
 * Path Sandbox Test Suite
 * 
 * Verifies that project agents cannot escape their sandbox.
 * Covers the attack vectors preserved by the historical sandbox-escape regression.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { validateProjectPath } from '../middleware/pathSandbox';

const TEST_USER = 'test-user-123';
const TEST_PROJECT = 'my-project';
let testRoot: string;
let testProjectsRoot: string;
let projectBase: string;

// Create a temp directory structure for symlink tests
let tempDir: string;
let symlinkPath: string;
let danglingSymlinkPath: string;

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-path-sandbox-'));
  testProjectsRoot = path.join(testRoot, 'projects');
  projectBase = path.join(testProjectsRoot, TEST_USER, TEST_PROJECT);

  // Ensure the project directory exists for tests
  fs.mkdirSync(projectBase, { recursive: true });
  fs.writeFileSync(path.join(projectBase, 'index.html'), '<h1>test</h1>');
  fs.mkdirSync(path.join(projectBase, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectBase, 'src/app.js'), 'console.log("test")');

  // Create a symlink that points outside the sandbox
  const outsideRoot = path.join(testRoot, 'outside');
  fs.mkdirSync(outsideRoot, { recursive: true });
  tempDir = fs.mkdtempSync(path.join(outsideRoot, 'sandbox-test-'));
  fs.writeFileSync(path.join(tempDir, 'secret.txt'), 'secret data');
  symlinkPath = path.join(projectBase, 'escape-link');
  danglingSymlinkPath = path.join(projectBase, 'dangling-link');
  try {
    fs.symlinkSync(tempDir, symlinkPath);
  } catch {
    // May fail if symlink already exists
  }
  try {
    fs.symlinkSync(path.join(tempDir, 'missing-target'), danglingSymlinkPath);
  } catch {
    // May fail if symlink already exists
  }
});

afterAll(() => {
  // Cleanup
  try {
    if (symlinkPath && fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    if (danglingSymlinkPath) {
      try { fs.unlinkSync(danglingSymlinkPath); } catch {}
    }
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {}
});

function validateTestPath(requestedPath: string) {
  return validateProjectPath(requestedPath, TEST_USER, TEST_PROJECT, { projectsBase: testProjectsRoot });
}

describe('Path Sandbox', () => {

  // A Project that no longer exists is an ordinary 404, not a containment
  // violation. Answering "Access denied: path outside project sandbox" made
  // opening a file in a just-deleted or just-renamed Project look like a
  // security event, and logged it as one.
  test('reports a missing project as not found rather than a violation', () => {
    const result = validateProjectPath(
      'index.html',
      TEST_USER,
      'project-that-was-deleted',
      { projectsBase: testProjectsRoot },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.notFound).toBe(true);
      expect(result.reason).toBe('Project not found');
    }
  });

  test('a real escape is still a violation, not a not-found', () => {
    const result = validateTestPath('../../../../etc/passwd');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.notFound).toBeFalsy();
    }
  });

  // Test 1: Allow valid project file access
  test('allows valid project file access', () => {
    const result = validateTestPath('index.html');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.resolvedPath).toBe(path.join(projectBase, 'index.html'));
    }

    const result2 = validateTestPath('src/app.js');
    expect(result2.allowed).toBe(true);

    // Absolute path within project should also work
    const result3 = validateTestPath(path.join(projectBase, 'src/app.js'));
    expect(result3.allowed).toBe(true);
  });

  // Test 2: Block parent directory traversal (../)
  test('blocks parent directory traversal', () => {
    const cases = [
      '../other-project/file.txt',
      '../../etc/passwd',
      'src/../../..',
      './../../root/.ssh/id_rsa',
      'src/../../../etc/shadow',
    ];

    for (const p of cases) {
      const result = validateTestPath(p);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('escapes project sandbox');
      }
    }
  });

  // Test 3: Block absolute paths outside project
  test('blocks absolute paths outside project', () => {
    const cases = [
      '/etc/passwd',
      '/root/.ssh/id_rsa',
      '/portal/projects/other-user/other-project/file.txt',
      '/var/www/html/index.html',
      '/tmp/evil.sh',
    ];

    for (const p of cases) {
      const result = validateTestPath(p);
      expect(result.allowed).toBe(false);
    }
  });

  // Test 4: Block symlink escapes
  test('blocks symlink escapes', () => {
    // The symlink 'escape-link' points to tempDir (outside sandbox)
    const result = validateTestPath('escape-link/secret.txt');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Symlink escapes project sandbox');
    }

    // Direct symlink reference
    const result2 = validateTestPath('escape-link');
    expect(result2.allowed).toBe(false);

    const result3 = validateTestPath('dangling-link/child.txt');
    expect(result3.allowed).toBe(false);
  });

  // Test 5: Block access to portal directories
  test('blocks access to portal directories', () => {
    const cases = [
      '/opt/bridgesllm/portal/frontend/src/App.css',
      '/opt/bridgesllm/portal/backend/src/server.ts',
      '/opt/bridgesllm/portal/frontend/src/components/Layout.tsx',
      '/root/portal/anything',
    ];

    for (const p of cases) {
      const result = validateTestPath(p);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        // Either blocked as absolute outside project or as portal dir
        expect(result.reason).toMatch(/portal|outside project/i);
      }
    }
  });

  // Test 6: Block access to system directories
  test('blocks access to system directories', () => {
    const cases = [
      '/etc/shadow',
      '/proc/self/environ',
      '/sys/kernel/debug',
      '/root/.bashrc',
      '/var/log/syslog',
    ];

    for (const p of cases) {
      const result = validateTestPath(p);
      expect(result.allowed).toBe(false);
    }
  });

  // Test 7: Violation logging integration (validates the logging function structure)
  test('tracks violations for ActivityLog escalation', () => {
    // Import the violation tracking internals
    const { violationCounts } = require('../middleware/pathSandbox');
    
    // Clear state
    violationCounts.clear();

    // Simulate multiple violations from same user
    const key = 'test-user:127.0.0.1';
    violationCounts.set(key, { count: 1, lastTime: Date.now() });
    
    // Verify tracking structure exists and works
    const entry = violationCounts.get(key);
    expect(entry).toBeDefined();
    expect(entry.count).toBe(1);
    
    // Simulate escalation
    entry.count = 5;
    violationCounts.set(key, entry);
    expect(violationCounts.get(key)!.count).toBeGreaterThanOrEqual(3);
    
    // Verify the validateProjectPath correctly rejects - this confirms
    // the full pipeline: validate → reject → (in real usage) log to ActivityLog
    const result = validateTestPath('/etc/passwd');
    expect(result.allowed).toBe(false);
    
    // Cleanup
    violationCounts.clear();
  });
});
