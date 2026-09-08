#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const jestBin = path.join(backendRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const rootAttestedTests = require('../jest.root-attested-tests');

function fail(message) {
  process.stderr.write(`backend-jest-lanes: FAIL: ${message}\n`);
  process.exit(1);
}

function listTests(configName) {
  const result = spawnSync(
    process.execPath,
    [
      jestBin,
      '--config',
      path.join(backendRoot, configName),
      '--listTests',
      '--runInBand',
    ],
    {
      cwd: backendRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.error) {
    fail(`${configName} could not list tests: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${configName} exited ${String(result.status)} while listing tests:\n`
      + `${result.stderr || result.stdout}`,
    );
  }

  const listed = result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((testPath) => path.resolve(testPath));

  if (listed.length === 0) {
    fail(`${configName} selected no tests`);
  }

  const unique = new Set(listed);
  if (unique.size !== listed.length) {
    fail(`${configName} selected a test more than once`);
  }

  return unique;
}

function sortedDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

const allTests = listTests('jest.config.js');
const ordinaryTests = listTests('jest.ci-nonroot.config.js');
const rootTests = listTests('jest.root-attested.config.js');
const expectedRootTests = new Set(
  rootAttestedTests.map((relativePath) => path.join(backendRoot, relativePath)),
);

const missingRootTests = sortedDifference(expectedRootTests, rootTests);
const unexpectedRootTests = sortedDifference(rootTests, expectedRootTests);
if (missingRootTests.length > 0 || unexpectedRootTests.length > 0) {
  fail(
    'root-attested selection does not exactly match its manifest'
    + `\nmissing: ${missingRootTests.join(', ') || '(none)'}`
    + `\nunexpected: ${unexpectedRootTests.join(', ') || '(none)'}`,
  );
}

const overlap = [...rootTests]
  .filter((testPath) => ordinaryTests.has(testPath))
  .sort();
if (overlap.length > 0) {
  fail(`ordinary and root-attested lanes overlap: ${overlap.join(', ')}`);
}

const partitionedTests = new Set([...ordinaryTests, ...rootTests]);
const missingTests = sortedDifference(allTests, partitionedTests);
const unexpectedTests = sortedDifference(partitionedTests, allTests);
if (missingTests.length > 0 || unexpectedTests.length > 0) {
  fail(
    'ordinary and root-attested lanes do not exactly partition the base Jest suite'
    + `\nmissing: ${missingTests.join(', ') || '(none)'}`
    + `\nunexpected: ${unexpectedTests.join(', ') || '(none)'}`,
  );
}

process.stdout.write(
  `backend-jest-lanes: PASS (${ordinaryTests.size} ordinary + ${rootTests.size} root-attested = ${allTests.size} total)\n`,
);
