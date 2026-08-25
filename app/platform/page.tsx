import Link from '../components/InternalLink';

const dataSources = [
  {
    code: 'TV',
    title: 'TradingView charts',
    state: 'Reference display',
    copy: 'Chart coverage across crypto, currencies, metals, commodities, and shares. Timing follows the selected symbol, source, and market session.',
  },
  {
    code: 'RT',
    title: 'Realtime derivatives streams',
    state: 'Crypto reference',
    copy: 'Ticker, mark, funding, and recent-trade events inform the crypto workspace. The execution venue remains the source of fills and positions.',
  },
  {
    code: 'RH',
    title: 'Stock Token market data',
    state: 'Source dependent',
    copy: 'Share references appear when Robinhood Stock Token market data returns a valid quote. Missing upstream values stay clearly marked as waiting for source data.',
  },
] as const;

const readinessItems = [
  {
    number: '01',
    title: 'Audited clearinghouse',
    copy: 'Position accounting, margin rules, fees, liquidations, and settlement must be defined and independently reviewed.',
  },
  {
    number: '02',
    title: 'Verified oracle path',
    copy: 'Every supported market needs authenticated reports, staleness limits, fallback behavior, and an explicit market registry.',
  },
  {
    number: '03',
    title: 'Collateral vault',
    copy: 'Deposits and withdrawals require reviewed contracts, token allowlists, limits, simulations, and transaction monitoring.',
  },
  {
    number: '04',
    title: 'Operational controls',
    copy: 'Liquidity, keepers, indexing, order history, risk limits, incident controls, and monitoring must operate together.',
  },
] as const;

