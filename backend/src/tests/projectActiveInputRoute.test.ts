import fs from 'fs';
import path from 'path';

const projectsSource = fs.readFileSync(
  path.resolve(__dirname, '../routes/projects.ts'),
  'utf8',
);

function activeInputRouteBlock(): string {
  const signature = "router.post('/:name/assistant/answer-input'";
  const start = projectsSource.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = projectsSource.indexOf('\nrouter.', start + signature.length);
  return projectsSource.slice(start, next === -1 ? projectsSource.length : next);
}

describe('Project Chat active-input route contract', () => {
  test('steers the exact active run instead of misrouting composer guidance as a pending answer', () => {
    const route = activeInputRouteBlock();

    expect(route).toContain('const accepted = await steerActiveRun(');
    expect(route).toContain('activeTurn.providerSessionId,');
    expect(route).toContain('`portal-${activeTurn.id}`,');
    expect(route).toContain('requestId,');
    expect(route).toContain('message,');
    expect(route).not.toContain('answerPendingUserInput(');
  });

  test('returns the stable request identity for both accepted delivery and replay', () => {
    const route = activeInputRouteBlock();
    expect(route).toContain(
      `res.json({
        accepted: true,
        idempotentReplay: true,
        requestId,
        messageId: replayMessage.id,`,
    );
    expect(route).toContain(
      `res.json({
        accepted: true,
        idempotentReplay: true,
        requestId,
        messageId: existing.id,`,
    );
    expect(route).toContain(
      `res.json({
      accepted: true,
      idempotentReplay: accepted.idempotentReplay === true,
      requestId,
      messageId: persisted.id,`,
    );
  });
});
