import { executionBoundary } from '../../../lib/execution-boundary';
import { aventaTradeFeePolicy, isAventaTreasuryConfigured } from '../../../lib/trade-fee';

export async function GET() {
  const treasuryConfigured = isAventaTreasuryConfigured();
  const collectionReady = treasuryConfigured && executionBoundary.canSubmit;

  return Response.json({
    execution: executionBoundary,
    feePolicy: {
      basis: aventaTradeFeePolicy.basis,
      bps: aventaTradeFeePolicy.bps,
      percent: aventaTradeFeePolicy.percent,
      lighterFeeUnits: aventaTradeFeePolicy.lighterFeeUnits,
      treasuryAddress: aventaTradeFeePolicy.treasuryAddress,
      integratorAccountIndex: aventaTradeFeePolicy.integratorAccountIndex,
      appliesTo: aventaTradeFeePolicy.appliesTo,
      userApprovalRequired: aventaTradeFeePolicy.userApprovalRequired,
      treasuryConfigured,
      collectionReady,
      collectionState: !treasuryConfigured
        ? 'pending_integrator_account'
        : executionBoundary.canSubmit
          ? 'user_approval_required'
          : 'pending_execution_authority',
    },
  }, {
    headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' },
  });
}
