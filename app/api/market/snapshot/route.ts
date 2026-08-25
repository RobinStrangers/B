import { markets } from '@/app/markets';

const yahooSymbols: Record<string, string> = {
  'eur-usd': 'EURUSD=X',
  'gbp-usd': 'GBPUSD=X',
  'usd-jpy': 'JPY=X',
  'aud-usd': 'AUDUSD=X',
  'usd-cad': 'CAD=X',
  'usd-chf': 'CHF=X',
  'xau-usd': 'GC=F',
  'xag-usd': 'SI=F',
  copper: 'HG=F',
  platinum: 'PL=F',
  'wti-usd': 'CL=F',
  'brent-usd': 'BZ=F',
  'natural-gas': 'NG=F',
  corn: 'ZC=F',
  wheat: 'ZW=F',
  aapl: 'AAPL',
  msft: 'MSFT',
  nvda: 'NVDA',
  amzn: 'AMZN',
  googl: 'GOOGL',
  meta: 'META',
  tsla: 'TSLA',
  amd: 'AMD',
  nflx: 'NFLX',
  coin: 'COIN',
};

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validSeries(values: unknown) {
  return Array.isArray(values)
    ? values.map(numberValue).filter((value): value is number => value !== undefined)
    : [];
}

function parseRobinhoodQuote(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined;
  const root = payload as Record<string, unknown>;
  const candidate = root.quotes ?? root.data ?? root.result ?? root;
  const row = Array.isArray(candidate) ? candidate[0] : candidate;
  if (!row || typeof row !== 'object') return undefined;
  const quote = row as Record<string, unknown>;
  const bid = numberValue(quote.bid ?? quote.bidPrice);
  const ask = numberValue(quote.ask ?? quote.askPrice);
  const generatedAt = quote.generatedAt ? Date.parse(String(quote.generatedAt)) : undefined;
  return {
    bid,
    ask,
    price: bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask,
    volume: numberValue(quote.dailyTradingVolume ?? quote.volume),
    halted: Boolean(quote.isTradingHalt ?? quote.halt ?? quote.halted),
    generatedAt: generatedAt && Number.isFinite(generatedAt) ? generatedAt : undefined,
  };
}

export async function GET(request: Request) {
  const marketId = new URL(request.url).searchParams.get('market')?.trim() ?? '';
  const market = markets.find((item) => item.id === marketId);
  const yahooSymbol = yahooSymbols[marketId];
  if (!market || market.category === 'crypto' || !yahooSymbol) {
    return Response.json({ error: { code: 'MARKET_NOT_SUPPORTED', message: 'This market uses a dedicated realtime stream.' } }, { status: 400 });
  }

  try {
    const [chartResult, robinhoodResult] = await Promise.allSettled([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=5m`, {
        headers: { 'User-Agent': 'Aventa/1.0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error('Session data request failed.');
        return response.json() as Promise<unknown>;
      }),
      market.robinhoodSymbol
        ? fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(market.robinhoodSymbol)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        }).then(async (response) => {
          if (!response.ok) throw new Error('Stock Token quote request failed.');
          return response.json() as Promise<unknown>;
        })
        : Promise.resolve(undefined),
    ]);

    const chartPayload = chartResult.status === 'fulfilled' ? chartResult.value as Record<string, unknown> : undefined;
    const chart = (chartPayload?.chart as { result?: unknown[] } | undefined)?.result?.[0] as {
      meta?: Record<string, unknown>;
      timestamp?: unknown[];
      indicators?: { quote?: Array<Record<string, unknown>> };
    } | undefined;
    const meta = chart?.meta ?? {};
    const quoteSeries = chart?.indicators?.quote?.[0] ?? {};
    const highs = validSeries(quoteSeries.high);
    const lows = validSeries(quoteSeries.low);
    const closes = validSeries(quoteSeries.close);
    const volumes = validSeries(quoteSeries.volume);
    const sessionPrice = numberValue(meta.regularMarketPrice) ?? closes.at(-1);
    const previousClose = numberValue(meta.chartPreviousClose ?? meta.previousClose);
    const stockQuote = robinhoodResult.status === 'fulfilled' ? parseRobinhoodQuote(robinhoodResult.value) : undefined;
    const price = stockQuote?.price ?? sessionPrice;
    if (price === undefined) throw new Error('No verified price was returned.');
    const change = previousClose && previousClose !== 0 ? ((price - previousClose) / previousClose) * 100 : undefined;
    const lastTimestamp = Array.isArray(chart?.timestamp) ? numberValue(chart.timestamp.at(-1)) : undefined;
    const updatedAt = stockQuote?.generatedAt ?? (lastTimestamp ? lastTimestamp * 1000 : Date.now());
    const marketOpen = Date.now() - updatedAt < 10 * 60 * 1000;

    return Response.json({
      marketId,
      price,
      change,
      high: highs.length ? Math.max(...highs) : price,
      low: lows.length ? Math.min(...lows) : price,
      volume: stockQuote?.volume ?? volumes.reduce((sum, value) => sum + value, 0),
      bid: stockQuote?.bid,
      ask: stockQuote?.ask,
      halted: stockQuote?.halted ?? false,
      updatedAt,
      marketOpen,
      source: market.category === 'shares' ? 'Stock Token quote + session statistics' : 'Consolidated session statistics',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' },
    });
  } catch {
    return Response.json({ error: { code: 'MARKET_FEED_RETRYING', message: 'The market feed is reconnecting.' } }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
