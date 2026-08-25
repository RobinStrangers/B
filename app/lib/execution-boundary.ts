import { getExecutionConfigurationStatus } from './execution-client';

const configuration = getExecutionConfigurationStatus();

export const executionBoundary = {
  state: configuration.configured ? 'remote-readiness-required' : 'locked',
  code: configuration.configured ? 'EXECUTION_READINESS_REQUIRED' : 'EXECUTION_SIGNER_REQUIRED',
  mode: configuration.mode,
  canDraft: true,
  canReview: true,
  canPrepare: configuration.configured,
  // Submission is always decided per request by the isolated signer. A static
  // UI policy endpoint must never claim that a user's key/account is ready.
  canSubmit: false,
  message: configuration.configured
    ? 'The signer is configured. Live submission requires this account, market, fee approval, and signer readiness to pass at request time.'
    : 'Live order submission requires the isolated Aventa signer service and a user-owned Lighter API key. No browser-only fallback is permitted.',
} as const;
