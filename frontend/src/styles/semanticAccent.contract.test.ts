import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const sources = {
  activityLog: read('../components/ActivityLogTable.tsx'),
  admin: read('../pages/AdminPage.tsx'),
  agentSelector: read('../components/chat/AgentSelector.tsx'),
  agentTools: read('../pages/AgentToolsPage.tsx'),
  apps: read('../pages/AppsPage.tsx'),
  automations: read('../pages/AutomationsPage.tsx'),
  commandPalette: read('../components/CommandPalette.tsx'),
  dashboard: read('../pages/DashboardPage.tsx'),
  files: read('../pages/FilesPage.tsx'),
  fileTree: read('../components/FileTree.tsx'),
  fileTreeEnhanced: read('../components/FileTreeEnhanced.tsx'),
  mediaViewer: read('../components/MediaViewer.tsx'),
  modelSelector: read('../components/ai-setup/ModelSelector.tsx'),
  settings: read('../pages/SettingsPage.tsx'),
  setupWizard: read('../pages/SetupWizardPage.tsx'),
  skills: read('../pages/SkillsPage.tsx'),
  slashCommands: read('../components/chat/SlashCommandMenu.tsx'),
  terminal: read('../pages/TerminalPage.tsx'),
  theme: read('./themes.css'),
} as const;

type SourceName = keyof typeof sources;

const accentContracts: Array<{
  source: SourceName;
  expected: string[];
}> = [
  {
    source: 'commandPalette',
    expected: ["? 'accent-active border-l-2'", "? 'accent-text' : 'text-slate-400'"],
  },
  { source: 'fileTree', expected: ["isSelected ? 'accent-active'"] },
  {
    source: 'fileTreeEnhanced',
    expected: ["isSelected ? 'accent-active'", "isFocused && !isSelected ? 'ring-2 accent-ring bg-white/5'"],
  },
  { source: 'mediaViewer', expected: ["? 'accent-active border'"] },
  {
    source: 'modelSelector',
    expected: ["? 'accent-active'", 'accentColor: \'var(--accent, #6366f1)\''],
  },
  {
    source: 'slashCommands',
    expected: ["? 'accent-active'", "active ? 'accent-text' : 'text-theme-text'"],
  },
  {
    source: 'agentSelector',
    expected: ["? 'accent-active'", 'className="accent-text flex-shrink-0"'],
  },
  { source: 'activityLog', expected: ["p === page ? 'accent-active font-medium'"] },
  { source: 'admin', expected: ["activeTab === id", "? 'accent-active'"] },
  {
    source: 'agentTools',
    expected: ["isSelected\n                      ? 'accent-active'", "? 'accent-active border-b-2'"],
  },
  {
    source: 'apps',
    expected: [
      "(openFile?.path === entry.path || openMedia?.path === entry.path) ? 'accent-active'",
      "selectedProject === p.name ? 'accent-active border'",
      "createMode === mode ? 'accent-active'",
      "template === t.id ? 'accent-active'",
    ],
  },
  {
    source: 'files',
    expected: [
      "showFilters ? 'accent-active'",
      "mimeFilter === f.value\n                    ? 'accent-active'",
      "isSelected\n                    ? 'accent-active'",
      "isSelected ? 'accent-fill border-transparent'",
      "background: 'var(--accent-bg-subtle, rgba(99, 102, 241, 0.08))'",
      'accentColor: \'var(--accent, #6366f1)\'',
    ],
  },
  { source: 'automations', expected: ["scheduleType === type\n                        ? 'accent-active border'"] },
  { source: 'skills', expected: ["activeTab === tab.key\n                  ? 'accent-active border-b-2 -mb-[3px]'"] },
  {
    source: 'terminal',
    expected: [
      "activeTab === 'lookup' ? 'accent-active border-b-2'",
      "activeTab === 'aidebug' ? 'accent-active border-b-2'",
      "i === chatAcIndex ? 'accent-active border-l-2'",
      "tab.id === activeTabId\n                    ? 'accent-active'",
      "index === acSelectedIndex ? 'accent-active'",
    ],
  },
  {
    source: 'settings',
    expected: ["checked ? 'accent-toggle'", "checked ? 'left-6 accent-toggle-dot'"],
  },
  {
    source: 'dashboard',
    expected: [
      "updatePlan === 'use-current'\n                    ? 'accent-active'",
      "updatePlan === 'create-backup'\n                  ? 'accent-active'",
      "updatePlan === 'skip-backup'\n                    ? 'accent-active'",
      'accentColor: \'var(--accent, #6366f1)\'',
    ],
  },
  {
    source: 'setupWizard',
    expected: [
      "active ? 'accent-active scale-105'",
      "theme === choice ? 'accent-active'",
      "domainPath === 'domain' ? 'accent-active'",
      "domainPath === 'skip' ? 'accent-active'",
      "transition accent-focus'",
    ],
  },
];

