import {
  apiErrorResponse,
  ApiError,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import { agentExecutionRequest } from '@/app/lib/agent-execution';
import { canonicalExecutionPayload } from '@/app/lib/execution-authorization';
import { proxyExecution } from '@/app/lib/execution-api';
import { validateCancel, validateClose, validateOrder } from '@/app/lib/execution-validation';
import { getAgentIntent } from '@/db/agent';

const INTENT_ID = /^agi_[a-f0-9]{32}$/;
type RouteContext = { params: Promise<{ intentId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const actor = await requirePrivyProfileUser(request);
    const { user } = actor;
    const { intentId } = await context.params;
    if (!INTENT_ID.test(intentId)) {
      throw new ApiError(404, 'AGENT_RESOURCE_NOT_FOUND', 'The requested Signal Desk resource was not found.');
    }
    const intent = await getAgentIntent(user.id, intentId);
    if (intent.status !== 'acknowledged') {
      throw new ApiError(409, 'INTENT_NOT_ACKNOWLEDGED', 'A current acknowledged intent is required before execution.');
    }
    if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) {
      throw new ApiError(409, 'INTENT_EXPIRED', 'This intent expired. Create and acknowledge a fresh intent.');
    }

    let expected;
    try {
      expected = agentExecutionRequest(intent);
    } catch (error) {
      throw new ApiError(422, 'INTENT_NOT_EXECUTABLE', error instanceof Error ? error.message : 'This intent is not executable.');
    }
    const body = await readJsonObject(request);
    const validated = expected.action === 'order'
      ? validateOrder(body)
      : expected.action === 'close'
        ? validateClose(body)
        : validateCancel(body);
    const { authorization, ...executionPayload } = validated;
    if (canonicalExecutionPayload(executionPayload) !== canonicalExecutionPayload(expected.payload)) {
      throw new ApiError(409, 'INTENT_PAYLOAD_MISMATCH', 'The signed execution payload no longer matches the acknowledged intent.');
    }

    return await proxyExecution({
      request,
      path: expected.remotePath,
      mutation: true,
      body: { ...executionPayload, authorization },
      actor,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
