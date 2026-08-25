import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import { reviewAgentIntent } from '@/db/agent';

const INTENT_ID = /^agi_[a-f0-9]{32}$/;
const PAYLOAD_HASH = /^0x[a-f0-9]{64}$/;
type RouteContext = { params: Promise<{ intentId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const { user } = await requirePrivyProfileUser(request);
    const { intentId } = await context.params;
    if (!INTENT_ID.test(intentId)) {
      throw new ApiError(404, 'AGENT_RESOURCE_NOT_FOUND', 'The requested Signal Desk resource was not found.');
    }
    const body = await readJsonObject(request);
    const supportedKeys = new Set(['decision', 'payloadHash', 'version']);
    if (Object.keys(body).some((key) => !supportedKeys.has(key))) {
      throw new ApiError(400, 'UNSUPPORTED_FIELD', 'The intent review contains an unsupported field.');
    }
    if (body.decision !== 'acknowledge' && body.decision !== 'reject') {
      throw new ApiError(400, 'INVALID_REVIEW_DECISION', 'Choose acknowledge or reject.');
    }
    if (typeof body.payloadHash !== 'string' || !PAYLOAD_HASH.test(body.payloadHash)) {
      throw new ApiError(400, 'INVALID_PAYLOAD_HASH', 'A valid intent payload hash is required.');
    }
    if (!Number.isInteger(body.version) || Number(body.version) < 1) {
      throw new ApiError(400, 'INVALID_INTENT_VERSION', 'A positive intent version is required.');
    }
    const intent = await reviewAgentIntent(
      user.id,
      intentId,
      body.decision,
      body.payloadHash,
      Number(body.version),
    );
    return privateJson({ intent });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
