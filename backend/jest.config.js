module.exports = {
  preset: 'ts-jest',
  // sanitize-html's security-fixed parser uses native ESM. Node 22 loads it
  // from this CommonJS backend; Jest's VM needs the real parser transformed.
  // Do not mock the sanitizer out of mail/security acceptance.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, checkJs: false, isolatedModules: true } }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(sanitize-html|htmlparser2|domhandler|domelementtype|domutils|dom-serializer|entities)/)',
  ],
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Backup/restore contract suites launch real shell processes with bounded
  // deadlines.  A wide worker fan-out starves those processes and made the
  // release gate nondeterministic even though the same suites passed alone.
  // Two workers is the measured stable ceiling and still keeps independent
  // suites parallel.
  maxWorkers: 2,
};
