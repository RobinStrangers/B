import { formatPair, markets, type Market } from '../markets';
import { executionBoundary } from './execution-boundary';
import { maxLeverageForMarket } from './market-risk';
import { aventaTradeFeePolicy, estimateAventaTradeFee } from './trade-fee';

export type AgentIntentType =
  | 'perp_order_preview'
  | 'close_position_preview'
  | 'cancel_order_preview'
  | 'deposit_preview'
  | 'withdrawal_preview'
  | 'account_query'
  | 'market_query'
  | 'navigation';

export type AgentIntentStatus = 'needs_input' | 'proposed' | 'completed' | 'blocked';

export type AgentIntentAnalysis = {
  assistantMessage: string;
  expiresAtMs: number | null;
  intentType: AgentIntentType | null;
  marketId: string | null;
  payload: Record<string, unknown>;
  risk: {
    checks: string[];
    level: 'information' | 'guarded' | 'high';
    warnings: string[];
  };
  status: AgentIntentStatus | null;
  summary: string;
  title: string;
};

const aliases: Record<string, string> = {
  bitcoin: 'btc-usdt',
  ether: 'eth-usdt',
  ethereum: 'eth-usdt',
  ripple: 'xrp-usdt',
  solana: 'sol-usdt',
  dogecoin: 'doge-usdt',
  cardano: 'ada-usdt',
  avalanche: 'avax-usdt',
  chainlink: 'link-usdt',
  gold: 'xau-usd',
  silver: 'xag-usd',
  oil: 'wti-usd',
  apple: 'aapl',
  microsoft: 'msft',
  nvidia: 'nvda',
  amazon: 'amzn',
  alphabet: 'googl',
  google: 'googl',
  tesla: 'tsla',
  netflix: 'nflx',
  coinbase: 'coin',
};

const uniqueBases = new Set(
  markets
    .map((market) => market.base.toLowerCase())
    .filter((base, index, values) => values.indexOf(base) === values.lastIndexOf(base)),
);

function includesToken(text: string, token: string) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function resolveMarkets(text: string, contextMarketId?: string | null) {
  const normalized = text.toLowerCase();
  const ids = new Set<string>();

  for (const market of markets) {
    const base = market.base.toLowerCase();
    const quote = market.quote.toLowerCase();
    const variants = [
      market.id,
      `${base}/${quote}`,
      `${base} / ${quote}`,
      `${base}-${quote}`,
      `${base}${quote}`,
    ];
    if (
      variants.some((variant) => normalized.includes(variant))
      || (uniqueBases.has(base) && includesToken(normalized, base))
    ) {
      ids.add(market.id);
    }
  }

  for (const [alias, marketId] of Object.entries(aliases)) {
    if (includesToken(normalized, alias)) ids.add(marketId);
  }

  if (!ids.size && contextMarketId && markets.some((market) => market.id === contextMarketId)) {
    ids.add(contextMarketId);
  }
  return [...ids].map((id) => markets.find((market) => market.id === id) as Market);
}

