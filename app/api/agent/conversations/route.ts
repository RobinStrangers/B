import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import { createAgentConversation, listAgentConversations } from '@/db/agent';

export async function GET(request: Request) {
  try {
    const { user } = await requirePrivyProfileUser(request);
    return privateJson({ conversations: await listAgentConversations(user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requirePrivyProfileUser(request);
    const body = await readJsonObject(request);
    if (Object.keys(body).some((key) => key !== 'title')) {
      throw new ApiError(400, 'UNSUPPORTED_FIELD', 'The conversation request contains an unsupported field.');
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 80)) {
      throw new ApiError(400, 'INVALID_TITLE', 'The conversation title must contain 1 to 80 characters.');
    }
    const conversation = await createAgentConversation(user.id, typeof body.title === 'string' ? body.title : null);
    return privateJson({ conversation }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
