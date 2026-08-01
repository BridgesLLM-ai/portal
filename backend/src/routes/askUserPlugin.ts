import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { getGatewayToken } from '../utils/gatewayToken';
import {
  AskUserQuestionError,
  formatAskUserAnswerForModel,
  waitForAskUserAnswer,
} from '../services/askUserQuestionBroker';
import { registerOwnedAskUserQuestion } from '../services/askUserQuestionSessionOwner';

/**
 * The plugin half of the ask-question channel.
 *
 * These two routes are called by the OpenClaw plugin over loopback, not by a
 * signed-in browser, so they authenticate with the gateway token instead of a
 * user session. They live on their own router mounted ahead of the main gateway
 * router, which applies `authenticateToken` to everything it owns.
 */
const router = Router();

function assertPluginCaller(req: Request): void {
  const presented = String(req.get('x-openclaw-gateway-token') || '').trim();
  const expected = String(getGatewayToken() || '').trim();
  const unauthorized = new AskUserQuestionError(
    'ASK_USER_UNAUTHORIZED',
    'Plugin authentication failed.',
    401,
  );
  if (!expected || !presented || presented.length !== expected.length) throw unauthorized;
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) throw unauthorized;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof AskUserQuestionError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  console.error('[ask-user] plugin channel error:', error);
  res.status(500).json({ error: 'The question channel is unavailable.' });
}

router.post('/register', async (req: Request, res: Response) => {
  try {
    assertPluginCaller(req);
    const record = await registerOwnedAskUserQuestion({
      sessionKey: req.body?.sessionKey,
      runId: req.body?.runId,
      toolCallId: req.body?.toolCallId,
      questions: req.body?.questions,
      waitMs: Number(req.body?.waitMs) || undefined,
    });
    res.json({ id: record.id, expiresAt: record.expiresAt });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/await/:id', async (req: Request, res: Response) => {
  try {
    assertPluginCaller(req);
    const settled = await waitForAskUserAnswer(String(req.params.id || ''));
    res.json({
      id: settled.id,
      state: settled.state,
      result: formatAskUserAnswerForModel(settled),
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
