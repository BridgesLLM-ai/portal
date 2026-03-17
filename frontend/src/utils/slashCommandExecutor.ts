import { gatewayAPI } from '../api/endpoints';
import type { ChatMessage, ChatStateContextValue } from '../contexts/ChatStateProvider';
import { SLASH_COMMANDS, type SlashCommand } from './slashCommands';

function nextLocalId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function addSystemMessage(chatState: ChatStateContextValue, content: string) {
  const message: ChatMessage = {
    id: nextLocalId(),
    role: 'system',
    content,
    createdAt: new Date(),
  };
  chatState.setMessages(prev => [...prev, message]);
}

function exportMessages(messages: ChatMessage[]) {
  const markdown = messages
    .map((message) => `## ${message.role}\n\n${message.content || ''}`)
    .join('\n\n');
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function executeSlashCommand(
  command: SlashCommand,
  args: string,
  chatState: ChatStateContextValue,
  helpers?: { onNewSession?: () => Promise<void> | void },
): Promise<void> {
  switch (command.command) {
    case '/new':
      if (helpers?.onNewSession) {
        await helpers.onNewSession();
      } else {
        chatState.clearMessages();
        chatState.setSession(`new-${Date.now()}`);
      }
      return;
    case '/stop':
      await chatState.cancelStream();
      return;
    case '/model':
      if (!args.trim()) {
        addSystemMessage(chatState, 'Usage: /model <model-id>');
        return;
      }
      await chatState.switchModel(args.trim());
      addSystemMessage(chatState, `Switched model to \`${args.trim()}\`.`);
      return;
    case '/models': {
      const data = await gatewayAPI.models(chatState.provider);
      const lines = (data.models || []).map((model) => `- ${model.id}`);
      addSystemMessage(chatState, lines.length ? `Available models for ${chatState.provider}:\n${lines.join('\n')}` : `No models returned for ${chatState.provider}.`);
      return;
    }
    case '/export':
      exportMessages(chatState.messages);
      addSystemMessage(chatState, 'Exported chat as markdown.');
      return;
    case '/help':
      addSystemMessage(chatState, SLASH_COMMANDS.map((cmd) => `- ${cmd.command}${cmd.argsHint ? ` ${cmd.argsHint}` : ''}: ${cmd.description}`).join('\n'));
      return;
    case '/status': {
      const data = await gatewayAPI.sessionInfo(chatState.session);
      addSystemMessage(chatState, `Session: ${chatState.session}\nProvider: ${chatState.provider}\nModel: ${chatState.selectedModel || 'default'}\nStatus: ${JSON.stringify(data?.session || data, null, 2)}`);
      return;
    }
    case '/clear':
      chatState.clearMessages();
      return;
    default:
      addSystemMessage(chatState, `Unknown slash command: ${command.command}`);
  }
}
