const base = require('./jest.config');
const rootAttestedTests = require('./jest.root-attested-tests');

module.exports = {
  ...base,
  testMatch: rootAttestedTests.map((relativePath) => `<rootDir>/${relativePath}`),
};
