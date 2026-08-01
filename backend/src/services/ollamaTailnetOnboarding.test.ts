import {
  OLLAMA_TAILNET_ONBOARDING_KEY,
  OLLAMA_TAILNET_ONBOARDING_PHASE,
  normalizeOllamaTailnetOnboardingPhase,
  readOllamaTailnetOnboardingPhase,
  writeOllamaTailnetOnboardingPhase,
} from './ollamaTailnetOnboarding';

function store(initialValue?: string) {
  let value = initialValue;
  return {
    database: {
      systemSetting: {
        findUnique: jest.fn(async () => (
          value === undefined ? null : { value }
        )),
        upsert: jest.fn(async (input: {
          update: { value: string };
        }) => {
          value = input.update.value;
          return { key: OLLAMA_TAILNET_ONBOARDING_KEY, value };
        }),
      },
    },
    value: () => value,
  };
}

describe('Ollama Tailnet onboarding phase', () => {
  test('treats absent or unknown state as not requested', () => {
    expect(normalizeOllamaTailnetOnboardingPhase(undefined)).toBe(
      OLLAMA_TAILNET_ONBOARDING_PHASE.NOT_REQUESTED,
    );
    expect(normalizeOllamaTailnetOnboardingPhase('ACTIVE')).toBe(
      OLLAMA_TAILNET_ONBOARDING_PHASE.NOT_REQUESTED,
    );
  });

  test('round-trips the non-secret requested and completed phases', async () => {
    const fixture = store();
    await expect(readOllamaTailnetOnboardingPhase(fixture.database))
      .resolves.toBe(OLLAMA_TAILNET_ONBOARDING_PHASE.NOT_REQUESTED);

    await expect(writeOllamaTailnetOnboardingPhase(
      OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED,
      fixture.database,
    )).resolves.toBe(OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED);
    expect(fixture.value()).toBe(OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED);

    await expect(writeOllamaTailnetOnboardingPhase(
      OLLAMA_TAILNET_ONBOARDING_PHASE.COMPLETED,
      fixture.database,
    )).resolves.toBe(OLLAMA_TAILNET_ONBOARDING_PHASE.COMPLETED);
    expect(fixture.value()).toBe(OLLAMA_TAILNET_ONBOARDING_PHASE.COMPLETED);
  });
});
