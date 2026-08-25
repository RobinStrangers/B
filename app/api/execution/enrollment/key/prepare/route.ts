import { apiErrorResponse } from '@/app/lib/api';
import { authorizeExecutionRequest, proxyExecution, readExecutionBody } from '@/app/lib/execution-api';
import { validateKeyPrepare } from '@/app/lib/execution-validation';

export async function POST(request: Request) {
  try {
    const actor = await authorizeExecutionRequest(request, true);
    const body = validateKeyPrepare(await readExecutionBody(request));
    return await proxyExecution({ request, path: '/v1/enrollment/key/prepare', mutation: true, body, actor });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
