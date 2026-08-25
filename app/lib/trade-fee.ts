export const aventaTradeFeePolicy = {
  basis: 'filled_notional',
  bps: 17,
  percent: 0.17,
  rate: 0.0017,
  lighterFeeUnits: 1_700,
  lighterFeeUnitScale: 1_000_000,
  treasuryAddress: '0xCe8756522C90B405c9647aE6BbcA169240965225',
  integratorAccountIndex: 17_005 as number | null,
  appliesTo: ['open', 'increase', 'reduce', 'close'] as const,
  userApprovalRequired: true,
} as const;

export function estimateAventaTradeFee(filledNotional?: number) {
  if (filledNotional === undefined || !Number.isFinite(filledNotional) || filledNotional <= 0) return undefined;
  return filledNotional * aventaTradeFeePolicy.rate;
}

export function isAventaTreasuryConfigured() {
  return Number.isInteger(aventaTradeFeePolicy.integratorAccountIndex)
    && Number(aventaTradeFeePolicy.integratorAccountIndex) >= 0;
}
