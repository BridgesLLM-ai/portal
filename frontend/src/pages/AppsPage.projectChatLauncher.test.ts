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

  it('shows a local loading and recovery surface when the Project Chat chunk cannot open', () => {
    expect(projectsSource).toContain('class ProjectChatChunkBoundary');
    expect(projectsSource).toContain('Project Chat didn’t load');
    expect(projectsSource).toContain('Loading Project Chat…');
    expect(projectsSource).not.toContain('<Suspense fallback={null}>');
  });

  it('cancels delayed chat restoration when the selected project changes', () => {
    expect(projectsSource).toContain('const timer = window.setTimeout');
    expect(projectsSource).toContain('selectedProjectRef.current === selectedProject');
    expect(projectsSource).toContain('return () => window.clearTimeout(timer);');
  });

  it('keeps project and file request failures distinct from honest empty states', () => {
    expect(projectsSource).toContain('Projects couldn’t be loaded');
    expect(projectsSource).toContain('Files couldn’t be loaded');
    expect(projectsSource).toContain('projects.length === 0 && !projectsError');
    expect(projectsSource).toContain("tree.length > 0 ? renderTree(tree) : !treeError");
    expect(projectsSource).toContain('Loading files…');
    expect(projectsSource).not.toContain("logError(err, 'Loading projects')");
    expect(projectsSource).not.toContain('logError(err, `Loading project');
    expect(projectsSource).not.toContain("logError(err, 'Refreshing file tree')");
    expect(projectsSource).not.toContain('logError(err, `Expanding directory');
  });

  it('keeps an unavailable project visible while disabling actions with its recovery reason', () => {
    expect(projectsSource).toContain('project-availability-${p.identity.id}');
    expect(projectsSource).toContain('p.availability?.available === false');
    expect(projectsSource).toContain('<p>{p.availability.message}</p>');
    expect(projectsSource).toContain('!currentProjectAvailable');
    expect(projectsSource).toContain('targetProject.availability?.available === false');
    expect(projectsSource).toContain('restorableProject.availability?.available === false');
    expect(projectsSource).toContain('Administrator reconciliation is required.');
  });
});
