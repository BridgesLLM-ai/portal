import { prisma } from '../config/database';

export const OLLAMA_TAILNET_ONBOARDING_KEY = 'setup.ollamaTailnetOnboarding';

export const OLLAMA_TAILNET_ONBOARDING_PHASE = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  REQUESTED: 'REQUESTED',
  COMPLETED: 'COMPLETED',
} as const);

export type OllamaTailnetOnboardingPhase =
  typeof OLLAMA_TAILNET_ONBOARDING_PHASE[
    keyof typeof OLLAMA_TAILNET_ONBOARDING_PHASE
  ];

type SystemSettingStore = {
  systemSetting: {
    findUnique(args: {
      where: { key: string };
    }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      update: { value: string };
      create: { key: string; value: string };
    }): Promise<unknown>;
  };
};

const defaultStore = prisma as unknown as SystemSettingStore;

export function normalizeOllamaTailnetOnboardingPhase(
  value: unknown,
): OllamaTailnetOnboardingPhase {
  if (value === OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED) {
    return OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED;
  }
  if (value === OLLAMA_TAILNET_ONBOARDING_PHASE.COMPLETED) {
    return OLLAMA_TAILNET_ONBOARDING_PHASE.COMPLETED;
  }
  return OLLAMA_TAILNET_ONBOARDING_PHASE.NOT_REQUESTED;
}

export async function readOllamaTailnetOnboardingPhase(
  store: SystemSettingStore = defaultStore,
): Promise<OllamaTailnetOnboardingPhase> {
  const row = await store.systemSetting.findUnique({
    where: { key: OLLAMA_TAILNET_ONBOARDING_KEY },
  });
  return normalizeOllamaTailnetOnboardingPhase(row?.value);
}

export async function writeOllamaTailnetOnboardingPhase(
  phase: OllamaTailnetOnboardingPhase,
  store: SystemSettingStore = defaultStore,
): Promise<OllamaTailnetOnboardingPhase> {
  const normalized = normalizeOllamaTailnetOnboardingPhase(phase);
  await store.systemSetting.upsert({
    where: { key: OLLAMA_TAILNET_ONBOARDING_KEY },
    update: { value: normalized },
    create: {
      key: OLLAMA_TAILNET_ONBOARDING_KEY,
      value: normalized,
    },
  });
  return normalized;
}
