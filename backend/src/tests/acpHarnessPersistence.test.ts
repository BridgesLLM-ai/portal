import fs from 'fs';
import path from 'path';

describe('Hermes/OpenCode provider persistence migration', () => {
  test('adds both exact provider enum values without persisting DeepSeek preview', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const migration = fs.readFileSync(path.resolve(
      __dirname,
      '../../prisma/migrations/20260820_agent_harness_hermes_opencode/migration.sql',
    ), 'utf8');

    expect(schema).toMatch(/enum AgentProviderType\s*\{[\s\S]*\bHERMES\b[\s\S]*\bOPENCODE\b[\s\S]*\}/u);
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'HERMES'");
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'OPENCODE'");
    expect(migration).not.toMatch(/ADD VALUE[^\n]*DEEPSEEK_HARNESS/u);
  });

  test('keeps both harnesses out of every Project Chat persistence boundary', () => {
    const migration = fs.readFileSync(path.resolve(
      __dirname,
      '../../prisma/migrations/20260820_agent_harness_hermes_opencode/migration.sql',
    ), 'utf8');
    const projectConstraints = [
      ['ProjectChatState', 'selectedProvider'],
      ['ProjectChatTurn', 'provider'],
      ['ProjectChatProviderBinding', 'provider'],
      ['ProjectChatSession', 'activeProvider'],
      ['ProjectChatMessage', 'provider'],
    ] as const;

    for (const [table, column] of projectConstraints) {
      expect(migration).toContain(`ALTER TABLE "${table}"`);
      expect(migration).toMatch(new RegExp(
        `CHECK \\(\"${column}\"(?:::\\w+)? NOT IN \\('HERMES', 'OPENCODE'\\)\\)`,
        'u',
      ));
    }
  });

  test('ships no Hermes/OpenCode Project adapter, route, image, or frontend parser', () => {
    const root = path.resolve(__dirname, '../..');
    for (const relative of [
      'src/agents/providers/native/projectSandbox/AcpProjectProvider.ts',
      'src/agents/providers/native/projectSandbox/AcpProjectSandbox.ts',
      '../installer/hermes-project-sandbox.Dockerfile',
      '../installer/opencode-project-sandbox.Dockerfile',
      '../installer/acp-project-protocol-smoke.mjs',
    ]) {
      expect(fs.existsSync(path.resolve(root, relative))).toBe(false);
    }

    for (const relative of [
      'src/services/projectChatProviderRegistry.ts',
      'src/services/projectChatKernel.ts',
      'src/services/openclawProjectQualification.ts',
      'src/routes/projects.ts',
      '../frontend/src/api/endpoints.ts',
      '../frontend/src/components/chat/ProjectChatPanel.tsx',
      '../frontend/src/components/chat/ProjectProviderMenu.tsx',
      '../frontend/src/components/chat/projectChatProviderState.ts',
      '../frontend/src/utils/projectChatPendingSend.ts',
    ]) {
      expect(fs.readFileSync(path.resolve(root, relative), 'utf8'))
        .not.toMatch(/\b(?:HERMES|OPENCODE)\b/u);
    }
  });
});