function canonicalDecimal(value: string | undefined) {
  if (!value) return null;
  const normalized = value.replace(/,/g, '');
  if (!/^\d{1,12}(?:\.\d{1,8})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const canonicalWhole = whole.replace(/^0+(?=\d)/, '');
  const canonicalFraction = fraction.replace(/0+$/, '');
  return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole;
}

function extractAmount(text: string) {
  const candidates: Array<{ amount: string | null; asset: string; index: number }> = [];
  const anchored: Array<{ amount: string | null; asset: string; index: number }> = [];
  const currencyPattern = /(?:\$\s*)?(\d[\d,.]*(?:\.\d+)?)\s*(usdt|usdc|usdg|eth|usd)\b/gi;

  for (const match of text.matchAll(currencyPattern)) {
    candidates.push({
      amount: canonicalDecimal(match[1]),
      asset: match[2].toUpperCase(),
      index: match.index,
    });
  }

  const amountFirst = /(\d[\d,.]*(?:\.\d+)?)\s*(usdt|usdc|usdg|eth|usd)\s+(?:as\s+)?(?:collateral|margin)\b/gi;
  for (const match of text.matchAll(amountFirst)) {
    anchored.push({ amount: canonicalDecimal(match[1]), asset: match[2].toUpperCase(), index: match.index });
  }
  const labelFirst = /(?:collateral|margin|size)(?:\s+(?:of|at|is))?\s*[:=]?\s*(?:\$\s*)?(\d[\d,.]*(?:\.\d+)?)\s*(usdt|usdc|usdg|eth|usd)\b/gi;
  for (const match of text.matchAll(labelFirst)) {
    anchored.push({ amount: canonicalDecimal(match[1]), asset: match[2].toUpperCase(), index: match.index });
  }

  const uniqueAnchored = anchored.filter((candidate, index, values) => (
    values.findIndex((value) => value.amount === candidate.amount && value.asset === candidate.asset) === index
  ));
  if (uniqueAnchored.length === 1) {
    return { amount: uniqueAnchored[0].amount, asset: uniqueAnchored[0].asset, ambiguous: false };
  }
  if (uniqueAnchored.length > 1) return { amount: null, asset: null, ambiguous: true };

  const nonPriceCandidates = candidates.filter((candidate) => {
    const prefix = text.slice(Math.max(0, candidate.index - 34), candidate.index);
    return !/(?:limit|stop|trigger|take\s+profit|stop\s+loss)(?:\s+(?:order|entry|price))?(?:\s+(?:at|of))?\s*\$?\s*$/i.test(prefix);
  });
  if (nonPriceCandidates.length === 1) {
    return { amount: nonPriceCandidates[0].amount, asset: nonPriceCandidates[0].asset, ambiguous: false };
  }
  if (nonPriceCandidates.length > 1) return { amount: null, asset: null, ambiguous: true };

  const dollarCandidates = [...text.matchAll(/\$\s*(\d[\d,.]*(?:\.\d+)?)/g)]
    .filter((match) => {
      const prefix = text.slice(Math.max(0, match.index - 34), match.index);
      return !/(?:limit|stop|trigger|take\s+profit|stop\s+loss)(?:\s+(?:order|entry|price))?(?:\s+(?:at|of))?\s*$/i.test(prefix);
    });
  if (dollarCandidates.length === 1) {
    return { amount: canonicalDecimal(dollarCandidates[0][1]), asset: 'USD', ambiguous: false };
  }
  return { amount: null, asset: null, ambiguous: dollarCandidates.length > 1 };
}

function extractPrices(text: string, label: 'limit' | 'take profit' | 'stop loss') {
  const prefix = label === 'limit' ? 'limit(?:\\s+order)?' : label;
  const expression = new RegExp(`${prefix}(?:\\s+price)?(?:\\s+(?:at|of))?\\s*\\$?\\s*(\\d[\\d,.]*(?:\\.\\d+)?)`, 'gi');
  return [...text.matchAll(expression)]
    .map((match) => canonicalDecimal(match[1]))
    .filter((value): value is string => value !== null)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function extractTriggerPrices(text: string) {
  const expression = /(?:stop\s+(?:order|entry)|entry\s+stop|trigger(?:\s+price)?)(?:\s+(?:at|of))?\s*\$?\s*(\d[\d,.]*(?:\.\d+)?)/gi;
  return [...text.matchAll(expression)]
    .map((match) => canonicalDecimal(match[1]))
    .filter((value): value is string => value !== null)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function extractClosePercentages(text: string) {
  const values: number[] = [];
  for (const match of text.matchAll(/\b(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const before = text.slice(Math.max(0, match.index - 90), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 70);
    const closeScoped = /\b(?:close|exit)\b/i.test(before)
      && !/\b(?:slippage|slip|fee|take\s+profit|stop\s+loss)\b[^.!?\n]*$/i.test(before);
    const positionScoped = /^\s*(?:of\s+)?(?:my\s+|the\s+)?[^.!?\n]{0,45}\b(?:position|trade|long|short)\b/i.test(after);
    const labelledAsAnotherParameter = /^\s*(?:slippage|slip|fee|take\s+profit|stop\s+loss)\b/i.test(after);
    if (!labelledAsAnotherParameter && (closeScoped || positionScoped)) values.push(Number(match[1]));
  }
  return values.filter((value, index, items) => items.indexOf(value) === index);
}

function extractSlippageValues(text: string) {
  const values = [
    ...[...text.matchAll(/(?:slippage|slip)(?:\s+tolerance)?\s*(?:at|of|is|=|:)?\s*(\d+(?:\.\d+)?)\s*%/gi)].map((match) => match[1]),
    ...[...text.matchAll(/\b(\d+(?:\.\d+)?)\s*%\s*(?:slippage|slip)(?:\s+tolerance)?\b/gi)].map((match) => match[1]),
  ]
    .map(canonicalDecimal)
    .filter((value): value is string => value !== null);
  return values.filter((value, index, items) => items.indexOf(value) === index);
}

function extractOrderIds(text: string) {
  const values: string[] = [];
  const labelled = /(?:order|ticket)\s+(?:id|number|no\.?)(?:\s+is)?\s*[:#]?\s*([a-z0-9][a-z0-9_-]{3,79})\b/gi;
  const marked = /(?:order|ticket)\s*#\s*([a-z0-9][a-z0-9_-]{3,79})\b/gi;
  const hashtagged = /#\s*([a-z0-9][a-z0-9_-]{3,79})\b/gi;
  const bare = /(?:order|ticket)\s+([a-z0-9][a-z0-9_-]{3,79})\b/gi;
  for (const expression of [labelled, marked, hashtagged]) {
    values.push(...[...text.matchAll(expression)].map((match) => match[1]));
  }
  values.push(...[...text.matchAll(bare)]
    .map((match) => match[1])
    .filter((value) => /\d/.test(value)));
  const shapedValues = values.filter((value) => /\d/.test(value));
  return shapedValues.filter((value, index, items) => (
    items.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index
  ));
}

function formatNotional(amount: string | null, leverage: number | null) {
  if (!amount || !leverage) return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000_000) return null;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(numeric * leverage);
}

function navigationTarget(text: string) {
  if (/\b(portfolio|positions?|orders?|balances?|account|profile)\b/i.test(text)) return '/trade?account=1';
  if (/\b(markets?|directory)\b/i.test(text)) return '/markets';
  if (/\b(platform|protocol|readiness|risk)\b/i.test(text)) return '/platform';
  if (/\b(home|landing)\b/i.test(text)) return '/';
  return '/trade';
}

function marketLine(market: Market) {
  return `${formatPair(market)} · ${market.source} · ${market.session} · ${maxLeverageForMarket(market)}× reference cap`;
}

export function analyzeAgentMessage(
  rawText: string,
  contextMarketId?: string | null,
  nowMs = Date.now(),
): AgentIntentAnalysis {
  const text = rawText.trim();
  const normalized = text.toLowerCase();
  const explicitMarkets = resolveMarkets(text, null);
  const matchedMarkets = explicitMarkets.length ? explicitMarkets : resolveMarkets(text, contextMarketId);
  const hasExplicitMarket = explicitMarkets.length > 0;
  const market = matchedMarkets[0] ?? null;
  const financialMarket = matchedMarkets.length === 1 ? market : null;
  const { amount, asset, ambiguous: amountAmbiguous } = extractAmount(text);
  const leverageValues = [...normalized.matchAll(/\b(\d{1,3})\s*[x×]\b/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, values) => values.indexOf(value) === index);
  const leverageAmbiguous = leverageValues.length > 1;
  const leverage = leverageValues.length === 1 ? leverageValues[0] : null;
  const hasIsolated = /\bisolated\b/.test(normalized);
  const hasCross = /\bcross\b/.test(normalized);
  const hasExplicitMarginMode = hasIsolated || hasCross;
  const marginModeAmbiguous = hasIsolated && hasCross;
  const marginMode = hasIsolated ? 'isolated' : 'cross';
  const reduceOnly = /\breduce[- ]?only\b/.test(normalized);
  const takeProfitValues = extractPrices(text, 'take profit');
  const stopLossValues = extractPrices(text, 'stop loss');
  const takeProfit = takeProfitValues.length === 1 ? takeProfitValues[0] : null;
  const stopLoss = stopLossValues.length === 1 ? stopLossValues[0] : null;
  const slippageValues = extractSlippageValues(normalized);
  const hasSlippageSignal = /\b(?:slippage|slip)\b/.test(normalized);
  const slippageAmbiguous = slippageValues.length > 1;
  const slippageUnparsed = hasSlippageSignal && slippageValues.length === 0;
  const explicitSlippage = slippageValues.length === 1 ? slippageValues[0] : null;
  const slippage = explicitSlippage ?? '0.5';
  const invalidSlippage = explicitSlippage !== null
    && (!Number.isFinite(Number(explicitSlippage)) || Number(explicitSlippage) <= 0 || Number(explicitSlippage) > 5);
  const isCancel = /\bcancel\b/.test(normalized) && /\b(order|ticket)\b/.test(normalized);
  const isClose = /\b(close|exit)\b/.test(normalized)
    && (/\b(position|long|short|trade)\b/.test(normalized) || hasExplicitMarket)
    && !/\b(menu|dialog|panel|window)\b/.test(normalized);
  const isDeposit = /\bdeposit\b/.test(normalized) && !/\b(history|records?|activity|status)\b/.test(normalized);
  const isWithdrawal = /\b(withdraw|withdrawal)\b/.test(normalized) && !/\b(history|records?|activity|status)\b/.test(normalized);
  const hasLong = /\b(long|buy)\b/.test(normalized);
  const hasShort = /\b(short|sell)\b/.test(normalized);
  const sideAmbiguous = hasLong && hasShort;
  const side = sideAmbiguous ? null : hasShort ? 'short' : hasLong ? 'long' : null;
  const hasOpenAction = /\b(open|enter|place|buy|sell)\b/.test(normalized);
  const orderTypeSignals = [
    /\bmarket(?:\s+order)?\b/.test(normalized) && 'market',
    /\blimit(?:\s+order)?\b/.test(normalized) && 'limit',
    /\b(?:stop order|stop entry|entry stop|trigger(?: price)?)\b/.test(normalized) && 'stop',
  ].filter(Boolean);
  const orderTypeAmbiguous = orderTypeSignals.length > 1;
  const orderType = /\b(?:stop order|stop entry|entry stop|trigger(?: price)?)\b/.test(normalized)
    ? 'stop'
    : /\blimit(?: order)?\b/.test(normalized)
      ? 'limit'
      : 'market';
  const limitPriceValues = orderType === 'limit' ? extractPrices(text, 'limit') : [];
  const triggerPriceValues = orderType === 'stop' ? extractTriggerPrices(text) : [];
  const limitPrice = limitPriceValues.length === 1 ? limitPriceValues[0] : null;
  const triggerPrice = triggerPriceValues.length === 1 ? triggerPriceValues[0] : null;
  const closePercentValues = extractClosePercentages(normalized);
  const hasFullClose = /\b(?:all|full|entire|whole)\b/.test(normalized);
  const closePercentageAmbiguous = closePercentValues.length > 1 || (hasFullClose && closePercentValues.length > 0);
  const isOpen = (hasLong || hasShort)
    && (hasOpenAction || (!isCancel && !isClose));
  const financialActions = [
    isOpen && 'open',
    isClose && 'close',
    isCancel && 'cancel',
    isDeposit && 'deposit',
    isWithdrawal && 'withdrawal',
  ].filter((value): value is string => Boolean(value));
  const actionFamilyAmbiguous = financialActions.length > 1;
  const isAccountQuery = /\b(balance|portfolio|positions?|orders?|history|funding|account|profile|wallet)\b/.test(normalized);
  const isNavigation = /\b(go to|navigate|take me|open the|show me the)\b/.test(normalized);
  const isMarketQuery = !isNavigation
    && /\b(compare|chart|price|quote|market|funding|depth|trades?|leverage|source|session)\b/.test(normalized);

  const instructionConflicts = [
    actionFamilyAmbiguous && `one financial action (${financialActions.join(' or ')})`,
    (isOpen || isClose) && sideAmbiguous && 'one direction (long or short)',
    (isOpen || isClose) && leverageAmbiguous && 'one leverage value',
    (isOpen || isClose) && marginModeAmbiguous && 'one margin mode (isolated or cross)',
    isOpen && orderTypeAmbiguous && 'one order type',
    isClose && closePercentageAmbiguous && 'one close percentage',
    (isOpen || isClose) && slippageAmbiguous && 'one slippage value',
    (isOpen || isClose) && slippageUnparsed && 'one valid slippage percentage',
    isOpen && limitPriceValues.length > 1 && 'one limit price',
    isOpen && triggerPriceValues.length > 1 && 'one trigger price',
    isOpen && takeProfitValues.length > 1 && 'one take-profit price',
    isOpen && stopLossValues.length > 1 && 'one stop-loss price',
  ].filter(Boolean) as string[];

  if (financialActions.length && instructionConflicts.length) {
    const intentType: AgentIntentType = isWithdrawal
      ? 'withdrawal_preview'
      : isDeposit
        ? 'deposit_preview'
        : isCancel
          ? 'cancel_order_preview'
          : isClose && !isOpen
            ? 'close_position_preview'
            : 'perp_order_preview';
    return {
      assistantMessage: `The request contains conflicting or unreadable financial parameters. Supply ${instructionConflicts.join(', ')}. No preview will choose or invent a value.`,
      expiresAtMs: null,
      intentType,
      marketId: financialMarket?.id ?? null,
      payload: { kind: intentType, marketId: financialMarket?.id ?? null, conflicts: instructionConflicts },
      risk: {
        checks: ['Contradictory financial instructions are fail-closed.'],
        level: 'high',
        warnings: ['No order, position, deposit, or withdrawal action was prepared, signed, or submitted.'],
      },
      status: 'needs_input',
      summary: 'Conflicting financial parameters · clarification required',
      title: 'Intent clarification',
    };
  }

  if (isCancel) {
    const orderIds = extractOrderIds(text);
    const orderId = orderIds.length === 1 ? orderIds[0] : null;
    const missing = orderIds.length > 1 ? ['exactly one order identifier'] : orderId ? [] : ['order identifier'];
    const status = missing.length ? 'needs_input' : 'proposed';
    return {
      assistantMessage: missing.length
        ? orderIds.length > 1
          ? 'I found multiple cancellation targets. Supply exactly one order or ticket identifier; no target will be selected automatically.'
          : 'I recognized a cancel-order request. Add the exact order identifier so the preview can be scoped without guessing.'
        : `Cancel preview recorded for order ${orderId}. Review the ledger before acknowledging it. ${executionBoundary.message}`,
      expiresAtMs: status === 'proposed' ? nowMs + 10 * 60 * 1000 : null,
      intentType: 'cancel_order_preview',
      marketId: financialMarket?.id ?? null,
      payload: { kind: 'cancel_order_preview', orderId, candidateOrderIds: orderIds, marketId: financialMarket?.id ?? null },
      risk: {
        checks: ['Exact order ownership must be verified by the future venue adapter.'],
        level: 'high',
        warnings: ['No order was cancelled.', 'Open orders may fill before a cancellation settles.'],
      },
      status,
      summary: orderId ? `Cancel order ${orderId}` : 'Cancel order · identifier required',
      title: 'Cancel order preview',
    };
  }

  if (isClose) {
    const percentage = closePercentValues.length === 1
      ? closePercentValues[0]
      : hasFullClose
        ? 100
        : null;
    const invalidPercentage = percentage !== null && (percentage < 1 || percentage > 100);
    const defaultsApplied = [!hasSlippageSignal && '0.5% slippage tolerance'].filter(Boolean) as string[];
    const missing = [
      !financialMarket && (matchedMarkets.length > 1 ? 'exactly one market' : 'market'),
      percentage === null && 'close percentage or the word “full”',
    ].filter(Boolean) as string[];
    const status: AgentIntentStatus = invalidPercentage || invalidSlippage ? 'blocked' : missing.length ? 'needs_input' : 'proposed';
    const closeLabel = percentage === null ? 'an unspecified share' : `${percentage}%`;
    return {
      assistantMessage: invalidPercentage
        ? 'The close percentage must be between 1% and 100%. The intent is blocked until a valid size is supplied.'
        : invalidSlippage
          ? 'Slippage must be greater than 0% and no more than 5% for a reviewable preview. The intent is blocked.'
          : missing.length
            ? `I recognized a close-position request, but I still need: ${missing.join(', ')}. This preview will not infer a target or size.`
            : `Close preview recorded for ${percentage}% of the ${formatPair(financialMarket as Market)} position. The Aventa ecosystem fee is ${aventaTradeFeePolicy.percent.toFixed(2)}% of the actual closing fill notional.${defaultsApplied.length ? ` Policy defaults applied: ${defaultsApplied.join(', ')}.` : ''} Position ownership and size remain venue-required. ${executionBoundary.message}`,
      expiresAtMs: status === 'proposed' ? nowMs + 10 * 60 * 1000 : null,
      intentType: 'close_position_preview',
      marketId: financialMarket?.id ?? null,
      payload: {
        kind: 'close_position_preview',
        marketId: financialMarket?.id ?? null,
        closePercent: percentage === null ? null : String(percentage),
        reduceOnly: true,
        slippagePercent: slippage,
        defaultsApplied,
      },
      risk: {
        checks: ['A live owned position and executable venue are required.'],
        level: 'high',
        warnings: [
          'No position was closed.',
          `Aventa charges ${aventaTradeFeePolicy.percent.toFixed(2)}% of actual filled notional on this reduce/close fill; venue fees are separate.`,
          'Final size, fee amount, liquidation impact, and fill price require a signed venue request.',
          ...(defaultsApplied.length ? [`Preview defaults require review: ${defaultsApplied.join(', ')}.`] : []),
        ],
      },
      status,
      summary: financialMarket ? `Close ${closeLabel} · ${formatPair(financialMarket)}` : 'Close position · exact market required',
      title: 'Close position preview',
    };
  }

  if (isDeposit || isWithdrawal) {
    const intentType = isDeposit ? 'deposit_preview' : 'withdrawal_preview';
    const verb = isDeposit ? 'Deposit' : 'Withdrawal';
    const missing = [amountAmbiguous && 'one unambiguous amount', !amount && !amountAmbiguous && 'amount', !asset && !amountAmbiguous && 'asset'].filter(Boolean);
    const status = missing.length ? 'needs_input' : 'proposed';
    return {
      assistantMessage: missing.length
        ? `I recognized a ${verb.toLowerCase()} request. Add an exact amount and asset. Nothing will be moved from this chat.`
        : `${verb} preview recorded for ${amount} ${asset}. Review the account and destination in the wallet flow before any future signature. ${executionBoundary.message}`,
      expiresAtMs: status === 'proposed' ? nowMs + 10 * 60 * 1000 : null,
      intentType,
      marketId: null,
      payload: { kind: intentType, amount, asset, chainId: 4663 },
      risk: {
        checks: ['Verified wallet ownership, asset contract, vault, recipient, and simulation are required.'],
        level: 'high',
        warnings: [`No ${isDeposit ? 'deposit' : 'withdrawal'} was prepared or submitted.`, 'Never share a seed phrase or private key with an agent.'],
      },
      status,
      summary: amount && asset ? `${verb} ${amount} ${asset}` : `${verb} · details required`,
      title: `${verb} preview`,
    };
  }

  if (isOpen) {
    const hasExplicitOrderType = orderTypeSignals.length === 1;
    const defaultsApplied = [
      !hasExplicitOrderType && 'market order',
      !hasExplicitMarginMode && 'cross margin',
      !hasSlippageSignal && '0.5% slippage tolerance',
    ].filter(Boolean) as string[];
    const maxLeverage = financialMarket ? maxLeverageForMarket(financialMarket) : null;
    const missing = [
      !financialMarket && (matchedMarkets.length > 1 ? 'exactly one market' : 'market'),
      amountAmbiguous && 'one unambiguous collateral amount',
      !amount && !amountAmbiguous && 'collateral amount',
      !asset && !amountAmbiguous && 'collateral asset',
      !leverage && 'leverage',
      orderType === 'limit' && !limitPrice && 'limit price',
      orderType === 'stop' && !triggerPrice && 'trigger price',
    ].filter(Boolean) as string[];
    const invalidLeverage = leverage !== null && (leverage <= 0 || Boolean(maxLeverage && leverage > maxLeverage));
    const invalidAmount = Boolean(amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 1_000_000_000));
    const priceValues = [limitPrice, triggerPrice, takeProfit, stopLoss].filter((value): value is string => value !== null);
    const invalidPrice = priceValues.some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0);
    const status: AgentIntentStatus = invalidLeverage || invalidAmount || invalidSlippage || invalidPrice
      ? 'blocked'
      : missing.length
        ? 'needs_input'
        : 'proposed';
    const notional = formatNotional(amount, leverage);
    const feeEstimate = amount && leverage
      ? estimateAventaTradeFee(Number(amount) * leverage)
      : undefined;
    const summary = financialMarket
      ? `${side === 'long' ? 'Long' : 'Short'} ${formatPair(financialMarket)}${amount && asset ? ` · ${amount} ${asset}` : ''}${leverage ? ` · ${leverage}×` : ''}`
      : `${side === 'long' ? 'Long' : 'Short'} order preview · market required`;
    let assistantMessage: string;
    if (invalidLeverage) {
      assistantMessage = leverage !== null && leverage <= 0
        ? 'Leverage must be greater than 0×. The intent is blocked until a valid value is supplied.'
        : `${leverage}× exceeds the ${maxLeverage}× reference cap for ${formatPair(financialMarket as Market)}. The intent is blocked; choose a lower leverage.`;
    } else if (invalidAmount) {
      assistantMessage = 'The collateral amount is outside the supported preview range. Use a positive amount no greater than 1,000,000,000.';
    } else if (invalidSlippage) {
      assistantMessage = 'Slippage must be greater than 0% and no more than 5% for a reviewable preview. The intent is blocked.';
    } else if (invalidPrice) {
      assistantMessage = 'Every supplied order, trigger, take-profit, and stop-loss price must be greater than zero. The intent is blocked.';
    } else if (missing.length) {
      assistantMessage = `I recognized a ${side} order preview, but I still need: ${missing.join(', ')}. I will not guess financial parameters.`;
    } else {
      assistantMessage = `Intent drafted: ${summary}${notional ? `, approximately ${notional} ${asset} notional` : ''}${feeEstimate === undefined ? '' : `, with an estimated ${feeEstimate.toLocaleString('en-US', { maximumFractionDigits: 6 })} USDG Aventa ecosystem fee (${aventaTradeFeePolicy.percent.toFixed(2)}% of filled notional)`}, ${marginMode} margin, ${orderType} order.${defaultsApplied.length ? ` Policy defaults applied: ${defaultsApplied.join(', ')}.` : ''} Review every field before acknowledging it. ${executionBoundary.message}`;
    }
    return {
      assistantMessage,
      expiresAtMs: status === 'proposed' ? nowMs + 10 * 60 * 1000 : null,
      intentType: 'perp_order_preview',
      marketId: financialMarket?.id ?? null,
      payload: {
        kind: 'perp_order_preview',
        marketId: financialMarket?.id ?? null,
        side,
        orderType,
        sizeMode: 'collateral',
        size: amount,
        asset,
        leverage,
        marginMode,
        reduceOnly,
        limitPrice,
        triggerPrice,
        takeProfit,
        stopLoss,
        slippagePercent: slippage,
        defaultsApplied,
      },
      risk: {
        checks: [
          financialMarket ? `${formatPair(financialMarket)} is in the Aventa reference catalog.` : 'Exactly one catalog market is required.',
          maxLeverage ? `Reference leverage cap: ${maxLeverage}×.` : 'Leverage cap requires current venue metadata.',
          'Future execution requires a fresh oracle, risk engine, simulation, and explicit wallet signature.',
        ],
        level: 'high',
        warnings: [
          'No order was prepared, signed, or submitted.',
          'Reference leverage caps are not a guarantee of venue availability.',
          `The Aventa ecosystem fee is ${aventaTradeFeePolicy.percent.toFixed(2)}% of actual filled notional on every open/increase and reduce/close fill. Venue fees are separate.`,
          'Liquidation price, final fee amount, margin brackets, and fills are confirmed by the venue after authorization.',
          ...(defaultsApplied.length ? [`Preview defaults require review: ${defaultsApplied.join(', ')}.`] : []),
        ],
      },
      status,
      summary,
      title: `${side === 'long' ? 'Long' : 'Short'} order preview`,
    };
  }

  if (isAccountQuery) {
    return {
      assistantMessage: `Your account data stays behind your Privy session. Open Wallet to inspect verified balances, transfer actions, and history. Public venue positions appear after a wallet connects; private orders and fills require your venue trading key.`,
      expiresAtMs: null,
      intentType: 'account_query',
      marketId: market?.id ?? null,
      payload: { kind: 'account_query', target: '/trade?account=1' },
      risk: { checks: ['Account reads remain scoped to the authenticated Aventa profile.'], level: 'information', warnings: ['No fabricated balance, position, or PnL is displayed.'] },
      status: 'completed',
      summary: 'Open account context',
      title: 'Account context',
    };
  }

  if (!isNavigation && (isMarketQuery || hasExplicitMarket)) {
    if (!matchedMarkets.length) {
      return {
        assistantMessage: 'Name one or two markets from the Aventa catalog so I can compare only verifiable metadata and route you to the correct live reference surface.',
        expiresAtMs: null,
        intentType: 'market_query',
        marketId: null,
        payload: { kind: 'market_query', marketIds: [] },
        risk: { checks: ['Market selection required.'], level: 'information', warnings: ['No price was inferred.'] },
        status: 'needs_input',
        summary: 'Market query · selection required',
        title: 'Market reference',
      };
    }
    const selected = matchedMarkets.slice(0, 2);
    return {
      assistantMessage: `Verified catalog context:\n${selected.map(marketLine).join('\n')}\nOpen the terminal for live reference data. I cannot inspect TradingView candles or infer an executable price from this chat.`,
      expiresAtMs: null,
      intentType: 'market_query',
      marketId: selected[0].id,
      payload: { kind: 'market_query', marketIds: selected.map((item) => item.id), target: `/trade?market=${selected[0].id}` },
      risk: { checks: selected.map((item) => `${formatPair(item)} source: ${item.source}.`), level: 'information', warnings: ['Catalog metadata is not an executable quote.'] },
      status: 'completed',
      summary: selected.map(formatPair).join(' vs '),
      title: selected.length > 1 ? 'Market comparison' : 'Market reference',
    };
  }

  if (isNavigation) {
    const target = navigationTarget(text);
    return {
      assistantMessage: `I mapped that request to ${target}. Use the verified route below; no account or market state was changed.`,
      expiresAtMs: null,
      intentType: 'navigation',
      marketId: null,
      payload: { kind: 'navigation', target },
      risk: { checks: ['Target is restricted to an internal Aventa route.'], level: 'information', warnings: [] },
      status: 'completed',
      summary: `Navigate to ${target}`,
      title: 'Navigation',
    };
  }

  return {
    assistantMessage: 'I can verify market metadata, explain risk, review account readiness, and record structured previews for long, short, close, cancel, deposit, or withdrawal requests. Include exact parameters; I will never guess them.',
    expiresAtMs: null,
    intentType: null,
    marketId: market?.id ?? null,
    payload: {},
    risk: { checks: [], level: 'information', warnings: [executionBoundary.message] },
    status: null,
    summary: 'Unclassified request',
    title: 'Signal session',
  };
}
