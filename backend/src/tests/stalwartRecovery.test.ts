import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  recycleStalwartContainerPreservingData,
  type StalwartCommandRunner,
} from '../services/stalwartRecovery';

describe('Stalwart automatic recovery policy', () => {
  let mailDir: string;

  beforeEach(() => {
    mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalwart-recovery-'));
    fs.mkdirSync(path.join(mailDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(mailDir, 'data', 'mail-store-sentinel'), 'must survive');
  });

  afterEach(() => {
    fs.rmSync(mailDir, { recursive: true, force: true });
  });

  it('recycles the container without deleting persistent mail data', () => {
    const commands: string[] = [];
    const runner: StalwartCommandRunner = (command) => {
      commands.push(command);
      if (command.startsWith('docker rm')) throw new Error('No such container');
      return Buffer.alloc(0);
    };

    recycleStalwartContainerPreservingData(mailDir, runner);

    expect(commands).toEqual([
      'docker compose down --remove-orphans',
      'docker rm -f stalwart-mail',
    ]);
    expect(commands.join(' ')).not.toContain(' -v');
    expect(commands.join(' ')).not.toContain('rm -rf');
    expect(fs.readFileSync(path.join(mailDir, 'data', 'mail-store-sentinel'), 'utf8')).toBe('must survive');
  });

  it('falls back to removing the named container when compose teardown fails', () => {
    const runner: StalwartCommandRunner = (command) => {
      if (command.startsWith('docker compose')) throw new Error('missing compose project');
      return Buffer.alloc(0);
    };

    expect(() => recycleStalwartContainerPreservingData(mailDir, runner)).not.toThrow();
    expect(fs.existsSync(path.join(mailDir, 'data', 'mail-store-sentinel'))).toBe(true);
  });

  it('stops instead of starting over when the existing container cannot be stopped safely', () => {
    const runner: StalwartCommandRunner = () => {
      throw new Error('docker unavailable');
    };

    expect(() => recycleStalwartContainerPreservingData(mailDir, runner))
      .toThrow('Unable to stop the existing Stalwart container safely');
    expect(fs.existsSync(path.join(mailDir, 'data', 'mail-store-sentinel'))).toBe(true);
  });
});
