const path = require('path');
const base = require('./jest.config');
const rootAttestedTests = require('./jest.root-attested-tests');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  ...base,
  testPathIgnorePatterns: rootAttestedTests.map((relativePath) => (
    `${escapeRegex(path.join(__dirname, relativePath))}$`
  )),
};
