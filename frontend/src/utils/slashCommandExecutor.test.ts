import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatStateContextValue } from '../contexts/ChatStateProvider';
import { executeSlashCommand } from './slashCommandExecutor';
import { SLASH_COMMANDS } from './slashCommands';

function modelCommand() {
  const command = SLASH_COMMANDS.find((item) => item.command === '/model');
  if (!command) throw new Error('Missing /model command fixture');
  return command;
}

function chatStateFixture() {
  let messages: ChatMessage[] = [];
  const switchModel = vi.fn().mockResolvedValue({ deferred: false });
  const chatState = {
    messages,
    provider: 'GEMINI',
    selectedModel: 'gemini-old',
    switchModel,
    setMessages: vi.fn((update: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
      messages = typeof update === 'function' ? update(messages) : update;
      chatState.messages = messages;
    }),
  } as unknown as ChatStateContextValue;
  return { chatState, switchModel, messages: () => messages };
}

describe('/model command execution', () => {
  it('routes through the shared UI model-change handler', async () => {
    const { chatState, switchModel, messages } = chatStateFixture();
    const onModelChange = vi.fn().mockResolvedValue(true);

    await executeSlashCommand(modelCommand(), 'gemini-new', chatState, { onModelChange });

    expect(onModelChange).toHaveBeenCalledWith('gemini-new');
    expect(switchModel).not.toHaveBeenCalled();
    expect(messages().at(-1)?.content).toBe('Switched model to `gemini-new`.');
  });

  it('does not announce success when the shared handler rolls back a failed switch', async () => {
    const { chatState, switchModel, messages } = chatStateFixture();
    const onModelChange = vi.fn().mockResolvedValue(false);

    await executeSlashCommand(modelCommand(), 'gemini-rejected', chatState, { onModelChange });

    expect(onModelChange).toHaveBeenCalledWith('gemini-rejected');
    expect(switchModel).not.toHaveBeenCalled();
    expect(messages()).toEqual([]);
  });

  it('retains the context fallback for non-ChatInterface callers', async () => {
    const { chatState, switchModel, messages } = chatStateFixture();

    await executeSlashCommand(modelCommand(), 'gemini-fallback', chatState);

    expect(switchModel).toHaveBeenCalledWith('gemini-fallback');
    expect(messages().at(-1)?.content).toBe('Switched model to `gemini-fallback`.');
  });
});
