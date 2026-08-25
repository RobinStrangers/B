import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import { archiveAgentConversation } from '@/db/agent';

const CONVERSATION_ID = /^agc_[a-f0-9]{32}$/;
type RouteContext = { params: Promise<{ conversationId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const { user } = await requirePrivyProfileUser(request);
    const { conversationId } = await context.params;
    if (!CONVERSATION_ID.test(conversationId)) {
      throw new ApiError(404, 'AGENT_RESOURCE_NOT_FOUND', 'The requested Signal Desk resource was not found.');
    }
    const body = await readJsonObject(request);
    if (Object.keys(body).length !== 1 || body.status !== 'archived') {
      throw new ApiError(400, 'INVALID_CONVERSATION_UPDATE', 'Only an explicit archived status is supported.');
    }
    return privateJson({ conversation: await archiveAgentConversation(user.id, conversationId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
