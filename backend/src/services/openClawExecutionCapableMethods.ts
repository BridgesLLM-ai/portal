/**
 * Gateway RPC calls that start, resume, steer, or schedule agent execution.
 *
 * Both Portal transports (the persistent gateway socket and the one-shot RPC
 * connection) read the durable maintenance evidence synchronously before they
 * write one of these to the wire. Read-only methods, `chat.abort` and automation
 * removal are never listed: looking at, stopping, or cleaning up work must keep
 * working during maintenance.
 */
export const OPENCLAW_EXECUTION_CAPABLE_GATEWAY_METHODS: ReadonlySet<string> = new Set([
  'agent',
  'chat.send',
  'sessions.steer',
  'cron.run',
  // Creating or changing an automation can enable it, and an enabled
  // automation is execution the scheduler starts on its own.
  'cron.add',
  'cron.update',
  // Answering, steering or dismissing a waiting run lets it continue: a
  // dismissal settles the pending input with an empty response.
  'question.resolve',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.steer',
  'bridgesllm.ask_user.dismiss',
]);

export function isOpenClawExecutionCapableGatewayMethod(method: unknown): boolean {
  return typeof method === 'string' && OPENCLAW_EXECUTION_CAPABLE_GATEWAY_METHODS.has(method);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parameter-aware form. An automation write whose result is explicitly a
 * disabled job is cleanup or repair of something inert, and stays available
 * during maintenance; every other listed call is execution-capable.
 */
export function isOpenClawExecutionCapableGatewayCall(method: unknown, params: unknown): boolean {
  if (!isOpenClawExecutionCapableGatewayMethod(method)) return false;
  if (method === 'cron.add') return !(isPlainRecord(params) && params.enabled === false);
  if (method === 'cron.update') {
    return !(isPlainRecord(params) && isPlainRecord(params.patch) && params.patch.enabled === false);
  }
  return true;
}
