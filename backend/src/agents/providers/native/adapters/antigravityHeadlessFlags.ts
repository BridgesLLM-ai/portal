/**
 * Every headless flag `gemini.ts` passes to `agy`. Antigravity publishes no
 * changelog, so a version newer than the Portal-tested one is admitted only
 * when its own `--help` still lists all of them. Keep in step with the adapter
 * (a test reads the adapter's flag literals).
 */
export const ANTIGRAVITY_HEADLESS_FLAGS: readonly string[] = Object.freeze([
  '--print',
  '--output-format',
  '--print-timeout',
  '--add-dir',
  '--conversation',
  '--model',
  '--dangerously-skip-permissions',
  '--sandbox',
]);

/** Flags from ANTIGRAVITY_HEADLESS_FLAGS that `helpText` does not list. */
export function missingAntigravityHeadlessFlags(helpText: string): string[] {
  return ANTIGRAVITY_HEADLESS_FLAGS.filter((flag) => {
    const escaped = flag.replace(/[-]/g, '\\-');
    return !new RegExp(`(?:^|[\\s,\\[])${escaped}(?=[\\s=,\\]]|$)`, 'm').test(helpText);
  });
}
