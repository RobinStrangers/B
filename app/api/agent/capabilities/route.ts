import { executionBoundary } from '@/app/lib/execution-boundary';
import { apiErrorResponse, privateJson, requirePrivyProfileUser } from '@/app/lib/api';

export async function GET(request: Request) {
  try {
    await requirePrivyProfileUser(request);
    return privateJson({
      execution: executionBoundary,
      intelligence: {
        mode: 'structured-policy',
        modelServiceConnected: false,
        modelId: 'structured-policy-v1',
        description: 'Deterministic intent parsing and risk review are active. A generative model service is not connected.',
      },
      supportedIntents: [
        'perp_order_preview',
        'close_position_preview',
        'cancel_order_preview',
        'deposit_preview',
        'withdrawal_preview',
        'account_query',
        'market_query',
        'navigation',
      ],
      limits: {
        messageCharacters: 1200,
        messagesPerMinute: 20,
        messagesPerConversation: 200,
        activeConversations: 30,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
