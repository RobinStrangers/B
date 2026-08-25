import type { Market } from '../markets';

export const marketLeverageCaps: Record<string, number> = {
  'btc-usdt': 15,
  'eth-usdt': 15,
  'xrp-usdt': 15,
  'sol-usdt': 15,
  'bnb-usdt': 15,
  'doge-usdt': 15,
  'ada-usdt': 15,
  'avax-usdt': 15,
  'link-usdt': 15,
  'sui-usdt': 15,
  'eur-usd': 20,
  'gbp-usd': 20,
  'usd-jpy': 20,
  'aud-usd': 15,
  'usd-cad': 15,
  'usd-chf': 15,
  'xau-usd': 15,
  'xag-usd': 10,
  copper: 10,
  platinum: 10,
  'wti-usd': 10,
  'brent-usd': 10,
  'natural-gas': 8,
  corn: 5,
  wheat: 5,
  aapl: 5,
  msft: 5,
  nvda: 5,
  amzn: 5,
  googl: 5,
  meta: 5,
  tsla: 3,
  amd: 3,
  nflx: 3,
  coin: 3,
};

export function maxLeverageForMarket(market: Market) {
  return marketLeverageCaps[market.id] ?? (market.category === 'crypto' ? 15 : 5);
}
