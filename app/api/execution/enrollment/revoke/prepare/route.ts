import { ApiError, apiErrorResponse } from '@/app/lib/api';
import { authorizeExecutionRequest, proxyExecution, readExecutionBody } from '@/app/lib/execution-api';

export async function POST(request: Request) {
  try {
    const actor = await authorizeExecutionRequest(request, true);
    const body = await readExecutionBody(request);
    if (Object.keys(body).length) throw new ApiError(400, 'UNSUPPORTED_FIELD', 'This request does not accept parameters.');
    return await proxyExecution({ request, path: '/v1/enrollment/revoke/prepare', mutation: true, body: {}, actor });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
