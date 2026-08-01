import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

type CommandOptions = {
  cwd: string;
  timeout: number;
  stdio: 'pipe';
};

export type StalwartCommandRunner = (command: string, options: CommandOptions) => unknown;

const runCommand: StalwartCommandRunner = (command, options) => execSync(command, options);

/**
 * Recycle the Stalwart container without deleting its persistent mail store.
 *
 * Health and provisioning failures are not evidence that the stored mailbox
 * data is disposable. Destructive recovery must remain a separate, explicit,
 * confirmed operation with a verified backup; routine setup/install retries
 * may only replace the container around the existing bind-mounted data.
 */
export function recycleStalwartContainerPreservingData(
  mailDir: string,
  runner: StalwartCommandRunner = runCommand,
): void {
  const resolvedMailDir = path.resolve(mailDir);
  fs.mkdirSync(resolvedMailDir, { recursive: true });

  let composeStopped = false;
  let composeError: unknown;
  try {
    runner('docker compose down --remove-orphans', {
      cwd: resolvedMailDir,
      timeout: 120_000,
      stdio: 'pipe',
    });
    composeStopped = true;
  } catch (error) {
    composeError = error;
  }

  try {
    runner('docker rm -f stalwart-mail', {
      cwd: resolvedMailDir,
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (containerError) {
    if (!composeStopped) {
      const reason = containerError instanceof Error
        ? containerError.message
        : composeError instanceof Error
          ? composeError.message
          : 'unknown container stop failure';
      throw new Error(`Unable to stop the existing Stalwart container safely: ${reason}`);
    }
    // Compose already removed the container. The named removal then reports
    // that it no longer exists, which is the expected successful state.
  }

  // Creating the mount point is safe and idempotent. Never remove or replace
  // this directory from an automatic health/provisioning recovery path.
  fs.mkdirSync(path.join(resolvedMailDir, 'data'), { recursive: true });
}
