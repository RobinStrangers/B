import { apiErrorResponse } from '@/app/lib/api';
import { authorizeExecutionRequest, proxyExecution, readExecutionBody } from '@/app/lib/execution-api';
import { validateCancelAll } from '@/app/lib/execution-validation';

export async function POST(request: Request) {
  try {
    const actor = await authorizeExecutionRequest(request, true);
    const body = validateCancelAll(await readExecutionBody(request));
    return await proxyExecution({ request, path: '/v1/orders/cancel-all', mutation: true, body, actor });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