export default function PlatformPage() {
  return (
    <main className="platform-page-shell">
      <header className="platform-page-header">
        <Link className="platform-page-brand" href="/" aria-label="Aventa home">
          <span className="platform-page-brand-mark" aria-hidden="true"><img src="/aventa-mark.png" alt="" /></span>
          <span className="platform-page-brand-copy">
            <strong>Aventa</strong>
            <small>System architecture</small>
          </span>
        </Link>

        <nav className="platform-page-navigation" aria-label="Primary navigation">
          <Link href="/">Home</Link>
          <Link href="/markets">Markets</Link>
          <Link href="/trade?account=1">Wallet</Link>
          <Link href="/agent">Agent</Link>
          <Link className="platform-page-navigation-terminal" href="/trade">Open terminal</Link>
        </nav>
      </header>

      <section className="platform-page-hero" aria-labelledby="platform-page-title">
        <div className="platform-page-hero-copy">
          <p className="platform-page-kicker">Reference infrastructure · Robinhood Chain</p>
          <h1 id="platform-page-title">
            Built for signal.<br />
            <em>Gated for truth.</em>
          </h1>
          <p className="platform-page-lead">
            Aventa combines source-labelled market discovery with a Robinhood Chain-aware interface.
            Live data, wallet reads, and venue account state share one workspace. Every trading action still requires the account owner&apos;s explicit authorization.
          </p>
          <div className="platform-page-hero-actions">
            <Link href="/trade">Open reference terminal <span aria-hidden="true">↗</span></Link>
            <Link href="/markets">Browse markets</Link>
          </div>
        </div>

        <div className="platform-page-system-map" role="img" aria-label="Market data and wallet-signed intents enter Aventa before isolated venue execution">
          <div className="platform-page-system-map-label">System signal map</div>
          <div className="platform-page-system-inputs">
            <span>TradingView</span>
            <span>Realtime derivatives</span>
            <span>Stock Token data</span>
          </div>
          <div className="platform-page-system-rail" aria-hidden="true"><i /><i /><i /></div>
          <div className="platform-page-system-core">
            <small>Reference layer</small>
            <strong><img src="/aventa-mark.png" alt="" /></strong>
            <span>Source visible</span>
          </div>
          <div className="platform-page-system-output">
            <span>Robinhood Chain</span>
            <strong>User-signed execution</strong>
            <small>Isolated signer · per-request wallet consent</small>
          </div>
        </div>
      </section>

      <section className="platform-page-state-strip" aria-label="Platform state">
        <article>
          <span>Reference layer</span>
          <strong>Source dependent</strong>
          <small>Visible data carries its source and availability state.</small>
        </article>
        <article>
          <span>Network layer</span>
          <strong>Robinhood Chain aware</strong>
          <small>Wallet network target: chain ID 4663, with ETH for gas.</small>
        </article>
        <article>
          <span>Execution layer</span>
          <strong>Venue detected</strong>
          <small>Public positions are readable; private activity requires a user-owned trading key.</small>
        </article>
      </section>

      <section className="platform-page-sources" aria-labelledby="platform-page-sources-title">
        <header className="platform-page-section-heading">
          <div>
            <p>Live and delayed inputs</p>
            <h2 id="platform-page-sources-title">Every signal keeps its source.</h2>
          </div>
          <p>
            Upstream availability can change by instrument and session. Aventa labels missing, stale,
            delayed, and reference-only states instead of generating replacement quotes.
          </p>
        </header>

        <div className="platform-page-source-grid">
          {dataSources.map((source) => (
            <article className="platform-page-source-card" key={source.code}>
              <div className="platform-page-source-card-top">
                <span aria-hidden="true">{source.code}</span>
                <small>{source.state}</small>
              </div>
              <h3>{source.title}</h3>
              <p>{source.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="platform-page-chain" aria-labelledby="platform-page-chain-title">
        <div className="platform-page-chain-visual" aria-hidden="true">
          <span className="platform-page-chain-orbit platform-page-chain-orbit-outer" />
          <span className="platform-page-chain-orbit platform-page-chain-orbit-inner" />
          <div>
            <strong>4663</strong>
            <small>Chain ID</small>
          </div>
        </div>

        <div className="platform-page-chain-copy">
          <p className="platform-page-kicker">Settlement target</p>
          <h2 id="platform-page-chain-title">Robinhood Chain is the network context, not an execution claim.</h2>
          <p>
            Aventa can request a wallet connection, switch to Robinhood Chain, and read supported onchain
            balances. That network connection does not mean a perpetual venue, collateral vault, or market
            contract is deployed.
          </p>
          <dl className="platform-page-chain-details">
            <div><dt>Network</dt><dd>Robinhood Chain</dd></div>
            <div><dt>Native gas asset</dt><dd>ETH</dd></div>
            <div><dt>Execution venue</dt><dd>Required</dd></div>
            <div><dt>Collateral vault</dt><dd>Required</dd></div>
          </dl>
        </div>
      </section>

      <section className="platform-page-readiness" aria-labelledby="platform-page-readiness-title">
        <header className="platform-page-section-heading">
          <div>
            <p>Activation boundary</p>
            <h2 id="platform-page-readiness-title">Execution opens only when the system is complete.</h2>
          </div>
          <p>
            A connected wallet and a live chart are not sufficient. Every critical dependency below must be
            implemented, verified, monitored, and reflected accurately in the interface.
          </p>
        </header>

        <ol className="platform-page-readiness-list">
          {readinessItems.map((item) => (
            <li key={item.number}>
              <span>{item.number}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </div>
              <strong>Required before activation</strong>
            </li>
          ))}
        </ol>
      </section>

      <section className="platform-page-truth" aria-labelledby="platform-page-truth-title">
        <div>
          <p className="platform-page-kicker">Interface principles</p>
          <h2 id="platform-page-truth-title">What the screen will never imply.</h2>
        </div>
        <div className="platform-page-truth-grid">
          <article><span>01</span><strong>Reference is not execution</strong><p>A visible market price is never presented as a guaranteed fill.</p></article>
          <article><span>02</span><strong>Connection is not custody</strong><p>A wallet connection does not transfer assets or grant token approval.</p></article>
          <article><span>03</span><strong>Preview is not a position</strong><p>Ticket calculations stay illustrative until verified venue rules are available.</p></article>
        </div>
      </section>

      <footer className="platform-page-footer">
        <div>
          <strong>Aventa</strong>
          <p>Independent interface concept for Robinhood Chain. Not affiliated with or endorsed by Robinhood.</p>
        </div>
        <div>
          <Link href="/markets">Markets</Link>
          <Link href="/trade?account=1">Wallet</Link>
          <Link href="/agent">Agent</Link>
          <Link href="/trade">Terminal</Link>
        </div>
      </footer>
    </main>
  );
}
