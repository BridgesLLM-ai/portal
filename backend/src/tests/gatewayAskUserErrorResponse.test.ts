import { PendingUserInputAnswerError } from '../agents/providers/PersistentGatewayWs';
import { __gatewayAskUserTest } from '../routes/gateway';
import { AskUserQuestionError } from '../services/askUserQuestionBroker';

function responseDouble() {
  const response: any = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('gateway ask-user error projection', () => {
  test.each([
    new AskUserQuestionError('ASK_USER_NOT_FOUND', 'private broker detail', 404),
    new PendingUserInputAnswerError('REQUEST_NOT_FOUND', 'private runtime detail', 404),
  ])('projects hidden or settled questions to the stable reconciliation response', (error) => {
    const response = responseDouble();

    __gatewayAskUserTest.askUserErrorResponse(response, error);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: 'That question is no longer open.',
      code: 'ASK_USER_NOT_OPEN',
    });
  });

  test('preserves actionable validation errors instead of suppressing them as stale state', () => {
    const response = responseDouble();

    __gatewayAskUserTest.askUserErrorResponse(
      response,
      new AskUserQuestionError('ASK_USER_INVALID_ANSWERS', 'Choose one option.', 400),
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Choose one option.',
      code: 'ASK_USER_INVALID_ANSWERS',
    });
  });
});
