'use client';

import { usePrivy } from '@privy-io/react-auth';
import Link from '../components/InternalLink';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  categoryLabels,
  cryptoMarkets,
  formatPair,
  markets,
  type Market,
  type MarketCategory,
} from '../markets';
import { AssetLogo } from '../components/AssetLogo';
import AccountDrawer from '../components/AccountDrawer';
import AuthSheet from '../components/AuthSheet';
import { useRobinhoodAccount } from '../components/useRobinhoodAccount';
import { maxLeverageForMarket } from '../lib/market-risk';
import { aventaTradeFeePolicy, estimateAventaTradeFee } from '../lib/trade-fee';
import { useAventaExecution } from '../components/useAventaExecution';
import { EXECUTION_CONSENT_VERSION } from '../lib/execution-authorization';

type FeedStatus = 'connecting' | 'live' | 'stale' | 'offline';
type ChartTab = 'chart' | 'trades';
type AccountTab = 'positions' | 'orders' | 'order-history' | 'trade-history';
type OrderType = 'market' | 'limit';
type Side = 'long' | 'short';
type MarginMode = 'cross' | 'isolated';

type Ticker = {
  price: number;
  change: number;
  high: number;
  low: number;
  volume: number;
  updatedAt: number;
};

type ReferenceTrade = {
  id: string;
  price: number;
  size: number;
  time: number;
  makerSell: boolean;
};

type CryptoDetail = {
  status: FeedStatus;
  ticker?: Ticker;
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFunding?: number;
  trades: ReferenceTrade[];
  updatedAt?: number;
};

type MarketSnapshot = {
  marketId: string;
  price: number;
  change?: number;
  high: number;
  low: number;
  volume: number;
  bid?: number;
  ask?: number;
  halted: boolean;
  updatedAt: number;
  marketOpen: boolean;
  source: string;
};

type VenuePosition = {
  marketId?: number;
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPrice: string;
  marginMode: 'cross' | 'isolated';
  allocatedMargin: string;
  openOrderCount: number;
};

type VenueSnapshot = {
  venue: { name: string; network: string; online: boolean; marketListed: boolean; marketId?: number; updatedAt: number };
  account: null | {
    index?: number;
    availableBalance: string;
    collateral: string;
    portfolioValue: string;
    pendingOrderCount: number;
    crossInitialMarginRequirement: string;
    crossMaintenanceMarginRequirement: string;
  };
  positions: VenuePosition[];
  openOrders: unknown[];
  orderHistory: unknown[];
  tradeHistory: unknown[];
  privateActivityRequiresTradingKey: boolean;
};

const chartTabs: { id: ChartTab; label: string }[] = [
  { id: 'chart', label: 'Live chart' },
  { id: 'trades', label: 'Recent trades' },
];

const accountTabs: { id: AccountTab; label: string }[] = [
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Open orders' },
  { id: 'order-history', label: 'Order history' },
  { id: 'trade-history', label: 'Trade history' },
];

function asNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatPrice(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const decimals = value >= 1000 ? 2 : value >= 1 ? 3 : 5;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: value >= 1000 ? 2 : 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatPercent(value?: number, digits = 2) {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function formatCompact(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return 'Loading…';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function formatClock(value?: number) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(value);
}

function parseMarketSnapshot(payload: unknown): MarketSnapshot | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const row = payload as Record<string, unknown>;
  const price = asNumber(row.price);
  const high = asNumber(row.high);
  const low = asNumber(row.low);
  const volume = asNumber(row.volume);
  const updatedAt = asNumber(row.updatedAt);
  if (typeof row.marketId !== 'string' || price === undefined || high === undefined || low === undefined || volume === undefined || updatedAt === undefined || typeof row.marketOpen !== 'boolean' || typeof row.source !== 'string') return undefined;
  return {
    marketId: row.marketId,
    price,
    change: asNumber(row.change),
    high,
    low,
    volume,
    bid: asNumber(row.bid),
    ask: asNumber(row.ask),
    halted: Boolean(row.halted),
    updatedAt,
    marketOpen: row.marketOpen,
    source: row.source,
  };
}

function parseVenueSnapshot(payload: unknown): VenueSnapshot | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const row = payload as VenueSnapshot;
  if (!row.venue || typeof row.venue.name !== 'string' || typeof row.venue.online !== 'boolean' || !Array.isArray(row.positions)) return undefined;
  return row;
}

function useCryptoTickerTape() {
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const [status, setStatus] = useState<FeedStatus>('connecting');

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let retry = 0;
    let lastMessage = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const symbols = cryptoMarkets.map((market) => market.derivativesSymbol).filter(Boolean) as string[];

    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      socket = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      socket.onopen = () => {
        retry = 0;
        socket?.send(JSON.stringify({ op: 'subscribe', args: symbols.map((symbol) => `tickers.${symbol}`) }));
        heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op: 'ping' })), 20_000);
      };
      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(String(event.data)) as { topic?: string; data?: Record<string, unknown> };
          if (!envelope.topic?.startsWith('tickers.') || !envelope.data) return;
          const data = envelope.data;
          const symbol = typeof data.symbol === 'string' ? data.symbol : envelope.topic.slice('tickers.'.length);
          if (!symbol) return;
          lastMessage = Date.now();
          setStatus('live');
          setTickers((current) => {
            const existing = current[symbol];
            const price = asNumber(data.markPrice ?? data.lastPrice) ?? existing?.price;
            if (price === undefined) return current;
            return {
              ...current,
              [symbol]: {
                price,
                change: (asNumber(data.price24hPcnt) ?? (existing ? existing.change / 100 : 0)) * 100,
                high: asNumber(data.highPrice24h) ?? existing?.high ?? price,
                low: asNumber(data.lowPrice24h) ?? existing?.low ?? price,
                volume: asNumber(data.turnover24h ?? data.volume24h) ?? existing?.volume ?? 0,
                updatedAt: lastMessage,
              },
            };
          });
        } catch {
          // Ignore malformed upstream messages and keep the last verified value.
        }
      };
      socket.onerror = () => setStatus('offline');
      socket.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (stopped) return;
        setStatus('offline');
        const delay = Math.min(12_000, 1_000 * 2 ** retry) + Math.floor(Math.random() * 350);
        retry += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    const staleTimer = setInterval(() => {
      if (lastMessage && Date.now() - lastMessage > 15_000) setStatus('stale');
    }, 3_000);

    return () => {
      stopped = true;
      clearInterval(staleTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeat) clearInterval(heartbeat);
      socket?.close();
    };
  }, []);

  return { tickers, status };
}

