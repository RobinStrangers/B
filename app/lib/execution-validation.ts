import { ApiError } from './api';
import {
  assertOnlyKeys,
  optionalInteger,
  optionalString,
  requiredInteger,
  requiredString,
} from './execution-api';
import { maxLeverageForMarket } from './market-risk';
import { EXECUTION_CONSENT_VERSION } from './execution-authorization';
import { markets } from '../markets';

export const DECIMAL = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
export const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
export const SIGNATURE = /^0x[a-fA-F0-9]{130}$/;
export const CHALLENGE_ID = /^[a-f0-9]{32}$/;
export const ORDER_ID = /^[1-9]\d{0,18}$/;

export const executableMarketIds = new Set(
  markets.filter((market) => market.venueSymbol).map((market) => market.id),
);

export function executionMarket(value: unknown) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'MARKET_REQUIRED', 'A supported market is required.');
  }
  const market = markets.find((item) => item.id === value);
  if (!market || !market.venueSymbol) {
    throw new ApiError(
      422,
      'MARKET_REFERENCE_ONLY',
      'This instrument is reference-only because the execution venue does not list the exact underlying market.',
    );
  }
  return market;
}

function executionMarketSymbol(value: unknown) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'MARKET_REQUIRED', 'A supported execution market is required.');
  }
  const symbol = value.trim().toUpperCase();
  const market = markets.find((item) => item.venueSymbol === symbol);
  if (!market) {
    throw new ApiError(422, 'MARKET_REFERENCE_ONLY', 'This exact market is not executable on the venue.');
  }
  return market;
}

function decimalInRange(
  body: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  message: string,
) {
  const value = requiredString(body, key, DECIMAL, message);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new ApiError(400, 'INVALID_EXECUTION_REQUEST', message);
  }
  return value;
}

export function validateKeyPrepare(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['accountIndex']);
  const accountIndex = optionalInteger(body, 'accountIndex', 0, 281_474_976_710_655);
  return accountIndex === undefined ? {} : { accountIndex };
}

export function validateChallengeComplete(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['challengeId', 'signature']);
  return {
    challengeId: requiredString(body, 'challengeId', CHALLENGE_ID, 'A valid execution challenge is required.'),
    signature: requiredString(body, 'signature', SIGNATURE, 'A valid EVM signature is required.'),
  };
}

function validateAuthorization(body: Record<string, unknown>) {
  const value = body.authorization;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'EXECUTION_AUTHORIZATION_REQUIRED', 'A wallet-signed execution authorization is required.');
  }
  const authorization = value as Record<string, unknown>;
  assertOnlyKeys(authorization, ['walletAddress', 'issuedAt', 'expiresAt', 'signature']);
  const issuedAt = requiredInteger(authorization, 'issuedAt', 1_700_000_000_000, 4_000_000_000_000);
  const expiresAt = requiredInteger(authorization, 'expiresAt', 1_700_000_000_000, 4_000_000_000_000);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 30_000) {
    throw new ApiError(400, 'INVALID_AUTHORIZATION_WINDOW', 'Execution authorization must expire within 30 seconds.');
  }
  return {
    walletAddress: requiredString(authorization, 'walletAddress', ADDRESS, 'A valid signing wallet is required.'),
    issuedAt,
    expiresAt,
    signature: requiredString(authorization, 'signature', SIGNATURE, 'A valid EVM signature is required.'),
  };
}

function validateConsent(body: Record<string, unknown>) {
  return requiredString(
    body,
    'consentVersion',
    new RegExp(`^${EXECUTION_CONSENT_VERSION}$`),
    'The current 0.17% fee consent is required.',
  );
}

export function validateOrder(body: Record<string, unknown>) {
  assertOnlyKeys(body, [
    'marketSymbol',
    'side',
    'orderType',
    'collateralUsd',
    'leverage',
    'limitPrice',
    'slippagePercent',
    'marginMode',
    'consentVersion',
    'authorization',
  ]);
  const market = executionMarketSymbol(body.marketSymbol);
  if (body.side !== 'LONG' && body.side !== 'SHORT') {
    throw new ApiError(400, 'INVALID_SIDE', 'Side must be LONG or SHORT.');
  }
  if (body.orderType !== 'MARKET' && body.orderType !== 'LIMIT') {
    throw new ApiError(400, 'INVALID_ORDER_TYPE', 'Only MARKET and LIMIT orders are enabled.');
  }
  if (body.marginMode !== 'CROSS' && body.marginMode !== 'ISOLATED') {
    throw new ApiError(400, 'INVALID_MARGIN_MODE', 'Margin mode must be CROSS or ISOLATED.');
  }
  const limitPrice = optionalString(body, 'limitPrice', DECIMAL, 'Limit price is invalid.');
  if (body.orderType === 'LIMIT' && (!limitPrice || Number(limitPrice) <= 0)) {
    throw new ApiError(400, 'LIMIT_PRICE_REQUIRED', 'A positive limit price is required.');
  }
  if (body.orderType === 'MARKET' && limitPrice !== undefined) {
    throw new ApiError(400, 'LIMIT_PRICE_INVALID', 'Market orders do not accept a limit price.');
  }
  return {
    marketSymbol: market.venueSymbol!,
    side: body.side,
    orderType: body.orderType,
    collateralUsd: decimalInRange(body, 'collateralUsd', 1, 100_000, 'Collateral must be from 1 to 100,000 USDG.'),
    leverage: requiredInteger(body, 'leverage', 1, maxLeverageForMarket(market)),
    ...(limitPrice ? { limitPrice } : {}),
    slippagePercent: decimalInRange(body, 'slippagePercent', 0.01, 1, 'Slippage must be from 0.01% to 1.00%.'),
    marginMode: body.marginMode,
    consentVersion: validateConsent(body),
    authorization: validateAuthorization(body),
  };
}

export function validateCancel(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['marketSymbol', 'orderId', 'authorization']);
  const market = executionMarketSymbol(body.marketSymbol);
  return {
    marketSymbol: market.venueSymbol!,
    orderId: requiredString(body, 'orderId', ORDER_ID, 'A valid numeric venue order ID is required.'),
    authorization: validateAuthorization(body),
  };
}

export function validateCancelAll(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['marketSymbol', 'authorization']);
  return {
    ...(body.marketSymbol === undefined || body.marketSymbol === null
      ? {}
      : { marketSymbol: executionMarketSymbol(body.marketSymbol).venueSymbol! }),
    authorization: validateAuthorization(body),
  };
}

export function validateClose(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['marketSymbol', 'closePercent', 'slippagePercent', 'consentVersion', 'authorization']);
  const market = executionMarketSymbol(body.marketSymbol);
  return {
    marketSymbol: market.venueSymbol!,
    closePercent: decimalInRange(body, 'closePercent', 0.01, 100, 'Close percentage must be from 0.01% to 100%.'),
    slippagePercent: decimalInRange(body, 'slippagePercent', 0.01, 1, 'Slippage must be from 0.01% to 1.00%.'),
    consentVersion: validateConsent(body),
    authorization: validateAuthorization(body),
  };
}
