import { EXECUTION_CONSENT_VERSION } from './execution-authorization';
import { markets } from '../markets';

type ExecutableIntent = {
  intentType: string;
  payload: Record<string, unknown>;
};

export type AgentExecutionRequest = {
  action: 'order' | 'cancel' | 'close';
  path: '/api/execution/orders' | '/api/execution/orders/cancel' | '/api/execution/positions/close';
  remotePath: '/v1/orders' | '/v1/orders/cancel' | '/v1/positions/close';
  payload: Record<string, unknown>;
};

export function agentIntentIdempotencyKey(intentId: string) {
  const source = /^agi_([a-f0-9]{32})$/.exec(intentId)?.[1];
  if (!source) throw new Error('The intent identifier is invalid.');
  const variant = ((Number.parseInt(source[16], 16) & 0x3) | 0x8).toString(16);
  return `${source.slice(0, 8)}-${source.slice(8, 12)}-7${source.slice(13, 16)}-${variant}${source.slice(17, 20)}-${source.slice(20)}`;
}

function string(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function decimal(value: unknown) {
  const result = string(value);
  return result && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(result) && Number(result) > 0 ? result : undefined;
}

function executableMarket(value: unknown) {
  const id = string(value);
  return id ? markets.find((market) => market.id === id && market.venueSymbol) : undefined;
}

export function agentExecutionRequest(intent: ExecutableIntent): AgentExecutionRequest {
  const source = intent.payload;
  if (intent.intentType === 'perp_order_preview' && source.kind === 'perp_order_preview') {
    const market = executableMarket(source.marketId);
    const collateral = decimal(source.size);
    const leverage = Number(source.leverage);
    const slippage = Number(source.slippagePercent);
    if (!market) throw new Error('This intent targets a reference-only market.');
    if (source.asset !== 'USDG') throw new Error('Live execution accepts USDG collateral only. Create a new intent using USDG.');
    if (!collateral || !Number.isInteger(leverage) || leverage < 1) throw new Error('The intent does not contain executable size and leverage values.');
    if (source.side !== 'long' && source.side !== 'short') throw new Error('The intent does not contain one executable side.');
    if (source.orderType !== 'market' && source.orderType !== 'limit') throw new Error('Only market and limit intents are enabled for live execution.');
    if (source.marginMode !== 'cross' && source.marginMode !== 'isolated') throw new Error('The margin mode is not executable.');
    if (source.reduceOnly === true) throw new Error('Open intents cannot be reduce-only. Create a close intent instead.');
    if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 1) throw new Error('Live execution slippage must be from 0.01% to 1.00%.');
    const limitPrice = decimal(source.limitPrice);
    if (source.orderType === 'limit' && !limitPrice) throw new Error('The limit price is missing.');
    return {
      action: 'order',
      path: '/api/execution/orders',
      remotePath: '/v1/orders',
      payload: {
        marketSymbol: market.venueSymbol,
        side: source.side.toUpperCase(),
        orderType: source.orderType.toUpperCase(),
        collateralUsd: collateral,
        leverage,
        marginMode: source.marginMode.toUpperCase(),
        ...(limitPrice ? { limitPrice } : {}),
        slippagePercent: slippage.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''),
        consentVersion: EXECUTION_CONSENT_VERSION,
      },
    };
  }

  if (intent.intentType === 'close_position_preview' && source.kind === 'close_position_preview') {
    const market = executableMarket(source.marketId);
    const percent = Number(source.closePercent);
    const slippage = Number(source.slippagePercent);
    if (!market) throw new Error('This close intent targets a reference-only market.');
    if (!Number.isInteger(percent) || percent < 1 || percent > 100 || source.reduceOnly !== true) throw new Error('The close percentage is not executable.');
    if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 1) throw new Error('Live execution slippage must be from 0.01% to 1.00%.');
    return {
      action: 'close',
      path: '/api/execution/positions/close',
      remotePath: '/v1/positions/close',
      payload: {
        marketSymbol: market.venueSymbol,
        closePercent: String(percent),
        slippagePercent: slippage.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''),
        consentVersion: EXECUTION_CONSENT_VERSION,
      },
    };
  }

  if (intent.intentType === 'cancel_order_preview' && source.kind === 'cancel_order_preview') {
    const market = executableMarket(source.marketId);
    const orderId = string(source.orderId);
    if (!market) throw new Error('This cancellation intent has no exact executable market.');
    if (!orderId || !/^[1-9]\d{0,18}$/.test(orderId)) throw new Error('The cancellation intent has no valid numeric venue order ID.');
    return {
      action: 'cancel',
      path: '/api/execution/orders/cancel',
      remotePath: '/v1/orders/cancel',
      payload: { marketSymbol: market.venueSymbol, orderId },
    };
  }

  throw new Error('This intent type cannot execute funds or trades.');
}
