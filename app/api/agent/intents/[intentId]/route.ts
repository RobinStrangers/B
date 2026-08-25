import { apiErrorResponse, ApiError, privateJson, requirePrivyProfileUser } from '@/app/lib/api';
import { getAgentIntent } from '@/db/agent';

const INTENT_ID = /^agi_[a-f0-9]{32}$/;
type RouteContext = { params: Promise<{ intentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { user } = await requirePrivyProfileUser(request);
    const { intentId } = await context.params;
    if (!INTENT_ID.test(intentId)) {
      throw new ApiError(404, 'AGENT_RESOURCE_NOT_FOUND', 'The requested Signal Desk resource was not found.');
    }
    return privateJson({ intent: await getAgentIntent(user.id, intentId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