function useCryptoDetail(symbol?: string): CryptoDetail {
  const [detail, setDetail] = useState<CryptoDetail>({
    status: symbol ? 'connecting' : 'offline',
    trades: [],
  });

  useEffect(() => {
    if (!symbol) return;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let retry = 0;
    let lastMessage = 0;

    const connect = () => {
      if (stopped) return;
      setDetail((current) => ({ ...current, status: 'connecting' }));
      socket = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      socket.onopen = () => {
        retry = 0;
        socket?.send(JSON.stringify({ op: 'subscribe', args: [`tickers.${symbol}`, `publicTrade.${symbol}`] }));
        heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op: 'ping' })), 20_000);
      };
      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(String(event.data)) as { topic?: string; ts?: number; data?: Record<string, unknown> | Record<string, unknown>[] };
          if (!envelope.topic || !envelope.data) return;
          const receivedAt = envelope.ts ?? Date.now();
          lastMessage = Date.now();
          if (envelope.topic.startsWith('tickers.') && !Array.isArray(envelope.data)) {
            const data = envelope.data;
            setDetail((current) => {
              const price = asNumber(data.markPrice ?? data.lastPrice) ?? current.markPrice ?? current.ticker?.price;
              const next = { ...current, status: 'live' as const, updatedAt: receivedAt };
              if (price !== undefined) {
                next.markPrice = asNumber(data.markPrice) ?? current.markPrice ?? price;
                next.indexPrice = asNumber(data.indexPrice) ?? current.indexPrice;
                next.fundingRate = asNumber(data.fundingRate) ?? current.fundingRate;
                next.nextFunding = asNumber(data.nextFundingTime) ?? current.nextFunding;
                next.ticker = {
                  price,
                  change: (asNumber(data.price24hPcnt) ?? (current.ticker ? current.ticker.change / 100 : 0)) * 100,
                  high: asNumber(data.highPrice24h) ?? current.ticker?.high ?? price,
                  low: asNumber(data.lowPrice24h) ?? current.ticker?.low ?? price,
                  volume: asNumber(data.turnover24h ?? data.volume24h) ?? current.ticker?.volume ?? 0,
                  updatedAt: receivedAt,
                };
              }
              return next;
            });
          } else if (envelope.topic.startsWith('publicTrade.') && Array.isArray(envelope.data)) {
            const incoming = envelope.data.map((row): ReferenceTrade | undefined => {
              const price = asNumber(row.p);
              const size = asNumber(row.v);
              if (price === undefined || size === undefined) return undefined;
              return {
                id: String(row.i ?? `${row.T ?? receivedAt}-${price}-${size}`),
                price,
                size,
                time: asNumber(row.T) ?? receivedAt,
                makerSell: row.S === 'Sell',
              };
            }).filter((row): row is ReferenceTrade => Boolean(row));
            if (incoming.length) setDetail((current) => ({ ...current, status: 'live', updatedAt: receivedAt, trades: [...incoming.reverse(), ...current.trades].slice(0, 24) }));
          }
        } catch {
          // Preserve the last verified snapshot when a public message is malformed.
        }
      };
      socket.onerror = () => setDetail((current) => ({ ...current, status: 'offline' }));
      socket.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (stopped) return;
        setDetail((current) => ({ ...current, status: 'offline' }));
        const delay = Math.min(12_000, 1_000 * 2 ** retry) + Math.floor(Math.random() * 350);
        retry += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    const resetTimer = setTimeout(() => {
      if (!stopped) setDetail({ status: 'connecting', trades: [] });
    }, 0);
    connect();
    const staleTimer = setInterval(() => {
      if (lastMessage && Date.now() - lastMessage > 15_000) {
        setDetail((current) => ({ ...current, status: 'stale' }));
      }
    }, 3_000);

    return () => {
      stopped = true;
      clearTimeout(resetTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeat) clearInterval(heartbeat);
      clearInterval(staleTimer);
      socket?.close();
    };
  }, [symbol]);

  return symbol ? detail : { status: 'offline', trades: [] };
}

function useMarketSnapshot(market?: Market) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot>();
  const [status, setStatus] = useState<FeedStatus>(market && market.category !== 'crypto' ? 'connecting' : 'offline');

  useEffect(() => {
    if (!market || market.category === 'crypto') return;
    let stopped = false;
    let controller: AbortController | undefined;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/market/snapshot?market=${encodeURIComponent(market.id)}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Quote feed retrying');
        const parsed = parseMarketSnapshot(await response.json());
        if (!parsed) throw new Error('Quote response malformed');
        if (stopped) return;
        setSnapshot(parsed);
        setStatus(parsed.marketOpen ? 'live' : 'stale');
      } catch (error) {
        if (!stopped && (error as Error).name !== 'AbortError') setStatus('offline');
      }
    };

    const resetTimer = setTimeout(() => {
      if (!stopped) {
        setSnapshot(undefined);
        setStatus('connecting');
      }
    }, 0);
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      stopped = true;
      clearTimeout(resetTimer);
      clearInterval(timer);
      controller?.abort();
    };
  }, [market]);

  return market && market.category !== 'crypto' ? { snapshot, status } : { snapshot: undefined, status: 'offline' as FeedStatus };
}

