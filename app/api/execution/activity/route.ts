import { apiErrorResponse } from '@/app/lib/api';
import { authorizeExecutionRequest, proxyExecution } from '@/app/lib/execution-api';

export async function GET(request: Request) {
  try {
    const actor = await authorizeExecutionRequest(request);
    return await proxyExecution({ request, path: '/v1/activity', actor });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
