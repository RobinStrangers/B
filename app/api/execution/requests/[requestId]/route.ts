import { ApiError, apiErrorResponse } from '@/app/lib/api';
import { authorizeExecutionRequest, proxyExecution } from '@/app/lib/execution-api';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RouteContext = { params: Promise<{ requestId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await authorizeExecutionRequest(request);
    const { requestId } = await context.params;
    if (!REQUEST_ID.test(requestId)) throw new ApiError(404, 'EXECUTION_REQUEST_NOT_FOUND', 'The execution request was not found.');
    return await proxyExecution({ request, path: `/v1/requests/${encodeURIComponent(requestId.toLowerCase())}`, actor });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
