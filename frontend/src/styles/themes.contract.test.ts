import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const themeSource = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const themeContextSource = readFileSync(new URL('../contexts/ThemeContext.tsx', import.meta.url), 'utf8');
const confirmationDialogSource = readFileSync(new URL('../components/TypedConfirmationDialog.tsx', import.meta.url), 'utf8');
const destructiveDialogSource = readFileSync(new URL('../components/ConfirmDialog.tsx', import.meta.url), 'utf8');
const markdownPreviewSource = readFileSync(new URL('../components/projects/MarkdownPreviewFrame.tsx', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../components/Layout.tsx', import.meta.url), 'utf8');
const drawerSource = readFileSync(new URL('../components/Drawer.tsx', import.meta.url), 'utf8');
const avatarSource = readFileSync(new URL('../components/UserAvatar.tsx', import.meta.url), 'utf8');
const overflowMenuSource = readFileSync(new URL('../components/mobile/MobileOverflowMenu.tsx', import.meta.url), 'utf8');

describe('cross-product theme contract', () => {
  it('loads semantic theme overrides after the legacy Tailwind/base stylesheet', () => {
    expect(mainSource.indexOf("import './index.css'")).toBeGreaterThan(-1);
    expect(mainSource.indexOf("import './styles/themes.css'")).toBeGreaterThan(
      mainSource.indexOf("import './index.css'"),
    );
    expect(mainSource.indexOf("import './styles/themes.css'")).toBeGreaterThan(
      mainSource.indexOf("import 'highlight.js/styles/github-dark-dimmed.min.css'"),
    );
  });

  it('gives light mode distinct canvas, surface, border, and readable text tokens', () => {
    expect(themeSource).toContain('[data-theme="light"]');
    expect(themeSource).toContain('--color-bg: #f2f5f9');
    expect(themeSource).toContain('--color-surface: #ffffff');
    expect(themeSource).toContain('--color-border: #d5deea');
    expect(themeSource).toContain('--color-text: #172033');
    expect(themeSource).toContain('--color-text-muted: #596a80');
  });

  it('translates legacy dark surfaces without breaking white text on solid actions', () => {
    expect(themeSource).toContain('.bg-\\[\\#0A0E27\\]');
    expect(themeSource).toContain('.bg-slate-950\\/60');
    expect(themeSource).toContain('.bg-emerald-500, .bg-emerald-600');
    expect(themeSource).toContain('.bg-blue-600\\/65, .bg-blue-600\\/90');
    expect(themeSource).toContain(').text-white');
    expect(themeSource).toContain('color: #ffffff !important');
  });

  it('provides light native form controls and higher-contrast status colors', () => {
    expect(themeSource).toContain('[data-theme="light"] select option');
    expect(themeSource).toContain('.text-amber-300, .text-amber-400');
    expect(themeSource).toContain('.text-red-300, .text-red-400');
    expect(themeSource).toContain('.text-emerald-300, .text-emerald-400');
  });

  it('keeps shared privileged dialogs on semantic surfaces instead of a dark-only shell', () => {
    expect(confirmationDialogSource).toContain('border-theme-border bg-theme-surface text-theme-text');
    expect(confirmationDialogSource).toContain('bg-theme-bg px-3 py-2 font-mono text-sm text-theme-text');
    expect(confirmationDialogSource).not.toContain('bg-[#0A0E27]');
  });

  it('applies the resolved theme before paint and translates legacy gray utilities', () => {
    expect(themeContextSource).toContain('useLayoutEffect(() =>');
    expect(indexSource).toContain("localStorage.getItem('theme')");
    expect(indexSource).toContain("document.documentElement.setAttribute('data-theme', resolved)");
    expect(indexSource).toContain("resolved === 'light' ? '#f2f5f9' : '#0A0E27'");
    expect(themeSource).toContain('.bg-gray-900\\/50');
    expect(themeSource).toContain('.border-gray-700\\/50');
    expect(themeSource).toContain('.text-gray-400');
  });

  it('keeps short-viewport dialogs scrollable and removes dark-only destructive shells', () => {
    expect(destructiveDialogSource).toContain('max-h-[calc(100dvh-2rem)]');
    expect(destructiveDialogSource).toContain('bg-theme-surface text-theme-text');
    expect(destructiveDialogSource).not.toContain('bg-[#12080E]');
    expect(destructiveDialogSource).not.toContain('bg-[#121008]');
  });

  it('ships readable light syntax colors and a theme-aware generated Markdown preview', () => {
    expect(themeSource).toContain('[data-theme="light"] .hljs');
    expect(themeSource).toContain('.hljs-keyword');
    expect(markdownPreviewSource).toContain("theme = 'dark'");
    expect(markdownPreviewSource).toContain("page: '#ffffff'");
    expect(markdownPreviewSource).toContain("heading: '#172033'");
  });

  it('uses the configured accent for shell identity and active navigation without recoloring status green', () => {
    expect(themeSource).toContain('.accent-avatar');
    expect(themeSource).toContain('.accent-fill');
    expect(layoutSource).toContain('accent-text opacity-70 font-medium">Assistant');
    expect(layoutSource).toContain("? 'accent-active border'");
    expect(layoutSource).not.toContain('text-emerald-400/70');
    expect(drawerSource).toContain('accent-text opacity-70">Assistant');
    expect(drawerSource).toContain("? 'accent-active border border-transparent'");
    expect(avatarSource).toContain("assistant ? 'accent-avatar' : ringColor");
    expect(overflowMenuSource).toContain("if (active) return 'accent-active'");
    expect(overflowMenuSource).toContain("case 'success': return 'text-emerald-400 hover:bg-emerald-500/10'");
    expect(avatarSource).toContain("gatewayStatus === 'connected' ? 'bg-emerald-500'");
  });
});
