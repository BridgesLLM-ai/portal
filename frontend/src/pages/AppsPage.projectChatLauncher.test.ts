import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectsSource = readFileSync(new URL('./AppsPage.tsx', import.meta.url), 'utf8');

describe('Project Chat launcher surface', () => {
  it('keeps the canonical toolbar launchers accessible', () => {
    expect(projectsSource).toContain("{ label: 'Project Chat'");
    expect(projectsSource).toContain("aria-label={agentChatOpen ? 'Close Project Chat' : 'Open Project Chat'}");
    expect(projectsSource).toContain('aria-pressed={agentChatOpen}');
    expect(projectsSource).toContain('<Bot size={12} /> Project Chat');
  });

  it('does not restore the obsolete floating Project Chat button', () => {
    expect(projectsSource).not.toContain('Floating Agent Button');
    expect(projectsSource).not.toContain('aria-label="Chat with project agent"');
    expect(projectsSource).not.toContain('title="Chat with Agent"');
  });
});
