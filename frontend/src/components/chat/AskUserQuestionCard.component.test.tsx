// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AskUserQuestionCard, { type AskUserQuestionRequest } from './AskUserQuestionCard';

const mocks = vi.hoisted(() => ({
  answerQuestion: vi.fn(),
  dismissQuestion: vi.fn(),
}));

vi.mock('../../api/endpoints', () => ({
  gatewayAPI: {
    answerQuestion: mocks.answerQuestion,
    dismissQuestion: mocks.dismissQuestion,
  },
}));

function makeRequest(overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest {
  return {
    id: 'askq_1',
    sessionKey: 'agent:main:main',
    surface: 'agent-chat',
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    state: 'pending',
    questions: [{
      id: 'question-database',
      question: 'Which database should the project use?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'PostgreSQL', description: 'Already installed' }, { label: 'SQLite' }],
    }],
    ...overrides,
  };
}

describe('AskUserQuestionCard', () => {
  beforeEach(() => {
    mocks.answerQuestion.mockReset().mockImplementation(async (id: string) => ({
      ok: true,
      id,
      state: 'answered',
    }));
    mocks.dismissQuestion.mockReset().mockResolvedValue({ ok: true });
  });

  it('sends the chosen option and clears the card', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    render(<AskUserQuestionCard request={makeRequest()} onSettled={onSettled} />);

    expect(screen.getByRole('region', { name: /waiting on your answer/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'PostgreSQL' }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(mocks.answerQuestion).toHaveBeenCalledWith('askq_1', {
      'question-database': 'PostgreSQL',
    }));
    expect(onSettled).toHaveBeenCalledWith('askq_1');
  });

  it('fails closed instead of inventing a protocol for native multi-select', async () => {
    const user = userEvent.setup();
    render(
      <AskUserQuestionCard
        request={makeRequest({
          questions: [{
            id: 'question-features',
            question: 'Which features?',
            multiSelect: true,
            isOther: true,
            options: [{ label: 'Search' }, { label: 'Export' }],
          }],
        })}
        onSettled={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/unsupported multiple-selection answer/i);
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('refuses to send an empty answer', async () => {
    render(<AskUserQuestionCard request={makeRequest()} onSettled={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('does not accept arbitrary free text for an option-only prompt', () => {
    render(<AskUserQuestionCard request={makeRequest()} onSettled={vi.fn()} />);

    expect(screen.queryByLabelText(/Your answer to:/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PostgreSQL' })).toBeVisible();
  });

  it('uses a protected field and warning for a secret free-text prompt', () => {
    render(
      <AskUserQuestionCard
        request={makeRequest({
          questions: [{
            id: 'question-secret',
            question: 'API token?',
            multiSelect: false,
            isSecret: true,
            options: [],
          }],
        })}
        onSettled={vi.fn()}
      />,
    );

    expect(screen.getByText(/Secret answer — hidden while you type/i)).toBeVisible();
    expect(screen.getByLabelText('Your answer to: API token?')).toHaveAttribute('type', 'password');
  });

  it('shows the server reason when an answer arrives too late', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    mocks.answerQuestion.mockRejectedValue({
      response: { data: { error: 'That question expired before it was answered.' } },
    });
    render(<AskUserQuestionCard request={makeRequest()} onSettled={onSettled} />);

    await user.click(screen.getByRole('button', { name: 'SQLite' }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('expired before it was answered');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('locks an answer after an ambiguous response and retries the exact payload', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    mocks.answerQuestion
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockImplementationOnce(async (id: string) => ({ ok: true, id, state: 'answered' }));
    render(<AskUserQuestionCard request={makeRequest()} onSettled={onSettled} />);

    await user.click(screen.getByRole('button', { name: 'SQLite' }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/delivery is unconfirmed/i);
    expect(screen.getByRole('button', { name: 'PostgreSQL' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Skip/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(mocks.answerQuestion).toHaveBeenCalledTimes(2));
    expect(mocks.answerQuestion.mock.calls[1]).toEqual(mocks.answerQuestion.mock.calls[0]);
    expect(onSettled).toHaveBeenCalledWith('askq_1');
  });

  it('lets the user skip without answering', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    render(<AskUserQuestionCard request={makeRequest()} onSettled={onSettled} />);

    await user.click(screen.getByRole('button', { name: /Skip/ }));

    await waitFor(() => expect(mocks.dismissQuestion).toHaveBeenCalledWith('askq_1'));
    expect(onSettled).toHaveBeenCalledWith('askq_1');
  });

  it('keeps the card visible when skip delivery fails', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    mocks.dismissQuestion.mockRejectedValue({
      response: { data: { error: 'The waiting run could not be reached.' } },
    });
    render(<AskUserQuestionCard request={makeRequest()} onSettled={onSettled} />);

    await user.click(screen.getByRole('button', { name: /Skip/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Skip/ })).toBeEnabled();
  });

  it('requires an answer for every native question before enabling submit', async () => {
    const user = userEvent.setup();
    render(
      <AskUserQuestionCard
        request={makeRequest({
          questions: [
            { id: 'question-first', question: 'First?', multiSelect: false, options: [] },
            { id: 'question-second', question: 'Second?', multiSelect: false, options: [] },
          ],
        })}
        onSettled={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Your answer to: First?'), 'one');
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    await user.type(screen.getByLabelText('Your answer to: Second?'), 'two');
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled();
  });

  it('clears itself once the deadline passes', async () => {
    const onSettled = vi.fn();
    render(
      <AskUserQuestionCard
        request={makeRequest({ expiresAt: Date.now() - 1 })}
        onSettled={onSettled}
      />,
    );
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('askq_1'));
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'submits prototype-shaped native question id %s literally',
    async (questionId) => {
      const user = userEvent.setup();
      render(
        <AskUserQuestionCard
          request={makeRequest({
            questions: [{ id: questionId, question: 'Literal identifier?', multiSelect: false, options: [] }],
          })}
          onSettled={vi.fn()}
        />,
      );

      await user.type(screen.getByLabelText('Your answer to: Literal identifier?'), 'literal answer');
      await user.click(screen.getByRole('button', { name: 'Send answer' }));

      await waitFor(() => {
        const [, answers] = mocks.answerQuestion.mock.calls.at(-1) || [];
        expect(Object.keys(answers || {})).toEqual([questionId]);
        expect(answers?.[questionId]).toBe('literal answer');
      });
    },
  );
});
