// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PendingQuestionToasts from './PendingQuestionToasts';
import type { GatewayPendingQuestion } from '../api/endpoints';

const gatewayMocks = vi.hoisted(() => ({
  answerQuestion: vi.fn(),
  dismissQuestion: vi.fn(),
}));

const soundMocks = vi.hoisted(() => ({ question: vi.fn() }));

vi.mock('../api/endpoints', () => ({
  gatewayAPI: {
    answerQuestion: gatewayMocks.answerQuestion,
    dismissQuestion: gatewayMocks.dismissQuestion,
  },
}));

vi.mock('../utils/sounds', () => ({
  default: { question: soundMocks.question },
  sounds: { question: soundMocks.question },
}));

/**
 * `ViewportOverlay` sets `pointer-events: none` on its layer inline and
 * re-enables it on the content wrapper through the Tailwind
 * `pointer-events-auto` class. jsdom loads no stylesheet, so that class never
 * resolves and user-event refuses every click inside a real, clickable toast.
 */
function overlayUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

function pendingQuestion(overrides: Partial<GatewayPendingQuestion> = {}): GatewayPendingQuestion {
  return {
    id: 'askq_1',
    sessionKey: 'agent:main:portal-owner',
    surface: 'agent-chat',
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    state: 'pending',
    questions: [{
      id: 'database',
      question: 'Which database should I use?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
    }],
    ...overrides,
  } as GatewayPendingQuestion;
}

describe('pending question notifications', () => {
  beforeEach(() => {
    gatewayMocks.answerQuestion.mockReset();
    gatewayMocks.dismissQuestion.mockReset();
    soundMocks.question.mockReset();
  });

  it('announces a waiting run once and answers it in place without navigating', async () => {
    gatewayMocks.answerQuestion.mockResolvedValue({
      ok: true,
      id: 'askq_1',
      state: 'answered',
    });
    const onSettled = vi.fn();
    const question = pendingQuestion();
    const view = render(
      <PendingQuestionToasts questions={[question]} onSettled={onSettled} />,
    );

    expect(await screen.findByText('Agent chat is waiting on you')).toBeVisible();
    expect(soundMocks.question).toHaveBeenCalledTimes(1);

    // A re-render with the same open question must not re-announce it.
    view.rerender(
      <PendingQuestionToasts questions={[question]} onSettled={onSettled} />,
    );
    expect(soundMocks.question).toHaveBeenCalledTimes(1);

    await overlayUser().click(screen.getByRole('button', {
      name: 'Answer the waiting question here',
    }));
    await overlayUser().click(await screen.findByRole('button', { name: /PostgreSQL/ }));
    await overlayUser().click(screen.getByRole('button', { name: /^Send answer/ }));

    await waitFor(() => expect(gatewayMocks.answerQuestion).toHaveBeenCalledWith(
      'askq_1',
      expect.objectContaining({ database: 'PostgreSQL' }),
    ));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('askq_1'));
  });

  it('hiding the notification never cancels what the run is waiting for', async () => {
    const onSettled = vi.fn();
    render(
      <PendingQuestionToasts questions={[pendingQuestion()]} onSettled={onSettled} />,
    );

    await overlayUser().click(await screen.findByRole('button', {
      name: 'Hide this notification without answering',
    }));

    await waitFor(() => expect(
      screen.queryByText('Agent chat is waiting on you'),
    ).not.toBeInTheDocument());
    expect(gatewayMocks.dismissQuestion).not.toHaveBeenCalled();
    expect(gatewayMocks.answerQuestion).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('announces a genuinely new question and keeps the stack bounded', async () => {
    const onSettled = vi.fn();
    const first = pendingQuestion();
    const view = render(
      <PendingQuestionToasts questions={[first]} onSettled={onSettled} />,
    );
    expect(soundMocks.question).toHaveBeenCalledTimes(1);

    const many = [
      first,
      pendingQuestion({ id: 'askq_2', surface: 'project-chat' }),
      pendingQuestion({ id: 'askq_3' }),
      pendingQuestion({ id: 'askq_4' }),
    ];
    view.rerender(<PendingQuestionToasts questions={many} onSettled={onSettled} />);

    expect(soundMocks.question).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Project chat is waiting on you')).toBeVisible();
    expect(screen.getAllByRole('status')).toHaveLength(3);
  });
});
