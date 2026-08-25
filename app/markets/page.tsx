import Link from '../components/InternalLink';
import { AssetLogo } from '../components/AssetLogo';
import {
  categoryLabels,
  formatPair,
  markets,
  type MarketCategory,
} from '../markets';

const categoryOrder: MarketCategory[] = [
  'crypto',
  'forex',
  'metals',
  'commodities',
  'shares',
];

const categoryDescriptions: Record<MarketCategory, string> = {
  crypto: 'Round-the-clock digital asset references from realtime derivatives markets.',
  forex: 'Major currency references covering the most actively followed global pairs.',
  metals: 'Spot and delayed futures references for precious and industrial metals.',
  commodities: 'Energy and agriculture references across global exchange sessions.',
  shares: 'U.S. equity references prepared for Robinhood Stock Token market discovery.',
};

const marketsStyles = `
  .markets-page-shell {
    min-height: 100svh;
    overflow: hidden;
    color: #f2f2f2;
    background:
      radial-gradient(circle at 84% 2%, rgba(252, 98, 36, .15), transparent 27rem),
      linear-gradient(122deg, #374550 0 64%, #2b3740 64% 100%);
  }
  .markets-page-header {
    width: min(1480px, calc(100% - 48px));
    min-height: 82px;
    display: flex;
    align-items: center;
    gap: 34px;
    margin: 0 auto;
    border-bottom: 1px solid rgba(104, 115, 122, .8);
  }
  .markets-page-brand {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    font-weight: 850;
    letter-spacing: .09em;
  }
  .markets-page-brand-mark {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid #68737a;
    border-radius: 50%;
    color: #fc6224;
    font: 800 12px var(--font-geist-mono), monospace;
  }
  .markets-page-brand-copy { display: grid; gap: 3px; }
  .markets-page-brand-copy small {
    color: #b8bdc0;
    font: 600 8px var(--font-geist-mono), monospace;
    letter-spacing: .14em;
  }
  .markets-page-nav {
    display: flex;
    align-items: center;
    gap: 26px;
    margin-left: auto;
  }
  .markets-page-nav a {
    color: #b8bdc0;
    font-size: 10px;
    transition: color 150ms ease;
  }
  .markets-page-nav a:hover { color: #f2f2f2; }
  .markets-page-nav-terminal {
    padding: 12px 17px;
    border-radius: 5px 17px 5px 15px;
    background: #fc6224;
    color: #2b3740 !important;
    font-weight: 760;
  }
  .markets-page-main {
    width: min(1480px, calc(100% - 48px));
    margin: 0 auto;
    padding: 74px 0 96px;
  }
  .markets-page-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, .47fr);
    gap: 64px;
    align-items: end;
    padding-bottom: 62px;
  }
  .markets-page-kicker {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #fc6224;
    font: 700 9px var(--font-geist-mono), monospace;
    letter-spacing: .15em;
  }
  .markets-page-kicker::before {
    width: 24px;
    height: 2px;
    content: '';
    background: currentColor;
  }
  .markets-page-title {
    max-width: 920px;
    margin: 23px 0 20px;
    font-size: clamp(54px, 7.5vw, 110px);
    line-height: .87;
    letter-spacing: -.078em;
  }
  .markets-page-title em {
    color: #b8bdc0;
    font-family: Georgia, serif;
    font-weight: 500;
  }
  .markets-page-lead {
    max-width: 650px;
    margin: 0;
    color: #b8bdc0;
    font-size: 14px;
    line-height: 1.72;
  }
  .markets-page-hero-aside {
    min-height: 220px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-content: end;
    border: 1px solid #68737a;
    border-radius: 46px 7px 54px 7px;
    background: rgba(70, 86, 97, .88);
    box-shadow: 0 28px 70px rgba(43, 55, 64, .42);
  }
  .markets-page-stat {
    min-height: 138px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 24px;
  }
  .markets-page-stat + .markets-page-stat { border-left: 1px solid #68737a; }
  .markets-page-stat strong {
    font: 680 40px var(--font-geist-mono), monospace;
    letter-spacing: -.06em;
  }
  .markets-page-stat span {
    margin-top: 8px;
    color: #b8bdc0;
    font: 650 8px var(--font-geist-mono), monospace;
    letter-spacing: .11em;
    text-transform: uppercase;
  }
  .markets-page-disclosure {
    grid-column: 1 / -1;
    margin: 0;
    padding: 17px 24px 21px;
    border-top: 1px solid #68737a;
    color: #b8bdc0;
    font-size: 9px;
    line-height: 1.55;
  }
  .markets-page-index {
    display: flex;
    gap: 8px;
    margin-bottom: 70px;
    padding-block: 16px;
    overflow-x: auto;
    border-block: 1px solid #68737a;
  }
  .markets-page-index a {
    flex: 1 0 auto;
    min-width: 130px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 11px 14px;
    border: 1px solid transparent;
    border-radius: 4px 15px 4px 15px;
    color: #b8bdc0;
    font: 650 9px var(--font-geist-mono), monospace;
    transition: 160ms ease;
  }
  .markets-page-index a:hover {
    border-color: #68737a;
    background: #465661;
    color: #f2f2f2;
  }
  .markets-page-index span { color: #808080; }
  .markets-page-section { scroll-margin-top: 24px; }
  .markets-page-section + .markets-page-section { margin-top: 86px; }
  .markets-page-section-head {
    display: grid;
    grid-template-columns: minmax(220px, .58fr) minmax(300px, 1fr) auto;
    align-items: end;
    gap: 36px;
    margin-bottom: 24px;
    padding-bottom: 19px;
    border-bottom: 1px solid #68737a;
  }
  .markets-page-section-title {
    margin: 0;
    font-size: clamp(31px, 4vw, 52px);
    line-height: 1;
    letter-spacing: -.055em;
  }
  .markets-page-section-copy {
    max-width: 560px;
    margin: 0;
    color: #b8bdc0;
    font-size: 11px;
    line-height: 1.65;
  }
  .markets-page-section-count {
    color: #fc6224;
    font: 700 10px var(--font-geist-mono), monospace;
  }
  .markets-page-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .markets-page-card {
    min-height: 214px;
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 22px;
    overflow: hidden;
    border: 1px solid #68737a;
    border-radius: 6px 24px 6px 24px;
    background: rgba(70, 86, 97, .84);
    transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
  }
  .markets-page-card::after {
    width: 60px;
    height: 60px;
    position: absolute;
    right: -31px;
    bottom: -31px;
    content: '';
    border: 1px solid rgba(252, 98, 36, .52);
    border-radius: 50%;
  }
  .markets-page-card:hover {
    border-color: #fc6224;
    background: #53636d;
    transform: translateY(-2px);
  }
  .markets-page-card-top {
    display: flex;
    align-items: center;
    gap: 13px;
  }
  .markets-page-logo {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
  }
  .markets-page-pair { display: grid; gap: 5px; }
  .markets-page-pair strong {
    font: 720 14px var(--font-geist-mono), monospace;
    letter-spacing: -.025em;
  }
  .markets-page-pair span { color: #f2f2f2; font-size: 9px; }
  .markets-page-state {
    margin-left: auto;
    padding: 6px 9px;
    border: 1px solid #68737a;
    border-radius: 999px;
    color: #f2f2f2;
    font: 670 7px var(--font-geist-mono), monospace;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .markets-page-meta {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    margin-top: auto;
    padding-top: 26px;
  }
  .markets-page-meta div { display: grid; gap: 6px; min-width: 0; }
  .markets-page-meta div:last-child { text-align: right; }
  .markets-page-meta span {
    color: #f2f2f2;
    font: 650 7px var(--font-geist-mono), monospace;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .markets-page-meta strong {
    overflow: hidden;
    color: #f2f2f2;
    font-size: 9px;
    font-weight: 560;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .markets-page-card-action {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid rgba(104, 115, 122, .65);
    color: #f2f2f2;
    font-size: 9px;
    font-weight: 720;
  }
  .markets-page-card-action b { color: #fc6224; font-size: 15px; }
  .markets-page-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 42px;
    align-items: end;
    margin-top: 96px;
    padding-top: 28px;
    border-top: 1px solid #68737a;
  }
  .markets-page-footer p {
    max-width: 820px;
    margin: 0;
    color: #b8bdc0;
    font-size: 9px;
    line-height: 1.65;
  }
  .markets-page-footer a {
    color: #fc6224;
    font-size: 10px;
    font-weight: 720;
  }
  @media (max-width: 1000px) {
    .markets-page-hero { grid-template-columns: 1fr; }
    .markets-page-hero-aside { min-height: 190px; }
    .markets-page-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 700px) {
    .markets-page-header, .markets-page-main { width: min(100% - 28px, 1480px); }
    .markets-page-header { min-height: 72px; }
    .markets-page-brand-copy small { display: none; }
    .markets-page-nav { gap: 13px; }
    .markets-page-nav a { font-size: 9px; }
    .markets-page-nav a:first-child { display: none; }
    .markets-page-nav-terminal { padding: 10px 12px; }
    .markets-page-main { padding-top: 52px; }
    .markets-page-title { font-size: clamp(52px, 18vw, 78px); }
    .markets-page-hero { gap: 42px; padding-bottom: 45px; }
    .markets-page-section-head { grid-template-columns: 1fr auto; gap: 15px; }
    .markets-page-section-copy { grid-column: 1 / -1; grid-row: 2; }
    .markets-page-grid { grid-template-columns: 1fr; }
    .markets-page-footer { grid-template-columns: 1fr; }
  }
`;