const retiredSelectionChrome: Array<{
  source: SourceName;
  forbidden: string[];
}> = [
  {
    source: 'commandPalette',
    forbidden: ['bg-emerald-500/10 border-l-2 border-emerald-400'],
  },
  {
    source: 'fileTree',
    forbidden: ["isSelected ? 'bg-emerald-500/20 text-emerald-300'"],
  },
  {
    source: 'fileTreeEnhanced',
    forbidden: [
      "isSelected ? 'bg-emerald-500/20 text-emerald-300'",
      'ring-2 ring-emerald-500/40 bg-white/5',
    ],
  },
  {
    source: 'mediaViewer',
    forbidden: ['bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'],
  },
  {
    source: 'modelSelector',
    forbidden: [
      'border-emerald-500/60 bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]',
      'text-emerald-500 focus:ring-emerald-500',
    ],
  },
  {
    source: 'slashCommands',
    forbidden: ['border-emerald-400 bg-emerald-500/[0.12]'],
  },
  {
    source: 'agentSelector',
    forbidden: ["? 'bg-emerald-500/10 text-emerald-300'"],
  },
  {
    source: 'activityLog',
    forbidden: ["p === page ? 'bg-emerald-500/20 text-emerald-400 font-medium'"],
  },
  {
    source: 'admin',
    forbidden: ["? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'"],
  },
  {
    source: 'agentTools',
    forbidden: [
      "? 'bg-emerald-500/10 text-emerald-300'",
      'bg-white/[0.06] text-emerald-400 border-b-2 border-emerald-400',
    ],
  },
  {
    source: 'apps',
    forbidden: [
      "(openFile?.path === entry.path || openMedia?.path === entry.path) ? 'bg-emerald-500/10 text-emerald-400'",
      "selectedProject === p.name ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'",
      "createMode === mode ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'",
      "template === t.id ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'",
    ],
  },
  {
    source: 'files',
    forbidden: [
      "showFilters ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'",
      "mimeFilter === f.value\n                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'",
      "isSelected ? 'bg-emerald-500 border-emerald-500'",
      "selected.has(file.id) ? 'bg-emerald-500/5'",
    ],
  },
  {
    source: 'automations',
    forbidden: ['bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'],
  },
  {
    source: 'skills',
    forbidden: ['text-emerald-400 border-b-2 border-emerald-400 -mb-[3px]'],
  },
  {
    source: 'terminal',
    forbidden: [
      'text-emerald-400 border-b-2 border-emerald-400 bg-emerald-500/5',
      'bg-emerald-500/10 border-l-2 border-emerald-400',
      'border-emerald-400 text-emerald-400 bg-emerald-500/5',
      'border-emerald-400 bg-emerald-500/10',
    ],
  },
  {
    source: 'settings',
    forbidden: ["checked ? 'bg-emerald-500'"],
  },
  {
    source: 'dashboard',
    forbidden: [
      'border-emerald-400/40 bg-emerald-500/10',
      'border-cyan-400/40 bg-cyan-500/10',
      'border-amber-400/45 bg-amber-500/10',
    ],
  },
  {
    source: 'setupWizard',
    forbidden: [
      "active ? 'border-emerald-400 bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 scale-105'",
      "active ? 'accent-fill border-transparent text-white",
      "theme === choice ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'",
      "domainPath === 'domain' ? 'border-emerald-500 bg-emerald-500/10'",
      "domainPath === 'skip' ? 'border-emerald-500 bg-emerald-500/10'",
    ],
  },
];

describe('semantic accent selection contract', () => {
  it.each(accentContracts)('$source routes audited selection chrome through the configured accent', ({ source, expected }) => {
    for (const token of expected) {
      expect(sources[source]).toContain(token);
    }
  });

  it.each(retiredSelectionChrome)('$source does not revive the retired hard-coded selection color', ({ source, forbidden }) => {
    for (const token of forbidden) {
      expect(sources[source]).not.toContain(token);
    }
  });

  it('provides reusable accent primitives for selection, focus, fill, and toggles', () => {
    expect(sources.theme).toContain('.accent-active');
    expect(sources.theme).toContain('.accent-focus:focus');
    expect(sources.theme).toContain('.accent-ring');
    expect(sources.theme).toContain('.accent-fill');
    expect(sources.theme).toContain('.accent-toggle .accent-toggle-dot');
  });

  it('keeps allowlisted state facts semantic green', () => {
    expect(sources.agentSelector).toContain("isUsable ? 'border-emerald-500/30 text-emerald-300'");
    expect(sources.apps).toContain('p.deployedUrl && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400');
    expect(sources.dashboard).toContain("updateBackupDescription.tone === 'good'");
    expect(sources.dashboard).toContain("? 'border-emerald-400/25'");
    expect(sources.dashboard).toContain('className="mt-0.5 flex-none text-amber-300"');
    expect(sources.settings).toContain("runtimeStatus?.gateway.connected ? 'bg-emerald-500/10 text-emerald-400'");
    expect(sources.setupWizard).toContain("complete ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'");
    expect(sources.terminal).toContain("state?.connected ? 'bg-emerald-400' : 'bg-slate-500'");
  });
});
