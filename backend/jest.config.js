module.exports = {
  preset: 'ts-jest',
  // Archive producers, security-fixed parsers and httpxy use native ESM. Node 22 loads them
  // from this CommonJS backend; Jest's VM needs the real packages transformed.
  // Do not replace the sanitizer or proxy with mocks in security acceptance.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
    '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true, checkJs: false, isolatedModules: true } }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(nanoid|archiver|zip-stream|compress-commons|crc32-stream|is-stream|httpxy|sanitize-html|htmlparser2|domhandler|domelementtype|domutils|dom-serializer|entities)/)',
  ],
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  // Backup/restore contract suites launch real shell processes with bounded
  // deadlines.  A wide worker fan-out starves those processes and made the
  // release gate nondeterministic even though the same suites passed alone.
  // Two workers is the measured stable ceiling and still keeps independent
  // suites parallel.
  maxWorkers: 2,
};