export default function MarketsPage() {
  const groupedMarkets = categoryOrder.map((category) => ({
    category,
    items: markets.filter((market) => market.category === category),
  }));

  return (
    <div className="markets-page-shell">
      <style>{marketsStyles}</style>

      <header className="markets-page-header">
        <Link className="markets-page-brand" href="/" aria-label="Aventa home">
          <span className="markets-page-brand-mark" aria-hidden="true"><img src="/aventa-mark.png" alt="" /></span>
          <span className="markets-page-brand-copy">
            <span>AVENTA</span>
            <small>ROBINHOOD CHAIN</small>
          </span>
        </Link>

        <nav className="markets-page-nav" aria-label="Primary navigation">
          <Link href="/">Home</Link>
          <Link href="/trade?account=1">Wallet</Link>
          <Link href="/agent">Agent</Link>
          <Link className="markets-page-nav-terminal" href="/trade">Open terminal</Link>
        </nav>
      </header>

      <main className="markets-page-main">
        <section className="markets-page-hero" aria-labelledby="markets-title">
          <div className="markets-page-hero-copy">
            <span className="markets-page-kicker">MARKET DIRECTORY</span>
            <h1 className="markets-page-title" id="markets-title">
              Find your next <em>signal.</em>
            </h1>
            <p className="markets-page-lead">
              Explore live and delayed reference instruments across five asset classes. Choose a market to open its terminal workspace—without fabricated prices or implied execution.
            </p>
          </div>

          <aside className="markets-page-hero-aside" aria-label="Market coverage summary">
            <div className="markets-page-stat">
              <strong>{markets.length}</strong>
              <span>Reference markets</span>
            </div>
            <div className="markets-page-stat">
              <strong>{categoryOrder.length}</strong>
              <span>Asset classes</span>
            </div>
            <p className="markets-page-disclosure">
              Availability, timing, and market hours follow each named reference source. This directory does not display synthetic quotes.
            </p>
          </aside>
        </section>

        <nav className="markets-page-index" aria-label="Market categories">
          {groupedMarkets.map(({ category, items }) => (
            <a key={category} href={`#${category}`}>
              {categoryLabels[category]}
              <span>{String(items.length).padStart(2, '0')}</span>
            </a>
          ))}
        </nav>

        {groupedMarkets.map(({ category, items }) => (
          <section className="markets-page-section" id={category} key={category} aria-labelledby={`${category}-title`}>
            <header className="markets-page-section-head">
              <h2 className="markets-page-section-title" id={`${category}-title`}>
                {categoryLabels[category]}
              </h2>
              <p className="markets-page-section-copy">{categoryDescriptions[category]}</p>
              <span className="markets-page-section-count">{String(items.length).padStart(2, '0')} MARKETS</span>
            </header>

            <div className="markets-page-grid">
              {items.map((market) => (
                <Link className="markets-page-card" href={`/trade?market=${market.id}`} key={market.id}>
                  <div className="markets-page-card-top">
                    <span className="markets-page-logo">
                      <AssetLogo market={market} size={38} />
                    </span>
                    <span className="markets-page-pair">
                      <strong>{formatPair(market)}</strong>
                      <span>{market.name}</span>
                    </span>
                    <span className="markets-page-state">Reference</span>
                  </div>

                  <div className="markets-page-meta">
                    <div>
                      <span>Source</span>
                      <strong title={market.source}>{market.source}</strong>
                    </div>
                    <div>
                      <span>Session</span>
                      <strong>{market.session}</strong>
                    </div>
                  </div>

                  <span className="markets-page-card-action">
                    Open market
                    <b aria-hidden="true">↗</b>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}

        <footer className="markets-page-footer">
          <p>
            Reference data may be live, delayed, or paused outside its source session. Aventa does not invent missing prices, and selecting a market does not place an order.
          </p>
          <Link href="/trade">Continue to terminal →</Link>
        </footer>
      </main>
    </div>
  );
}
