// @vitest-environment jsdom
import '../../test/setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalGuideButton from './PortalGuideButton';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ default: { get: mocks.get } }));
const response = { data: { name: 'bridgesllm-portal', content: 'Read status before acting.', referenceDirectory: '/opt/bridgesllm/portal/skills/bridgesllm-portal' } };
afterEach(() => { mocks.get.mockReset(); });
describe('Portable Portal guide', () => {
  it('inserts reviewable context into a native chat without running a turn', async () => {
    mocks.get.mockResolvedValue(response);
    const onInsert = vi.fn(); const user = userEvent.setup();
    render(<PortalGuideButton scopeKey="owner:CODEX:one" onInsert={onInsert} />);
    expect(mocks.get).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add Portal guide to draft' }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(1));
    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining(response.data.content));
    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining(response.data.referenceDirectory));
    expect(mocks.get).toHaveBeenCalledWith('/skills/portal-guide', { timeout: 10_000 });
  });
  it('discards a slow guide fetch after the user changes session or harness', async () => {
    let resolve!: (value: typeof response) => void;
    mocks.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onInsert = vi.fn(); const user = userEvent.setup();
    const view = render(<PortalGuideButton scopeKey="owner:CODEX:one" onInsert={onInsert} />);
    await user.click(screen.getByRole('button', { name: 'Add Portal guide to draft' }));
    view.rerender(<PortalGuideButton scopeKey="owner:OPENCLAW:two" onInsert={onInsert} />);
    await act(async () => { resolve(response); });
    expect(onInsert).not.toHaveBeenCalled();
  });
  it('keeps the draft untouched when the installed guide is unavailable', async () => {
    mocks.get.mockRejectedValue(new Error('503'));
    const onInsert = vi.fn(); const user = userEvent.setup();
    render(<PortalGuideButton scopeKey="owner:CODEX:one" onInsert={onInsert} />);
    await user.click(screen.getByRole('button', { name: 'Add Portal guide to draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is unchanged');
    expect(onInsert).not.toHaveBeenCalled();
  });
});

it('shows guidance once per connected harness, not on every new conversation', async () => {
  const user = userEvent.setup();
  const onInsert = vi.fn();
  const view = render(<PortalGuideButton scopeKey="owner:HERMES:one" suggestionKey="owner:HERMES:unique" onInsert={onInsert} />);
  expect(screen.getByText('Help this harness get to know Portal')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Dismiss Portal guide suggestion' }));
  view.rerender(<PortalGuideButton scopeKey="owner:HERMES:two" suggestionKey="owner:HERMES:unique" onInsert={onInsert} />);
  expect(screen.queryByText('Help this harness get to know Portal')).not.toBeInTheDocument();
  view.unmount();
  render(<PortalGuideButton scopeKey="owner:HERMES:three" suggestionKey="owner:HERMES:unique" onInsert={onInsert} />);
  expect(screen.queryByText('Help this harness get to know Portal')).not.toBeInTheDocument();
});
