import fs from 'fs';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { prisma } from '../config/database';
import { sendJobFailedAlert } from './email';

export type JobStatus = 'running' | 'completed' | 'error' | 'killed';

export type TranscriptEntry = {
  type: 'input' | 'output' | 'system';
  text: string;
  stream?: 'stdout' | 'stderr';
  timestamp: string;
};

type StartJobInput = {
  userId: string;
  toolId: string;
  title?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

type RuntimeJob = {
  id: string;
  userId: string;
  type: 'pty' | 'spawn';
  ptyProcess?: any;
  child?: ChildProcessWithoutNullStreams;
};

const JOBS_DIR = path.join(process.env.PORTAL_ROOT || '/root/bridgesllm-product', '.data/jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const runtimes = new Map<string, RuntimeJob>();
const listeners = new Set<(event: { jobId: string; entry: TranscriptEntry }) => void>();

function appendTranscriptLine(transcriptPath: string, entry: TranscriptEntry) {
  fs.appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function emitOutput(jobId: string, entry: TranscriptEntry) {
  for (const listener of listeners) {
    listener({ jobId, entry });
  }
}

async function markJobFinished(jobId: string, status: JobStatus, exitCode: number | null) {
  await prisma.agentJob.update({
    where: { id: jobId },
    data: {
      status,
      exitCode,
      finishedAt: new Date(),
    },
  });
  runtimes.delete(jobId);
}

function readPtyModule(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node-pty');
  } catch {
    return null;
  }
}

export async function startAgentJob(input: StartJobInput) {
  const transcriptPath = path.join(JOBS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jsonl`);

  const job = await prisma.agentJob.create({
    data: {
      userId: input.userId,
      toolId: input.toolId,
      title: input.title || `${input.toolId} job`,
      status: 'running',
      startedAt: new Date(),
      transcriptPath,
      metadata: {
        command: input.command,
        cwd: input.cwd || process.cwd(),
        env: input.env || {},
      },
    },
  });

  const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...(input.env || {}) };
  const cwd = input.cwd || process.cwd();

  const pty = readPtyModule();
  if (pty) {
    try {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const ptyProcess = pty.spawn(shell, ['-lc', input.command], {
        name: 'xterm-color',
        cols: 120,
        rows: 40,
        cwd,
        env: baseEnv,
      });

      runtimes.set(job.id, { id: job.id, userId: input.userId, type: 'pty', ptyProcess });

      ptyProcess.onData((data: string) => {
        const entry: TranscriptEntry = {
          type: 'output',
          text: data,
          stream: 'stdout',
          timestamp: new Date().toISOString(),
        };
        appendTranscriptLine(transcriptPath, entry);
        emitOutput(job.id, entry);
      });

      ptyProcess.onExit(async ({ exitCode }: { exitCode: number }) => {
        const status: JobStatus = exitCode === 0 ? 'completed' : 'error';
        await markJobFinished(job.id, status, exitCode);
        if (status === 'error') {
          await sendJobFailedAlert(job.userId, job.title || `${job.toolId} job`, job.toolId, `Exited with code ${exitCode}`)
            .catch((err) => console.warn('[agent-jobs] Failed to send job-failed alert:', err));
        }
      });

      return job;
    } catch (error) {
      console.warn('[agent-jobs] PTY launch failed, using spawn fallback:', error);
    }
  }

  const child = spawn('/bin/bash', ['-lc', input.command], {
    cwd,
    env: baseEnv,
    stdio: 'pipe',
  });

  runtimes.set(job.id, { id: job.id, userId: input.userId, type: 'spawn', child });

  child.stdout.on('data', (chunk: Buffer) => {
    const entry: TranscriptEntry = {
      type: 'output',
      text: chunk.toString('utf-8'),
      stream: 'stdout',
      timestamp: new Date().toISOString(),
    };
    appendTranscriptLine(transcriptPath, entry);
    emitOutput(job.id, entry);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const entry: TranscriptEntry = {
      type: 'output',
      text: chunk.toString('utf-8'),
      stream: 'stderr',
      timestamp: new Date().toISOString(),
    };
    appendTranscriptLine(transcriptPath, entry);
    emitOutput(job.id, entry);
  });

  child.on('exit', async (code) => {
    const status: JobStatus = code === 0 ? 'completed' : 'error';
    await markJobFinished(job.id, status, code);
    if (status === 'error') {
      await sendJobFailedAlert(job.userId, job.title || `${job.toolId} job`, job.toolId, `Exited with code ${code}`)
        .catch((err) => console.warn('[agent-jobs] Failed to send job-failed alert:', err));
    }
  });

  return job;
}

export async function writeToAgentJob(jobId: string, userId: string, inputText: string) {
  const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Job not found');

  const runtime = runtimes.get(jobId);
  if (!runtime) throw new Error('Job is not running');
  if (runtime.userId !== userId) throw new Error('Forbidden');

  const entry: TranscriptEntry = {
    type: 'input',
    text: inputText,
    timestamp: new Date().toISOString(),
  };
  if (job.transcriptPath) {
    appendTranscriptLine(job.transcriptPath, entry);
  }
  emitOutput(jobId, entry);

  if (runtime.type === 'pty' && runtime.ptyProcess) {
    runtime.ptyProcess.write(inputText);
    return;
  }

  if (runtime.child?.stdin.writable) {
    runtime.child.stdin.write(inputText);
    return;
  }

  throw new Error('Job stdin unavailable');
}

export async function killAgentJob(jobId: string, userId: string) {
  const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Job not found');

  const runtime = runtimes.get(jobId);
  if (!runtime) throw new Error('Job is not running');
  if (runtime.userId !== userId) throw new Error('Forbidden');

  if (runtime.type === 'pty' && runtime.ptyProcess) {
    runtime.ptyProcess.kill();
  } else if (runtime.child) {
    runtime.child.kill('SIGTERM');
  }

  await prisma.agentJob.update({
    where: { id: jobId },
    data: {
      status: 'killed',
      finishedAt: new Date(),
    },
  });

  runtimes.delete(jobId);
}

export async function readTranscript(jobId: string): Promise<TranscriptEntry[]> {
  const job = await prisma.agentJob.findUnique({ where: { id: jobId }, select: { transcriptPath: true } });
  if (!job?.transcriptPath || !fs.existsSync(job.transcriptPath)) return [];

  const lines = fs.readFileSync(job.transcriptPath, 'utf-8').split('\n').filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is TranscriptEntry => !!x);
}

export function onAgentJobOutput(listener: (event: { jobId: string; entry: TranscriptEntry }) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
