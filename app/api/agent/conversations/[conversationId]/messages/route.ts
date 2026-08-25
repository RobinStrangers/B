import { analyzeAgentMessage } from '@/app/lib/agent-intent';
import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import { markets } from '@/app/markets';
import { appendAgentTurn, getAgentConversation } from '@/db/agent';

const CONVERSATION_ID = /^agc_[a-f0-9]{32}$/;
const CLIENT_REQUEST_ID = /^[a-zA-Z0-9._:-]{8,100}$/;
const MARKET_IDS = new Set(markets.map((market) => market.id));

type RouteContext = { params: Promise<{ conversationId: string }> };

async function getConversationId(context: RouteContext) {
  const { conversationId } = await context.params;
  if (!CONVERSATION_ID.test(conversationId)) {
    throw new ApiError(404, 'AGENT_RESOURCE_NOT_FOUND', 'The requested Signal Desk resource was not found.');
  }
  return conversationId;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { user } = await requirePrivyProfileUser(request);
    return privateJson(await getAgentConversation(user.id, await getConversationId(context)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const { user } = await requirePrivyProfileUser(request);
    const conversationId = await getConversationId(context);
    const body = await readJsonObject(request);
    const supportedKeys = new Set(['clientRequestId', 'text', 'context']);
    if (Object.keys(body).some((key) => !supportedKeys.has(key))) {
      throw new ApiError(400, 'UNSUPPORTED_FIELD', 'The message request contains an unsupported field.');
    }
    if (typeof body.clientRequestId !== 'string' || !CLIENT_REQUEST_ID.test(body.clientRequestId)) {
      throw new ApiError(400, 'INVALID_CLIENT_REQUEST_ID', 'Use a unique 8 to 100 character client request identifier.');
    }
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > 1200) {
      throw new ApiError(400, 'INVALID_AGENT_MESSAGE', 'The message must contain 1 to 1,200 characters.');
    }

    let contextMarketId: string | null = null;
    if (body.context !== undefined) {
      if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        throw new ApiError(400, 'INVALID_AGENT_CONTEXT', 'The message context must be an object.');
      }
      const contextValue = body.context as Record<string, unknown>;
      if (Object.keys(contextValue).some((key) => key !== 'marketId')) {
        throw new ApiError(400, 'UNSUPPORTED_CONTEXT_FIELD', 'The message context contains an unsupported field.');
      }
      if (contextValue.marketId !== undefined) {
        if (typeof contextValue.marketId !== 'string' || !MARKET_IDS.has(contextValue.marketId)) {
          throw new ApiError(400, 'INVALID_MARKET', 'Choose a market from the current Aventa catalog.');
        }
        contextMarketId = contextValue.marketId;
      }
    }

    const text = body.text.trim();
    const analysis = analyzeAgentMessage(text, contextMarketId);
    return privateJson(await appendAgentTurn(
      user.id,
      conversationId,
      body.clientRequestId,
      text,
      contextMarketId,
      analysis,
    ));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
