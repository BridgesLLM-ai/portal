import fs from 'fs';
import path from 'path';

type FixtureState = {
  app: any;
  source: any;
  target: any;
  shares: Array<{ id: string; token: string }>;
  runtimeRetired: boolean;
};

type FixtureRebindInput = Parameters<
  typeof import('./projectAppIdentityRebind').rebindLegacyProjectAppToCurrentCopy
>[0];

function readState(file: string): FixtureState {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureState;
  state.app.updatedAt = new Date(state.app.updatedAt);
  for (const identity of [state.source, state.target]) {
    identity.createdAt = new Date(identity.createdAt);
    identity.updatedAt = new Date(identity.updatedAt);
  }
  return state;
}

function writeState(file: string, state: FixtureState): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

async function main(): Promise<void> {
  const raw = process.env.PROJECT_APP_REBIND_CRASH_FIXTURE;
  if (!raw) throw new Error('Missing crash fixture configuration');
  const config = JSON.parse(raw) as {
    stateFile: string;
    input: FixtureRebindInput;
    journalRoot: string;
    checkpoint: 'DEPLOYMENT_PROMOTED' | 'APP_COMMITTED' | null;
  };
  process.env.DATABASE_URL ||= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
  const { rebindLegacyProjectAppToCurrentCopy } = await import('./projectAppIdentityRebind');
  const database: any = {
    projectIdentity: {
      findUnique: async ({ where }: any) => {
        const state = readState(config.stateFile);
        return where.id === state.source.id ? state.source : where.id === state.target.id ? state.target : null;
      },
    },
    app: {
      findMany: async () => [readState(config.stateFile).app],
      count: async () => 0,
      findUnique: async () => readState(config.stateFile).app,
      updateMany: async ({ where, data }: any) => {
        const state = readState(config.stateFile);
        const app = state.app;
        if (
          app.id !== where.id
          || app.userId !== where.userId
          || app.projectIdentityId !== where.projectIdentityId
          || app.name !== where.name
          || app.zipPath !== where.zipPath
          || app.deployType !== where.deployType
          || app.processStatus !== where.processStatus
          || app.updatedAt.getTime() !== where.updatedAt.getTime()
        ) return { count: 0 };
        Object.assign(app, data, { updatedAt: new Date(app.updatedAt.getTime() + 1_000) });
        writeState(config.stateFile, state);
        return { count: 1 };
      },
    },
    appShareLink: {
      findMany: async () => readState(config.stateFile).shares,
    },
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work(database),
  };
  const runtimeLock: any = async (
    _input: unknown,
    work: (lease: { retirePersistedState(): Promise<void> }) => Promise<unknown>,
  ) => work({
    retirePersistedState: async () => {
      const state = readState(config.stateFile);
      state.runtimeRetired = true;
      writeState(config.stateFile, state);
    },
  });
  await rebindLegacyProjectAppToCurrentCopy(config.input, {
    database,
    journalRoot: config.journalRoot,
    runtimeLock,
    ...(config.checkpoint ? {
      testCheckpoint: (stage) => {
        if (stage === config.checkpoint) process.kill(process.pid, 'SIGKILL');
      },
    } : {}),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
