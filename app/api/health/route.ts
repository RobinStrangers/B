import { apiErrorResponse, privateJson } from '@/app/lib/api';
import { getPrivyConfigurationStatus } from '@/app/lib/privy-server';
import { checkDatabaseHealth } from '@/db/account';
import { getExecutionConfigurationStatus } from '@/app/lib/execution-client';

export async function GET() {
  try {
    const databaseReady = await checkDatabaseHealth();
    return privateJson({
      status: databaseReady ? 'ready' : 'degraded',
      database: databaseReady ? 'ready' : 'unavailable',
      authentication: {
        privy: getPrivyConfigurationStatus(),
        sitesFallback: process.env.ALLOW_SITES_AUTH_FALLBACK === 'true' ? 'enabled' : 'disabled',
      },
      execution: getExecutionConfigurationStatus(),
      chainId: 4663,
      checkedAt: new Date().toISOString(),
    }, { status: databaseReady ? 200 : 503 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
