import {
  findSlashCommand,
  parseSlashCommand,
  type SlashCommand,
} from './slashCommands';

export interface LocalSlashCommandEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface ProviderSlashCommandLike {
  command?: unknown;
}

export interface ParsedLocalSlashCommand {
  command: SlashCommand;
  args: string;
}

export interface LocalSlashCommandClaimOptions {
  rawValue: string;
  provider: string;
  providerSlashCommands: readonly ProviderSlashCommandLike[];
  event: LocalSlashCommandEvent;
  clearComposer: () => void;
  execute: (parsed: ParsedLocalSlashCommand) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export interface LocalSlashCommandCoordinator {
  claim: (options: LocalSlashCommandClaimOptions) => boolean;
}

function consumeEvent(event: LocalSlashCommandEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function providerAdvertisesCommand(
  command: SlashCommand,
  providerSlashCommands: readonly ProviderSlashCommandLike[],
) {
  const localCommand = command.command.toLowerCase();
  return providerSlashCommands.some((entry) => {
    const advertised = String(entry.command || '').trim().toLowerCase();
    return advertised === localCommand || command.aliases?.includes(advertised);
  });
}

/**
 * Claims Portal-owned slash commands at the synchronous browser-event boundary.
 * Async command work starts only after the composer has been cleared, so a slow
 * export cannot be submitted twice or erase a draft typed while it is paging.
 */
export function createLocalSlashCommandCoordinator(): LocalSlashCommandCoordinator {
  let pendingClaims = 0;

  return {
    claim(options) {
      const rawValue = options.rawValue;

      // A second click/Enter can arrive before React has disabled the now-empty
      // composer. Consume that empty repeat while the claimed command settles.
      if (!rawValue.trim() && pendingClaims > 0) {
        consumeEvent(options.event);
        return true;
      }

      const command = findSlashCommand(rawValue);
      if (!command || !command.executeLocal) return false;

      const providerCommand = providerAdvertisesCommand(command, options.providerSlashCommands);
      if (
        options.provider.toUpperCase() === 'OPENCLAW'
        && providerCommand
        && command.command !== '/export'
      ) {
        return false;
      }

      const parsed = parseSlashCommand(rawValue);
      if (!parsed) return false;

      consumeEvent(options.event);
      try {
        options.clearComposer();
      } catch (error) {
        options.onError?.(error);
        return true;
      }

      pendingClaims += 1;
      void (async () => options.execute(parsed))()
        .catch((error) => {
          options.onError?.(error);
        })
        .finally(() => {
          pendingClaims = Math.max(0, pendingClaims - 1);
        });
      return true;
    },
  };
}