function useVenueAccount(address: string, market: Market) {
  const [snapshot, setSnapshot] = useState<VenueSnapshot>();
  const [status, setStatus] = useState<FeedStatus>('connecting');

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      try {
        const params = new URLSearchParams({ symbol: market.base });
        if (address) params.set('address', address);
        const response = await fetch(`/api/venue/account?${params}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Venue feed retrying');
        const parsed = parseVenueSnapshot(await response.json());
        if (!parsed) throw new Error('Venue response malformed');
        if (!stopped) {
          setSnapshot(parsed);
          setStatus('live');
        }
      } catch (error) {
        if (!stopped && (error as Error).name !== 'AbortError') setStatus('offline');
      }
    };
    void load();
    const handleVisibility = () => { if (document.visibilityState === 'visible') void load(); };
    const handleVenueAccountReady = () => { void load(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('aventa:venue-account-ready', handleVenueAccountReady);
    window.addEventListener('aventa:deposit-confirmed', handleVenueAccountReady);
    const timer = window.setInterval(load, 12_000);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('aventa:venue-account-ready', handleVenueAccountReady);
      window.removeEventListener('aventa:deposit-confirmed', handleVenueAccountReady);
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [address, market.base]);

  return { snapshot, status };
}

function TradingViewChart({ market }: { market: Market }) {
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = chartRef.current;
    if (!node) return;
    node.replaceChildren();
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.textContent = JSON.stringify({
      autosize: true,
      symbol: market.tvSymbol,
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      backgroundColor: '#2B3740',
      gridColor: 'rgba(104, 115, 122, 0.24)',
      style: '1',
      locale: 'en',
      hide_side_toolbar: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      withdateranges: true,
      support_host: 'https://www.tradingview.com',
    });
    node.appendChild(widget);
    node.appendChild(script);
  }, [market.tvSymbol]);

  return <div className="tradingview-widget-container" ref={chartRef} />;
}

function DataBadge({ status, market, stockHalted }: { status: FeedStatus; market: Market; stockHalted?: boolean }) {
  let label = status === 'connecting' ? 'CONNECTING' : status === 'stale' ? 'SESSION CLOSED' : status === 'offline' ? 'RECONNECTING' : 'REAL-TIME';
  if (market.category === 'shares') label = stockHalted ? 'HALTED' : status === 'live' ? 'LIVE QUOTE' : label;
  return <span className={`data-badge status-${status}`}><i />{label}</span>;
}

function TradesTable({ detail, market }: { detail: CryptoDetail; market: Market }) {
  if (!market.derivativesSymbol || !detail.trades.length) {
    return <div className="feature-empty"><span className="empty-orbit">⌁</span><strong>{market.derivativesSymbol ? 'Waiting for realtime trades' : 'Trades are shown inside the live chart'}</strong><p>{market.derivativesSymbol ? 'Public derivatives trades will stream here automatically.' : 'Open the chart timeline to inspect this market session.'}</p></div>;
  }
  return (
    <div className="trades-view">
      <div className="table-head"><span>Price (USDT)</span><span>Size ({market.base})</span><span>Time (UTC)</span></div>
      {detail.trades.map((trade) => <div className="trade-row" key={trade.id}><span className={trade.makerSell ? 'negative' : 'positive'}>{formatPrice(trade.price)}</span><span>{formatPrice(trade.size)}</span><span>{formatClock(trade.time)}</span></div>)}
      <p className="source-line">Realtime public derivatives trades — separate from your account fills.</p>
    </div>
  );
}

function activityText(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return '—';
}

function ActivityTable({
  rows,
  cancellable,
  onCancel,
  busy,
}: {
  rows: Array<Record<string, unknown>>;
  cancellable: boolean;
  onCancel: (orderId: string, marketSymbol: string) => void;
  busy: boolean;
}) {
  return (
    <div className="execution-activity-table">
      <div className="execution-activity-head"><span>Market</span><span>Side / type</span><span>Size</span><span>Price</span><span>Status</span><span>Action</span></div>
      {rows.map((row, index) => {
        const orderId = activityText(row, 'orderId', 'order_id', 'clientOrderIndex', 'id');
        const marketSymbol = activityText(row, 'marketSymbol', 'symbol', 'market');
        return <div className="execution-activity-row" key={`${orderId}-${index}`}><span><strong>{marketSymbol}</strong><small>#{orderId}</small></span><span><strong>{activityText(row, 'side')}</strong><small>{activityText(row, 'orderType', 'type')}</small></span><span>{activityText(row, 'size', 'baseAmount', 'filledSize')}</span><span>{activityText(row, 'price', 'averagePrice')}</span><span>{activityText(row, 'status')}</span><span>{cancellable && orderId !== '—' && marketSymbol !== '—' ? <button type="button" disabled={busy} onClick={() => onCancel(orderId, marketSymbol)}>Cancel</button> : '—'}</span></div>;
      })}
    </div>
  );
}

function normalizeExecutionPosition(row: Record<string, unknown>): VenuePosition | undefined {
  const size = activityText(row, 'size', 'position');
  const symbol = activityText(row, 'symbol', 'market');
  if (size === '—' || symbol === '—' || Number(size) === 0) return undefined;
  const sideValue = activityText(row, 'side', 'sign').toLowerCase();
  return {
    marketId: asNumber(row.marketId ?? row.market_id),
    symbol,
    side: sideValue === 'short' || sideValue === '-1' ? 'short' : 'long',
    size,
    entryPrice: activityText(row, 'entryPrice', 'avgEntryPrice', 'avg_entry_price'),
    positionValue: activityText(row, 'positionValue', 'position_value'),
    unrealizedPnl: activityText(row, 'unrealizedPnl', 'unrealized_pnl'),
    liquidationPrice: activityText(row, 'liquidationPrice', 'liquidation_price'),
    marginMode: activityText(row, 'marginMode', 'margin_mode') === 'isolated' ? 'isolated' : 'cross',
    allocatedMargin: activityText(row, 'allocatedMargin', 'allocated_margin'),
    openOrderCount: asNumber(row.openOrderCount ?? row.open_order_count) ?? 0,
  };
}

export default function Home() {
  const { authenticated } = usePrivy();
  const [selectedId, setSelectedId] = useState('btc-usdt');
  const [category, setCategory] = useState<MarketCategory>('crypto');
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(() => new Set(['btc-usdt', 'eth-usdt', 'aapl']));
  const [chartTab, setChartTab] = useState<ChartTab>('chart');
  const [accountTab, setAccountTab] = useState<AccountTab>('positions');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [side, setSide] = useState<Side>('long');
  const [marginMode, setMarginMode] = useState<MarginMode>('cross');
  const [leverage, setLeverage] = useState(5);
  const [size, setSize] = useState('');
  const [orderPrice, setOrderPrice] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [riskOpen, setRiskOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [marketsOpen, setMarketsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const marketTriggerRef = useRef<HTMLButtonElement>(null);
  const marketDrawerRef = useRef<HTMLElement>(null);
  const accountRef = useRef<HTMLElement>(null);

  const selected = markets.find((market) => market.id === selectedId) ?? markets[0];
  const selectedMaxLeverage = maxLeverageForMarket(selected);
  const { tickers, status: tickerStatus } = useCryptoTickerTape();
  const cryptoDetail = useCryptoDetail(selected.derivativesSymbol);
  const { snapshot: marketSnapshot, status: marketSnapshotStatus } = useMarketSnapshot(selected);
  const wallet = useRobinhoodAccount();
  const execution = useAventaExecution(selected.id);
  const { snapshot: venueSnapshot, status: venueStatus } = useVenueAccount(wallet.address, selected);
  const currentTicker = selected.derivativesSymbol
    ? tickers[selected.derivativesSymbol] ?? cryptoDetail.ticker
    : marketSnapshot
      ? { price: marketSnapshot.price, change: marketSnapshot.change ?? 0, high: marketSnapshot.high, low: marketSnapshot.low, volume: marketSnapshot.volume, updatedAt: marketSnapshot.updatedAt }
      : undefined;
  const currentPrice = selected.derivativesSymbol ? cryptoDetail.markPrice ?? currentTicker?.price : marketSnapshot?.price;
  const selectedStatus = selected.derivativesSymbol ? cryptoDetail.status : marketSnapshotStatus;

  const filteredMarkets = useMemo(() => {
    const term = search.trim().toLowerCase();
    return markets.filter((market) => market.category === category && (!term || `${market.base} ${market.quote} ${market.name}`.toLowerCase().includes(term)));
  }, [category, search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const requested = new URLSearchParams(window.location.search).get('market');
      const match = requested ? markets.find((market) => market.id === requested) : undefined;
      if (match) { setSelectedId(match.id); setCategory(match.category); }
      if (new URLSearchParams(window.location.search).get('account') === '1') setAccountOpen(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!marketsOpen) return;
    const trigger = marketTriggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMarketsOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(marketDrawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      trigger?.focus();
    };
  }, [marketsOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      window.setTimeout(() => menuTriggerRef.current?.focus(), 0);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  const selectMarket = (market: Market) => {
    setSelectedId(market.id); setCategory(market.category); setChartTab('chart'); setMarketsOpen(false); setLeverage((current) => Math.min(current, maxLeverageForMarket(market)));
    const url = new URL(window.location.href); url.searchParams.set('market', market.id); window.history.replaceState({}, '', url);
  };
  const toggleFavorite = (marketId: string) => setFavorites((current) => { const next = new Set(current); if (next.has(marketId)) next.delete(marketId); else next.add(marketId); return next; });
  const openMarkets = () => setMarketsOpen(true);
  const openAccountDrawer = useCallback(() => {
    setAccountOpen(true); setMenuOpen(false);
    const url = new URL(window.location.href); url.searchParams.set('account', '1'); window.history.replaceState({}, '', url);
  }, []);
  const closeAccountDrawer = useCallback(() => {
    setAccountOpen(false);
    const url = new URL(window.location.href); url.searchParams.delete('account'); window.history.replaceState({}, '', url);
  }, []);
  const closeAuthSheet = useCallback(() => {
    setAuthOpen(false);
    window.setTimeout(() => menuTriggerRef.current?.focus(), 0);
  }, []);
  const activateTrading = useCallback(async (accountIndex?: number) => {
    if (!authenticated) {
      setAuthOpen(true);
      return;
    }
    if (!wallet.address) {
      await wallet.connect();
      return;
    }
    if (!wallet.isRobinhoodChain) {
      await wallet.switchNetwork();
      return;
    }
    try {
      if (!wallet.ownershipVerified) {
        await wallet.verifyOwnership();
        await execution.refresh();
      }
      await execution.activate(wallet.signMessage, accountIndex);
    } catch {
      // The execution hook keeps a sanitized error for the activation drawer.
    }
  }, [authenticated, execution, wallet]);
  const revokeTrading = useCallback(async () => {
    if (!wallet.address) return;
    try {
      await execution.revoke(wallet.signMessage);
    } catch {
      // The execution hook keeps the revocation failure inside the safety drawer.
    }
  }, [execution, wallet]);
  const submitOrder = useCallback(async () => {
    if (!authenticated) {
      setAuthOpen(true);
      return;
    }
    if (!wallet.address) {
      await wallet.connect();
      return;
    }
    if (!wallet.isRobinhoodChain) {
      await wallet.switchNetwork();
      return;
    }
    if (!wallet.ownershipVerified) {
      try {
        await wallet.verifyOwnership();
        await execution.refresh();
      } catch {
        return;
      }
      return;
    }
    if (!selected.venueSymbol || !execution.readiness.canSubmit) {
      setRiskOpen(true);
      return;
    }
    try {
      await execution.execute('order', '/api/execution/orders', {
        marketSymbol: selected.venueSymbol,
        side: side.toUpperCase(),
        orderType: orderType.toUpperCase(),
        collateralUsd: size,
        leverage,
        marginMode: marginMode.toUpperCase(),
        ...(orderType === 'limit' ? { limitPrice: orderPrice } : {}),
        slippagePercent: (slippageBps / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''),
        consentVersion: EXECUTION_CONSENT_VERSION,
      }, wallet.address, wallet.signMessage);
      setSize('');
    } catch {
      // The execution hook exposes the safe rejection message next to the ticket.
    }
  }, [authenticated, execution, leverage, marginMode, orderPrice, orderType, selected, side, size, slippageBps, wallet]);
  const closePosition = useCallback(async (position: VenuePosition) => {
    const market = markets.find((item) => item.venueSymbol === position.symbol.toUpperCase());
    if (!market || !wallet.address) {
      setRiskOpen(true);
      return;
    }
    try {
      await execution.execute('close', '/api/execution/positions/close', {
        marketSymbol: market.venueSymbol,
        closePercent: '100',
        slippagePercent: (slippageBps / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''),
        consentVersion: EXECUTION_CONSENT_VERSION,
      }, wallet.address, wallet.signMessage);
    } catch {
      // A close is never retried blindly after an ambiguous venue response.
    }
  }, [execution, slippageBps, wallet]);
  const cancelOrder = useCallback(async (orderId: string, marketSymbol: string) => {
    if (!wallet.address) return;
    try {
      await execution.execute('cancel', '/api/execution/orders/cancel', { marketSymbol, orderId }, wallet.address, wallet.signMessage);
    } catch {
      // The execution hook presents the venue-safe failure state.
    }
  }, [execution, wallet]);
  const cancelAllOrders = useCallback(async () => {
    if (!wallet.address) return;
    try {
      await execution.execute('cancel-all', '/api/execution/orders/cancel-all', {}, wallet.address, wallet.signMessage);
    } catch {
      // The execution hook presents the venue-safe failure state.
    }
  }, [execution, wallet]);
  const withdrawUsdG = useCallback(async (amount: string) => {
    if (!wallet.address) throw new Error('Connect your verified wallet before withdrawing.');
    if (!wallet.isRobinhoodChain) {
      await wallet.switchNetwork();
      throw new Error('Robinhood Chain is now selected. Review the withdrawal and submit again.');
    }
    if (!wallet.ownershipVerified) {
      await wallet.verifyOwnership();
      await execution.refresh();
      throw new Error('Wallet ownership is verified. Review the withdrawal and submit again.');
    }
    const result = await execution.execute(
      'withdraw',
      '/api/execution/withdrawals',
      { amount },
      wallet.address,
      wallet.signMessage,
    );
    window.dispatchEvent(new CustomEvent('aventa:withdrawal-submitted', {
      detail: { address: wallet.address, amount, asset: 'USDG' },
    }));
    void wallet.refreshWithdrawalClaim().catch(() => undefined);
    return result;
  }, [execution, wallet]);
  const claimWithdrawal = useCallback(async () => {
    const result = await wallet.claimPendingWithdrawalUsdg();
    await execution.refresh().catch(() => undefined);
    return result;
  }, [execution, wallet]);
  const referenceFunding = cryptoDetail.fundingRate !== undefined ? cryptoDetail.fundingRate * 100 : undefined;
  const nextFundingLabel = cryptoDetail.nextFunding ? new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(cryptoDetail.nextFunding) : 'Loading…';
  const auxiliaryMetricLabel = selected.derivativesSymbol
    ? 'Ref. funding / next'
    : selected.category === 'shares'
      ? 'Bid / ask'
      : 'Session volume';
  const auxiliaryMetricValue = selected.derivativesSymbol
    ? referenceFunding === undefined ? 'Loading…' : `${formatPercent(referenceFunding, 4)} / ${nextFundingLabel}`
    : selected.category === 'shares' && marketSnapshot?.bid !== undefined && marketSnapshot.ask !== undefined
      ? `${formatPrice(marketSnapshot.bid)} / ${formatPrice(marketSnapshot.ask)}`
      : formatCompact(currentTicker?.volume);
  const venueLabel = venueStatus === 'live'
    ? venueSnapshot?.venue.marketListed ? `${venueSnapshot.venue.name} · live` : 'Venue live · market check'
    : 'Venue reconnecting';
  const privatePositions = execution.activity.positions.flatMap((position) => normalizeExecutionPosition(position) ?? []);
  const venuePositions = privatePositions.length ? privatePositions : venueSnapshot?.positions ?? [];
  const venueAccount = venueSnapshot?.account;
  const unrealizedPnl = venuePositions.reduce((sum, position) => sum + (Number(position.unrealizedPnl) || 0), 0);
  const portfolioValue = Number(venueAccount?.portfolioValue);
  const initialMargin = Number(venueAccount?.crossInitialMarginRequirement);
  const marginUsage = Number.isFinite(portfolioValue) && portfolioValue > 0 && Number.isFinite(initialMargin)
    ? `${((initialMargin / portfolioValue) * 100).toFixed(2)}%`
    : venueAccount ? '0.00%' : 'Connect wallet';
  const accountCounts: Record<AccountTab, number> = {
    positions: venuePositions.length,
    orders: execution.activity.openOrders.length || venueAccount?.pendingOrderCount || 0,
    'order-history': execution.activity.orderHistory.length,
    'trade-history': execution.activity.tradeHistory.length,
  };
  const activityItems = accountTab === 'orders'
    ? execution.activity.openOrders
    : accountTab === 'order-history'
      ? execution.activity.orderHistory
      : execution.activity.tradeHistory;
  const availableCollateral = Number(venueAccount?.availableBalance);
  const hasAvailableCollateral = Number.isFinite(availableCollateral) && availableCollateral > 0;
  const collateralAmount = Number(size);
  const hasCollateralAmount = Number.isFinite(collateralAmount) && collateralAmount > 0;
  const enteredOrderPrice = Number(orderPrice);
  const entryEstimate = orderType === 'market'
    ? currentPrice
    : Number.isFinite(enteredOrderPrice) && enteredOrderPrice > 0
      ? enteredOrderPrice
      : currentPrice;
  const positionNotional = hasCollateralAmount ? collateralAmount * leverage : undefined;
  const aventaFeeEstimate = estimateAventaTradeFee(positionNotional);
  const roundTripFeeEstimate = aventaFeeEstimate === undefined ? undefined : aventaFeeEstimate * 2;
  const feeActionLabel = 'Open / increase fee';
  const readinessChecks = [
    { label: 'Signed in', ready: authenticated },
    { label: 'Robinhood wallet', ready: Boolean(wallet.address && wallet.isRobinhoodChain) },
    { label: selected.venueSymbol ? 'Trading authority' : 'Exact venue market', ready: Boolean(selected.venueSymbol && execution.readiness.canSubmit) },
  ];
  const readinessCount = readinessChecks.filter((check) => check.ready).length;
  const leveragePresets = [...new Set([2, 5, 10, selectedMaxLeverage])].filter((value) => value <= selectedMaxLeverage);
  const applyCollateralFraction = (fraction: number) => {
    if (!hasAvailableCollateral) return;
    setSize((availableCollateral * fraction).toFixed(6).replace(/\.?0+$/, ''));
  };
  const orderInputReady = hasCollateralAmount
    && (orderType === 'market' || (Number.isFinite(enteredOrderPrice) && enteredOrderPrice > 0));
  const tradeButtonLabel = !authenticated
    ? 'Sign in to trade'
    : !wallet.address
      ? 'Connect wallet'
      : !wallet.isRobinhoodChain
        ? 'Switch to Robinhood Chain'
        : !wallet.ownershipVerified
          ? 'Verify wallet'
        : !selected.venueSymbol
          ? 'Reference-only market'
          : !execution.readiness.canSubmit
            ? 'Activate trading'
            : !orderInputReady
              ? 'Complete order details'
              : `Review ${side}`;

  return (
    <main className="terminal-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      {menuOpen && <button className="terminal-menu-backdrop" type="button" tabIndex={-1} aria-label="Dismiss terminal menu" onClick={() => setMenuOpen(false)} />}
      <div className={`terminal-menu ${menuOpen ? 'open' : ''}`}>
        <button ref={menuTriggerRef} className="menu-trigger" type="button" aria-label={menuOpen ? 'Close terminal menu' : 'Open terminal menu'} aria-expanded={menuOpen} aria-controls="terminal-navigation" onClick={() => setMenuOpen((current) => !current)}>
          <span /><span /><span />
        </button>
        <nav className="menu-flyout" id="terminal-navigation" aria-label="Terminal navigation">
          <div className="menu-heading"><span className="brand-mark small aventa-mark"><img src="/aventa-mark.png" alt="" /></span><div><strong>AVENTA</strong><small>REFERENCE TERMINAL</small></div></div>
          <div className="menu-status"><i />Live data layer <b>{venueStatus === 'live' ? 'Venue online' : 'Venue reconnecting'}</b></div>
          <Link href="/"><span>01</span>Home <b>↗</b></Link>
          <Link href="/markets"><span>02</span>Markets <b>↗</b></Link>
          <Link href="/platform"><span>03</span>Platform <b>↗</b></Link>
          <button type="button" onClick={openAccountDrawer}><span>04</span>Wallet <b>◎</b></button>
          <Link href="/agent"><span>05</span>Agent <b>↗</b></Link>
          <button type="button" onClick={() => { setRiskOpen(true); setMenuOpen(false); }}><span>06</span>Risk center <b>◎</b></button>
          <div className="menu-network"><span><i />Robinhood Chain</span><strong>4663</strong></div>
          <button className="menu-wallet" type="button" aria-haspopup="dialog" onClick={() => { setMenuOpen(false); setAuthOpen(true); }}><span>{authenticated ? 'Account & sign out' : 'Sign in'}</span><small>{authenticated ? 'Privy session active' : 'Email · Google · X · Wallet'}</small></button>
        </nav>
      </div>
      {wallet.error && <div className="wallet-message" role="alert">{wallet.error}<button type="button" onClick={wallet.connect}>Try again</button></div>}

      <section className="market-bar" aria-label="Selected market summary">
        <button ref={marketTriggerRef} className="market-identity" type="button" aria-expanded={marketsOpen} aria-controls="market-catalog" aria-haspopup="dialog" onClick={openMarkets}><span className="asset-orb"><AssetLogo market={selected} size={36} /></span><span><strong>{formatPair(selected)} <b>⌄</b></strong><small>{selected.category === 'shares' ? 'EQUITY MARKET' : `${categoryLabels[selected.category].toUpperCase()} · PERPETUAL MARKET`}</small></span></button>
        <div className="market-stat hero-stat"><span>{selected.category === 'shares' ? 'Quote midpoint' : 'Reference mark'}</span><strong>{currentPrice === undefined ? 'Loading…' : `${formatPrice(currentPrice)} ${selected.quote}`}</strong></div>
        <div className="market-stat"><span>24h change</span><strong className={(currentTicker?.change ?? 0) < 0 ? 'negative' : 'positive'}>{currentTicker ? formatPercent(currentTicker.change) : 'Loading…'}</strong></div>
        <div className="market-stat"><span>24h range</span><strong>{currentTicker ? `${formatPrice(currentTicker.low)} — ${formatPrice(currentTicker.high)}` : 'Loading…'}</strong></div>
        <div className="market-stat"><span>{auxiliaryMetricLabel}</span><strong>{auxiliaryMetricValue}</strong></div>
        <div className="market-stat"><span>Execution venue</span><strong>{venueLabel}</strong></div>
        <DataBadge status={selectedStatus} market={selected} stockHalted={marketSnapshot?.halted} />
      </section>

      {marketsOpen && <>
        <button className="market-drawer-backdrop" type="button" tabIndex={-1} onClick={() => setMarketsOpen(false)} aria-label="Close market catalog" />
        <aside ref={marketDrawerRef} className="markets-panel drawer-open" id="market-catalog" role="dialog" aria-labelledby="market-catalog-title">
          <div className="panel-title-row"><div><span id="market-catalog-title">MARKET CATALOG</span><small>{markets.length} references</small></div><button className="catalog-close" type="button" onClick={() => setMarketsOpen(false)} aria-label="Close market catalog">×</button></div>
          <label className="search-shell"><span>⌕</span><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search markets" placeholder="Search markets" />{search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search">×</button>}</label>
          <div className="category-tabs" role="tablist" aria-label="Market categories">{(Object.keys(categoryLabels) as MarketCategory[]).map((id) => <button className={category === id ? 'active' : ''} type="button" role="tab" aria-selected={category === id} key={id} onClick={() => setCategory(id)}>{categoryLabels[id]}</button>)}</div>
          <div className="market-list">
            {filteredMarkets.map((market) => {
              const ticker = market.derivativesSymbol ? tickers[market.derivativesSymbol] : undefined;
              return <div className={`market-row ${selected.id === market.id ? 'active' : ''}`} key={market.id}><button className="market-main" type="button" onClick={() => selectMarket(market)}><span className="mini-orb"><AssetLogo market={market} size={25} /></span><span className="market-name"><strong>{formatPair(market)}</strong><small>{market.source}</small></span><span className="market-price"><strong>{ticker ? formatPrice(ticker.price) : market.category === 'shares' ? '15s quote' : 'Chart feed'}</strong><small className={(ticker?.change ?? 0) < 0 ? 'negative' : ticker ? 'positive' : ''}>{ticker ? formatPercent(ticker.change) : market.session} · {maxLeverageForMarket(market)}× max</small></span></button><button className={`favorite-button ${favorites.has(market.id) ? 'active' : ''}`} type="button" onClick={() => toggleFavorite(market.id)} aria-label={`${favorites.has(market.id) ? 'Remove' : 'Add'} ${formatPair(market)} ${favorites.has(market.id) ? 'from' : 'to'} favorites`}>☆</button></div>;
            })}
            {!filteredMarkets.length && <div className="no-results"><strong>No markets found</strong><span>Try another symbol or category.</span></div>}
          </div>
          <div className="market-source-note"><i className={`feed-dot status-${tickerStatus}`} /><span><strong>Crypto reference stream</strong><small>{tickerStatus === 'live' ? 'Public feed connected' : tickerStatus === 'connecting' ? 'Connecting to public feed' : 'Feed needs attention'}</small></span></div>
        </aside>
      </>}

      <section className="terminal-stage">
        <section className="workspace-column">
          <section className="chart-panel" aria-label={`${formatPair(selected)} market workspace`}>
            <div className="chart-head"><div className="chart-tabs" role="tablist" aria-label="Market views">{chartTabs.map((tab) => <button className={chartTab === tab.id ? 'active' : ''} type="button" role="tab" aria-selected={chartTab === tab.id} key={tab.id} onClick={() => setChartTab(tab.id)}>{tab.label}</button>)}</div><div className="source-chip"><span>Source</span><strong>{selected.source}</strong></div></div>
            <div className={`chart-content view-${chartTab}`}>
              {chartTab === 'chart' && <div className="chart-live"><TradingViewChart market={selected} /><div className="chart-footnote"><span>Live reference market data — not an executable price.</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Chart by TradingView ↗</a></div></div>}
              {chartTab === 'trades' && <TradesTable detail={cryptoDetail} market={selected} />}
            </div>
          </section>

          <section className="account-panel" ref={accountRef}>
            <div className="account-top"><div className="account-tabs" role="tablist" aria-label="Account activity">{accountTabs.map((tab) => <button className={accountTab === tab.id ? 'active' : ''} type="button" role="tab" aria-selected={accountTab === tab.id} key={tab.id} onClick={() => setAccountTab(tab.id)}>{tab.label}<span>{accountCounts[tab.id]}</span></button>)}</div><div className="account-health"><i />{venueStatus !== 'live' ? 'Venue stream reconnecting' : venueAccount ? 'Live venue account' : wallet.address ? 'No venue account found' : 'Connect wallet for account data'}</div></div>
            <div className="account-summary"><div><span>Account equity</span><strong>{venueAccount ? `${formatPrice(Number(venueAccount.portfolioValue))} USDG` : 'Connect wallet'}</strong><small>Live venue account</small></div><div><span>Free collateral</span><strong>{venueAccount ? `${formatPrice(Number(venueAccount.availableBalance))} USDG` : 'Connect wallet'}</strong><small>Venue balance</small></div><div><span>Unrealized PnL</span><strong className={unrealizedPnl < 0 ? 'negative' : 'positive'}>{venueAccount ? `${formatPrice(unrealizedPnl)} USDG` : 'Connect wallet'}</strong><small>Open positions</small></div><div><span>Margin usage</span><strong>{marginUsage}</strong><small>Initial margin / equity</small></div></div>
            {accountTab === 'positions' && venuePositions.length > 0 && <div className="venue-position-table"><div className="venue-position-head"><span>Market</span><span>Size</span><span>Entry</span><span>Unrealized PnL</span><span>Liquidation</span><span>Action</span></div>{venuePositions.map((position) => <div className="venue-position-row" key={`${position.marketId}-${position.symbol}`}><span><strong>{position.symbol}</strong><small className={position.side === 'long' ? 'positive' : 'negative'}>{position.side.toUpperCase()} · {position.marginMode}</small></span><span>{position.size}</span><span>{formatPrice(Number(position.entryPrice))}</span><span className={Number(position.unrealizedPnl) < 0 ? 'negative' : 'positive'}>{formatPrice(Number(position.unrealizedPnl))} USDG</span><span>{formatPrice(Number(position.liquidationPrice))}</span><button type="button" disabled={execution.busy || !execution.readiness.canClose} onClick={() => void closePosition(position)}>Close position</button></div>)}</div>}
            {accountTab === 'positions' && !venuePositions.length && <div className="account-empty"><span className="empty-signal"><i /><i /><i /></span><div><strong>No open positions</strong><p>{wallet.address ? 'No active derivatives position was returned for this wallet.' : 'Connect a wallet to load its Robinhood Chain venue account.'}</p></div></div>}
            {accountTab === 'orders' && activityItems.length > 0 && <div className="account-bulk-actions"><button type="button" disabled={execution.busy || !execution.readiness.canCancel} onClick={() => void cancelAllOrders()}>Cancel all open orders</button></div>}
            {accountTab !== 'positions' && activityItems.length > 0 && <ActivityTable rows={activityItems} cancellable={accountTab === 'orders'} onCancel={(orderId, marketSymbol) => void cancelOrder(orderId, marketSymbol)} busy={execution.busy} />}
            {accountTab !== 'positions' && !activityItems.length && <div className="account-empty"><span className="empty-signal"><i /><i /><i /></span><div><strong>No {accountTabs.find((tab) => tab.id === accountTab)?.label.toLowerCase()}</strong><p>{execution.readiness.keyReady ? 'No authoritative venue activity was returned for this account.' : venueAccount ? 'Activate the user-owned trading key to load private orders and fills.' : wallet.address ? 'No venue account was found for this wallet.' : 'Connect a wallet to load account activity.'}</p></div></div>}
          </section>
        </section>

        <aside className="order-panel">
          <div className="order-head"><div><h2>Order ticket</h2><span>{formatPair(selected)} perpetual</span></div><span className={`ticket-live-state status-${selectedStatus}`}><i />{selectedStatus === 'live' ? 'Market live' : selectedStatus === 'connecting' ? 'Connecting' : 'Feed delayed'}</span></div>
          <div className="side-switch"><button className={`long ${side === 'long' ? 'active' : ''}`} type="button" onClick={() => setSide('long')}><span>↗</span>Long</button><button className={`short ${side === 'short' ? 'active' : ''}`} type="button" onClick={() => setSide('short')}><span>↘</span>Short</button></div>

          <div className="ticket-readiness"><div><strong>Trading readiness</strong><span>{readinessCount}/3 ready</span></div><div>{readinessChecks.map((check) => <i className={check.ready ? 'ready' : ''} title={check.label} key={check.label} />)}</div></div>

          <div className="ticket-order-grid">
            <label><span>Order type</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as OrderType)} aria-label="Order type"><option value="market">Market</option><option value="limit">Limit</option></select></label>
            <label><span>Mark price</span><div className="ticket-static-value"><strong>{formatPrice(currentPrice)}</strong><small>{selected.quote}</small></div></label>
          </div>

          {orderType === 'limit' && <label className="order-field"><span><b>Limit price</b><small>{selected.quote}</small></span><div className="order-input"><input inputMode="decimal" value={orderPrice} onChange={(event) => setOrderPrice(event.target.value.replace(/[^0-9.]/g, ''))} placeholder={formatPrice(currentPrice)} aria-label="Limit price" /><strong>{selected.quote}</strong></div></label>}

          <div className="margin-switch"><span>Margin mode</span><div>{(['cross', 'isolated'] as MarginMode[]).map((mode) => <button className={marginMode === mode ? 'active' : ''} type="button" key={mode} onClick={() => setMarginMode(mode)}>{mode === 'cross' ? 'Cross' : 'Isolated'}</button>)}</div></div>

          <label className="order-field ticket-collateral-field"><span><b>Collateral</b><button type="button" onClick={openAccountDrawer}>▣ Add funds</button></span><div className="order-input"><input inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" aria-label="USDG collateral amount" /><strong>USDG</strong></div></label>
          <div className="ticket-balance-line"><span>Available balance</span><strong>{venueAccount ? `${formatPrice(availableCollateral)} USDG` : 'Connect wallet'}</strong></div>
          <div className="ticket-fraction-buttons">{[[0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, 'Max']].map(([fraction, label]) => <button type="button" disabled={!hasAvailableCollateral} onClick={() => applyCollateralFraction(Number(fraction))} key={String(label)}>{label}</button>)}</div>

          <div className="leverage-field"><div><span>Leverage</span><strong>{leverage.toFixed(1)}× / {selectedMaxLeverage}×</strong></div><input type="range" min="1" max={selectedMaxLeverage} step="1" value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} aria-label={`Leverage, maximum ${selectedMaxLeverage} times for ${formatPair(selected)}`} style={{ background: `linear-gradient(90deg, #fc6224 0 ${((leverage - 1) / (selectedMaxLeverage - 1)) * 100}%, #68737a ${((leverage - 1) / (selectedMaxLeverage - 1)) * 100}% 100%)` }} /><div className="ticket-leverage-buttons">{leveragePresets.map((preset) => <button type="button" className={leverage === preset ? 'active' : ''} onClick={() => setLeverage(preset)} key={preset}>{preset === selectedMaxLeverage ? 'Max' : `${preset}×`}</button>)}</div><small>{selected.category === 'crypto' ? 'All crypto markets are capped at 15×. Final account and notional limits are enforced by the venue.' : `${categoryLabels[selected.category]} risk cap: ${selectedMaxLeverage}×. Final venue limits may be lower.`}</small></div>

          <p className="ticket-exit-note">Reduce or close an existing position from the Positions table, using the venue’s latest authoritative size.</p>

          <div className="ticket-summary ticket-summary-card"><div><span>Size</span><strong>{positionNotional ? `${formatPrice(positionNotional)} USDG` : 'Enter collateral'}</strong></div><div><span>Effective leverage</span><strong>{leverage.toFixed(1)}×</strong></div><div><span>Mark / entry estimate</span><strong>{formatPrice(entryEstimate)} {selected.quote}</strong></div><div><span>Liquidation estimate</span><strong>Protocol-calculated</strong></div><div><span>{feeActionLabel} <small>{aventaTradeFeePolicy.percent.toFixed(2)}%</small></span><strong>{aventaFeeEstimate === undefined ? 'Enter collateral' : `${formatPrice(aventaFeeEstimate)} USDG`}</strong></div><div><span>Est. round-trip fee <small>2 fills</small></span><strong>{roundTripFeeEstimate === undefined ? 'Enter collateral' : `${formatPrice(roundTripFeeEstimate)} USDG`}</strong></div><div><span>Slippage tolerance</span><select aria-label="Slippage tolerance" value={(slippageBps / 100).toFixed(2)} onChange={(event) => setSlippageBps(Math.round(Number(event.target.value) * 100))}><option value="0.10">0.10%</option><option value="0.50">0.50%</option><option value="1.00">1.00%</option></select></div><details><summary>More execution details</summary><p>{orderType.toUpperCase()} · {marginMode.toUpperCase()} · {side.toUpperCase()} · OPEN / INCREASE</p><p>Aventa ecosystem fee: {aventaTradeFeePolicy.percent.toFixed(2)}% of actual filled notional on every opening, increasing, reducing, and closing fill. The final amount follows the venue fill. Venue fees, funding, and network costs are separate.</p><p>Collection status: treasury account {aventaTradeFeePolicy.integratorAccountIndex} verified. Every live order is blocked until the exact 0.17% integrator cap is approved by this wallet.</p></details></div>

          <div className="ticket-safety-notes"><p><span>⌁</span>Your wallet signs the final Robinhood Chain venue action. Aventa never treats a chart price as a guaranteed fill.</p><p><span>◇</span>USDG is the only collateral asset used by this order ticket. Leverage availability can be reduced by venue risk limits.</p><p><span>◎</span>The {aventaTradeFeePolicy.percent.toFixed(2)}% Aventa ecosystem fee is disclosed before signing and applies only to actual filled notional. Collection requires your explicit venue integrator approval.</p></div>
          {(execution.notice || execution.error) && <p className={`execution-ticket-message ${execution.error ? 'error' : ''}`} role={execution.error ? 'alert' : 'status'}>{execution.error || execution.notice}</p>}
          <button className="trade-button" type="button" disabled={execution.busy || (Boolean(selected.venueSymbol) && execution.readiness.canSubmit && !orderInputReady)} onClick={() => void submitOrder()}><span>{execution.busy ? 'Processing secure request…' : tradeButtonLabel}</span><i>↗</i></button>
          {marginMode === 'cross' && <p className="inline-warning">Cross margin can place all USDG collateral in this account at risk.</p>}
        </aside>
      </section>

      <footer className="terminal-footer"><div className="footer-brand"><span className="brand-mark small aventa-mark"><img src="/aventa-mark.png" alt="" /></span><div><strong>AVENTA</strong><small>Built to keep decisions in motion.</small></div></div><p>Built on Robinhood Chain. Independent protocol; not affiliated with or endorsed by Robinhood. Feed timing follows the selected source and market session.</p><div><a href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">Chain docs ↗</a><a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">Explorer ↗</a><button type="button" onClick={() => setRiskOpen(true)}>Risk center</button></div></footer>

      {riskOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setRiskOpen(false)}><section className="risk-drawer" role="dialog" aria-modal="true" aria-labelledby="risk-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="drawer-close" type="button" onClick={() => setRiskOpen(false)} aria-label="Close risk center">×</button>
        <span className="eyebrow">TRADING ACTIVATION · {execution.readiness.mode.replace('_', ' ').toUpperCase()}</span>
        <h2 id="risk-title">Wallet-owned authority. Server-enforced limits.</h2>
        <p className="drawer-intro">{execution.readiness.message}</p>
        <div className="readiness-list">
          <div className="ready"><i>✓</i><span><strong>Live market and public account data</strong><small>Quotes, positions, and venue market status are read from current upstream sources.</small></span></div>
          <div className={wallet.address ? 'ready' : ''}><i>{wallet.address ? '✓' : '2'}</i><span><strong>Connected Robinhood Chain wallet</strong><small>The wallet must own the selected Lighter account.</small></span></div>
          <div className={execution.readiness.keyReady ? 'ready' : ''}><i>{execution.readiness.keyReady ? '✓' : '3'}</i><span><strong>User-owned venue trading key</strong><small>Generated inside the isolated signer and encrypted as a SecureString. Your EVM private key is never requested.</small></span></div>
          <div className={execution.readiness.feeApproved ? 'ready' : ''}><i>{execution.readiness.feeApproved ? '✓' : '4'}</i><span><strong>Exact ecosystem fee approval</strong><small>Approval is capped at {aventaTradeFeePolicy.percent.toFixed(2)}% and bound to treasury account {aventaTradeFeePolicy.integratorAccountIndex}.</small></span></div>
          <div className={execution.readiness.canSubmit ? 'ready' : ''}><i>{execution.readiness.canSubmit ? '✓' : '5'}</i><span><strong>Execution safety gates</strong><small>Market listing, venue health, nonce lane, quota, and kill-switch checks must all pass at submission time.</small></span></div>
          {execution.readiness.gates.map((gate) => <div className={gate.ready ? 'ready' : ''} key={gate.id}><i>{gate.ready ? '✓' : '·'}</i><span><strong>{gate.label}</strong>{gate.detail && <small>{gate.detail}</small>}</span></div>)}
        </div>
        {execution.accountChoices.length > 0 && <div className="execution-account-choices"><strong>Choose your Lighter account</strong>{execution.accountChoices.map((account) => <button type="button" disabled={execution.busy} key={account.index} onClick={() => void activateTrading(account.index)}><span>{account.label}</span><small>{account.kind ?? `Account index ${account.index}`}</small></button>)}</div>}
        {(execution.notice || execution.error) && <p className={`execution-drawer-message ${execution.error ? 'error' : ''}`} role={execution.error ? 'alert' : 'status'}>{execution.error || execution.notice}</p>}
        {!execution.readiness.canSubmit && !execution.accountChoices.length && <button className="drawer-action" type="button" disabled={execution.busy || !execution.readiness.canPrepare || !wallet.address} onClick={() => void activateTrading()}>{execution.busy ? 'Waiting for secure approval…' : !wallet.address ? 'Connect wallet first' : execution.readiness.canPrepare ? 'Activate trading authority' : 'Signer setup required'}</button>}
        {execution.readiness.keyReady && <button className="drawer-secondary-action" type="button" disabled={execution.busy} onClick={() => void revokeTrading()}>Revoke trading authority</button>}
        <div className="risk-copy"><p><strong>Execution:</strong> Every order, cancel, and close carries a fresh wallet signature over the exact payload and expires after 30 seconds.</p><p><strong>Risk reduction:</strong> Quota or budget protection blocks new risk while cancel and reduce-only close remain available.</p><p><strong>Fees:</strong> Aventa charges {aventaTradeFeePolicy.percent.toFixed(2)}% of actual filled notional while the approved fee route is healthy. Emergency reduce-only exits waive Aventa’s fee if that route is unavailable. Venue fees, funding, and network costs are separate.</p><p><strong>Market risk:</strong> Market and limit orders can experience slippage, partial fills, or fail during fast markets.</p><p><strong>Eligibility:</strong> Perpetual products may be restricted by jurisdiction and account status.</p></div>
        <a className="drawer-link" href="https://docs.lighter.xyz/perpetual-futures/api" target="_blank" rel="noreferrer">Read venue API requirements ↗</a>
      </section></div>}
      <AccountDrawer
        account={wallet}
        withdrawal={{
          canSubmit: execution.readiness.canWithdraw,
          availableBalance: execution.readiness.withdrawal.availableBalance,
          minimumAmount: execution.readiness.withdrawal.minimumAmount,
          openPositions: execution.readiness.withdrawal.openPositions,
          pendingOrderCount: execution.readiness.withdrawal.pendingOrderCount,
          busy: execution.busy,
          notice: execution.notice,
          error: execution.error,
          submit: withdrawUsdG,
          claimReady: wallet.withdrawalClaimReady,
          claimBusy: wallet.withdrawalClaimBusy,
          claimError: wallet.withdrawalClaimError,
          refreshClaim: wallet.refreshWithdrawalClaim,
          claim: claimWithdrawal,
        }}
        open={accountOpen}
        onClose={closeAccountDrawer}
      />
      <AuthSheet open={authOpen} onClose={closeAuthSheet} />
    </main>
  );
}
