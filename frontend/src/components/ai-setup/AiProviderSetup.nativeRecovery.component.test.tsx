// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiProviderSetup from './AiProviderSetup';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(() => new Promise(() => {})),
  },
}));

vi.mock('./NativeCliSetupFlow', () => ({
  default: ({ provider, onCancel }: { provider: string; onCancel: () => void }) => (
    <div role="dialog" aria-label={`Native recovery ${provider}`}>
      <span>Recover {provider}</span>
      <button type="button" onClick={onCancel}>Close native recovery</button>
    </div>
  ),
}));

describe('AiProviderSetup exact native recovery handoff', () => {
  it('opens the requested native login immediately and permits a deliberate same-provider retry', () => {
    const view = render(
      <AiProviderSetup
        mode="settings"
        apiBase="/ai-setup"
        compact
        initialNativeCliProvider="claude-code"
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Native recovery claude-code' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close native recovery' }));
    expect(screen.queryByRole('dialog', { name: 'Native recovery claude-code' })).not.toBeInTheDocument();

    view.rerender(
      <AiProviderSetup mode="settings" apiBase="/ai-setup" compact initialNativeCliProvider={null} />,
    );
    view.rerender(
      <AiProviderSetup
        mode="settings"
        apiBase="/ai-setup"
        compact
        initialNativeCliProvider="claude-code"
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Native recovery claude-code' })).toBeVisible();
  });
});
