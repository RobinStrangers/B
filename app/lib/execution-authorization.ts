export const EXECUTION_CONSENT_VERSION = '2026-08-24';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function canonicalExecutionPayload(payload: unknown) {
  return JSON.stringify(canonicalValue(payload));
}

export function executionAuthorizationMessage(options: {
  action: 'order' | 'cancel' | 'cancel-all' | 'close' | 'withdraw';
  idempotencyKey: string;
  issuedAt: number;
  expiresAt: number;
  payload: unknown;
}) {
  return [
    'Aventa Execution Authorization',
    'Version: 1',
    'Audience: aventa-execution-v1',
    'Venue: Robinhood Lighter',
    'Execution Chain ID: 466324',
    'Fee Policy: 2026-08-24/17-bps',
    'Chain ID: 4663',
    `Action: ${options.action}`,
    `Request ID: ${options.idempotencyKey.toLowerCase()}`,
    `Issued At: ${options.issuedAt}`,
    `Expires At: ${options.expiresAt}`,
    `Payload: ${canonicalExecutionPayload(options.payload)}`,
  ].join('\n');
}
