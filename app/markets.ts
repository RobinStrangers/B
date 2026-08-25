export type MarketCategory = 'crypto' | 'forex' | 'metals' | 'commodities' | 'shares';

export type Market = {
  id: string;
  base: string;
  quote: string;
  name: string;
  category: MarketCategory;
  tvSymbol: string;
  derivativesSymbol?: string;
  venueSymbol?: string;
  robinhoodSymbol?: string;
  source: string;
  session: string;
  accent: 'amber' | 'blue' | 'violet' | 'coral' | 'cyan';
  glyph: string;
};

export const categoryLabels: Record<MarketCategory, string> = {
  crypto: 'Crypto',
  forex: 'Forex',
  metals: 'Metals',
  commodities: 'Commodities',
  shares: 'Shares',
};

export const markets: Market[] = [
  { id: 'btc-usdt', base: 'BTC', quote: 'USDT', name: 'Bitcoin perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:BTCUSDT.P', derivativesSymbol: 'BTCUSDT', venueSymbol: 'BTC', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'amber', glyph: '₿' },
  { id: 'eth-usdt', base: 'ETH', quote: 'USDT', name: 'Ether perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:ETHUSDT.P', derivativesSymbol: 'ETHUSDT', venueSymbol: 'ETH', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'violet', glyph: 'Ξ' },
  { id: 'xrp-usdt', base: 'XRP', quote: 'USDT', name: 'XRP perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:XRPUSDT.P', derivativesSymbol: 'XRPUSDT', venueSymbol: 'XRP', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'blue', glyph: 'X' },
  { id: 'sol-usdt', base: 'SOL', quote: 'USDT', name: 'Solana perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:SOLUSDT.P', derivativesSymbol: 'SOLUSDT', venueSymbol: 'SOL', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'violet', glyph: 'S' },
  { id: 'bnb-usdt', base: 'BNB', quote: 'USDT', name: 'BNB perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:BNBUSDT.P', derivativesSymbol: 'BNBUSDT', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'amber', glyph: 'B' },
  { id: 'doge-usdt', base: 'DOGE', quote: 'USDT', name: 'Dogecoin perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:DOGEUSDT.P', derivativesSymbol: 'DOGEUSDT', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'coral', glyph: 'D' },
  { id: 'ada-usdt', base: 'ADA', quote: 'USDT', name: 'Cardano perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:ADAUSDT.P', derivativesSymbol: 'ADAUSDT', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'blue', glyph: 'A' },
  { id: 'avax-usdt', base: 'AVAX', quote: 'USDT', name: 'Avalanche perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:AVAXUSDT.P', derivativesSymbol: 'AVAXUSDT', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'coral', glyph: 'V' },
  { id: 'link-usdt', base: 'LINK', quote: 'USDT', name: 'Chainlink perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:LINKUSDT.P', derivativesSymbol: 'LINKUSDT', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'blue', glyph: 'L' },
  { id: 'sui-usdt', base: 'SUI', quote: 'USDT', name: 'Sui perpetual reference', category: 'crypto', tvSymbol: 'BYBIT:SUIUSDT.P', derivativesSymbol: 'SUIUSDT', venueSymbol: 'SUI', source: 'Realtime derivatives reference', session: '24 / 7', accent: 'cyan', glyph: 'S' },

  { id: 'eur-usd', base: 'EUR', quote: 'USD', name: 'Euro / U.S. Dollar', category: 'forex', tvSymbol: 'OANDA:EURUSD', source: 'OANDA reference', session: '24 / 5', accent: 'blue', glyph: '€' },
  { id: 'gbp-usd', base: 'GBP', quote: 'USD', name: 'British Pound / U.S. Dollar', category: 'forex', tvSymbol: 'OANDA:GBPUSD', source: 'OANDA reference', session: '24 / 5', accent: 'coral', glyph: '£' },
  { id: 'usd-jpy', base: 'USD', quote: 'JPY', name: 'U.S. Dollar / Japanese Yen', category: 'forex', tvSymbol: 'OANDA:USDJPY', source: 'OANDA reference', session: '24 / 5', accent: 'violet', glyph: '¥' },
  { id: 'aud-usd', base: 'AUD', quote: 'USD', name: 'Australian Dollar / U.S. Dollar', category: 'forex', tvSymbol: 'OANDA:AUDUSD', source: 'OANDA reference', session: '24 / 5', accent: 'cyan', glyph: 'A' },
  { id: 'usd-cad', base: 'USD', quote: 'CAD', name: 'U.S. Dollar / Canadian Dollar', category: 'forex', tvSymbol: 'OANDA:USDCAD', source: 'OANDA reference', session: '24 / 5', accent: 'blue', glyph: 'C' },
  { id: 'usd-chf', base: 'USD', quote: 'CHF', name: 'U.S. Dollar / Swiss Franc', category: 'forex', tvSymbol: 'OANDA:USDCHF', source: 'OANDA reference', session: '24 / 5', accent: 'coral', glyph: 'F' },

  { id: 'xau-usd', base: 'XAU', quote: 'USD', name: 'Gold spot reference', category: 'metals', tvSymbol: 'OANDA:XAUUSD', source: 'OANDA reference', session: '24 / 5', accent: 'amber', glyph: 'Au' },
  { id: 'xag-usd', base: 'XAG', quote: 'USD', name: 'Silver spot reference', category: 'metals', tvSymbol: 'OANDA:XAGUSD', source: 'OANDA reference', session: '24 / 5', accent: 'cyan', glyph: 'Ag' },
  { id: 'copper', base: 'COPPER', quote: 'USD', name: 'High Grade Copper futures', category: 'metals', tvSymbol: 'COMEX:HG1!', source: 'COMEX delayed reference', session: 'Exchange hours', accent: 'coral', glyph: 'Cu' },
  { id: 'platinum', base: 'PLATINUM', quote: 'USD', name: 'Platinum futures', category: 'metals', tvSymbol: 'NYMEX:PL1!', source: 'NYMEX delayed reference', session: 'Exchange hours', accent: 'violet', glyph: 'Pt' },

  { id: 'wti-usd', base: 'WTI', quote: 'USD', name: 'WTI crude reference', category: 'commodities', tvSymbol: 'OANDA:WTICOUSD', source: 'OANDA CFD reference', session: '24 / 5', accent: 'coral', glyph: 'W' },
  { id: 'brent-usd', base: 'BRENT', quote: 'USD', name: 'Brent crude reference', category: 'commodities', tvSymbol: 'OANDA:BCOUSD', source: 'OANDA CFD reference', session: '24 / 5', accent: 'amber', glyph: 'B' },
  { id: 'natural-gas', base: 'NATGAS', quote: 'USD', name: 'Natural Gas futures', category: 'commodities', tvSymbol: 'NYMEX:NG1!', source: 'NYMEX delayed reference', session: 'Exchange hours', accent: 'blue', glyph: 'N' },
  { id: 'corn', base: 'CORN', quote: 'USD', name: 'Corn futures', category: 'commodities', tvSymbol: 'CBOT:ZC1!', source: 'CBOT delayed reference', session: 'Exchange hours', accent: 'amber', glyph: 'C' },
  { id: 'wheat', base: 'WHEAT', quote: 'USD', name: 'Wheat futures', category: 'commodities', tvSymbol: 'CBOT:ZW1!', source: 'CBOT delayed reference', session: 'Exchange hours', accent: 'coral', glyph: 'W' },

  { id: 'aapl', base: 'AAPL', quote: 'USD', name: 'Apple equity reference', category: 'shares', tvSymbol: 'NASDAQ:AAPL', robinhoodSymbol: 'AAPL', venueSymbol: 'AAPL', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'cyan', glyph: 'A' },
  { id: 'msft', base: 'MSFT', quote: 'USD', name: 'Microsoft equity reference', category: 'shares', tvSymbol: 'NASDAQ:MSFT', robinhoodSymbol: 'MSFT', venueSymbol: 'MSFT', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'blue', glyph: 'M' },
  { id: 'nvda', base: 'NVDA', quote: 'USD', name: 'NVIDIA equity reference', category: 'shares', tvSymbol: 'NASDAQ:NVDA', robinhoodSymbol: 'NVDA', venueSymbol: 'NVDA', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'violet', glyph: 'N' },
  { id: 'amzn', base: 'AMZN', quote: 'USD', name: 'Amazon equity reference', category: 'shares', tvSymbol: 'NASDAQ:AMZN', robinhoodSymbol: 'AMZN', venueSymbol: 'AMZN', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'amber', glyph: 'A' },
  { id: 'googl', base: 'GOOGL', quote: 'USD', name: 'Alphabet equity reference', category: 'shares', tvSymbol: 'NASDAQ:GOOGL', robinhoodSymbol: 'GOOGL', venueSymbol: 'GOOGL', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'blue', glyph: 'G' },
  { id: 'meta', base: 'META', quote: 'USD', name: 'Meta equity reference', category: 'shares', tvSymbol: 'NASDAQ:META', robinhoodSymbol: 'META', venueSymbol: 'META', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'violet', glyph: 'M' },
  { id: 'tsla', base: 'TSLA', quote: 'USD', name: 'Tesla equity reference', category: 'shares', tvSymbol: 'NASDAQ:TSLA', robinhoodSymbol: 'TSLA', venueSymbol: 'TSLA', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'coral', glyph: 'T' },
  { id: 'amd', base: 'AMD', quote: 'USD', name: 'AMD equity reference', category: 'shares', tvSymbol: 'NASDAQ:AMD', robinhoodSymbol: 'AMD', venueSymbol: 'AMD', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'coral', glyph: 'A' },
  { id: 'nflx', base: 'NFLX', quote: 'USD', name: 'Netflix equity reference', category: 'shares', tvSymbol: 'NASDAQ:NFLX', robinhoodSymbol: 'NFLX', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'coral', glyph: 'N' },
  { id: 'coin', base: 'COIN', quote: 'USD', name: 'Coinbase equity reference', category: 'shares', tvSymbol: 'NASDAQ:COIN', robinhoodSymbol: 'COIN', venueSymbol: 'COIN', source: 'Robinhood Stock Token quote', session: '24 / 5 feed', accent: 'blue', glyph: 'C' },
];

export const cryptoMarkets = markets.filter((market) => market.derivativesSymbol);

export function formatPair(market: Market) {
  return `${market.base} / ${market.quote}`;
}
