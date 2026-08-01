import { withOpenClawSessionMutation } from './openclawGatewayRpc';

test('serializes Portal-owned mutations for the same OpenClaw session', async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];

  const first = withOpenClawSessionMutation('agent:project:serialized', async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  const second = withOpenClawSessionMutation('agent:project:serialized', async () => {
    order.push('second-start');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(order).toEqual(['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second-start']);
});
