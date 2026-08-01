// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileOverflowMenu from './MobileOverflowMenu';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
});

describe('MobileOverflowMenu', () => {
  it('uses the shared modal sheet and restores trigger focus without exposing the page', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const user = userEvent.setup();

    const view = render(
      <MobileOverflowMenu
        triggerLabel="Project actions"
        actions={[
          { label: 'First action', onClick: firstAction },
          { label: 'Second action', onClick: secondAction },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Project actions' });
    await user.click(trigger);

    const menu = await screen.findByRole('menu', { name: 'Project actions' });
    const first = screen.getByRole('menuitem', { name: 'First action' });
    const second = screen.getByRole('menuitem', { name: 'Second action' });
    await waitFor(() => expect(first).toHaveFocus());
    expect(menu.closest('[role="dialog"]')).toHaveAttribute('aria-modal', 'true');
    expect(view.container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Project actions' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'First action' }));
    expect(firstAction).toHaveBeenCalledTimes(1);
    expect(secondAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu', { name: 'Project actions' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
