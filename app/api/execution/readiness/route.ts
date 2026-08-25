import { apiErrorResponse } from '@/app/lib/api';
import { authorizeExecutionRequest, proxyExecution } from '@/app/lib/execution-api';
import { executionMarket } from '@/app/lib/execution-validation';

export async function GET(request: Request) {
  try {
    const actor = await authorizeExecutionRequest(request);
    const marketId = new URL(request.url).searchParams.get('market');
    const market = marketId ? executionMarket(marketId) : undefined;
    return await proxyExecution({
      request,
      path: market ? `/v1/readiness?market=${encodeURIComponent(market.venueSymbol!)}` : '/v1/readiness',
      actor,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
