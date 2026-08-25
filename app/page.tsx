'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useState } from 'react';
import AuthSheet from './components/AuthSheet';
import Link from './components/InternalLink';

export default function Home() {
  const [authOpen, setAuthOpen] = useState(false);
  const { authenticated } = usePrivy();

  return (
    <main className="home-shell">
      <nav className="home-nav" aria-label="Primary navigation">
        <Link className="home-brand" href="/" aria-label="Aventa home">
          <span className="brand-mark aventa-mark"><img src="/aventa-mark.png" alt="" /></span>
          <span>AVENTA<small>PERPETUAL MARKETS</small></span>
        </Link>
        <div className="home-nav-actions">
          <Link className="home-open-terminal" href="/trade">Open terminal</Link>
          <button className="home-sign-in" type="button" aria-haspopup="dialog" onClick={() => setAuthOpen(true)}>{authenticated ? 'Account' : 'Sign in'}</button>
        </div>
      </nav>

      <section className="home-hero">
        <div className="hero-copy">
          <span className="hero-kicker"><i />LIVE REFERENCE LAYER · ROBINHOOD CHAIN</span>
          <h1>Move with intent.<br /><em>Trade with clarity.</em></h1>
          <p>Aventa brings crypto and global market references into one fluid terminal, built for precise decisions, transparent data, and user-authorized execution.</p>
          <div className="hero-actions">
            <Link className="primary-action" href="/trade">Open terminal <span>↗</span></Link>
            <button className="secondary-action" type="button" aria-haspopup="dialog" onClick={() => setAuthOpen(true)}>{authenticated ? 'Account' : 'Sign in'}</button>
          </div>
          <div className="hero-proof">
            <div><strong>35</strong><span>Market references</span></div>
            <div><strong>5</strong><span>Asset classes</span></div>
            <div><strong>4663</strong><span>Robinhood Chain</span></div>
          </div>
        </div>

        <div className="hero-instrument" role="img" aria-label="Aventa live market visualization">
          <div className="instrument-label"><span>MARKET SIGNAL</span><b>LIVE DATA</b></div>
          <div className="signal-orbit orbit-one" /><div className="signal-orbit orbit-two" />
          <div className="signal-core"><img src="/aventa-mark.png" alt="" /><small>IN MOTION</small></div>
          <div className="signal-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          <div className="floating-market market-btc"><span>BTC / USDT</span><b>Live reference</b></div>
          <div className="floating-market market-equity"><span>GLOBAL MARKETS</span><b>Five asset classes</b></div>
        </div>
      </section>

      <section className="home-tape" aria-label="Market coverage">
        <span>CRYPTO</span><i /> <span>FOREX</span><i /> <span>METALS</span><i /> <span>COMMODITIES</span><i /> <span>SHARES</span>
      </section>

      <section className="home-terminal-story">
        <div className="terminal-story-copy">
          <span>ONE SURFACE · MANY SIGNALS</span>
          <h2>Dense where it matters. Fluid everywhere else.</h2>
          <p>The terminal keeps live charts, market statistics, order controls, positions, and wallet context in one uninterrupted workflow. Navigation opens from a click-controlled three-line menu so the market stays in focus.</p>
          <Link href="/trade">Enter the reference terminal <b>↗</b></Link>
        </div>
        <div className="terminal-story-visual" aria-hidden="true">
          <div className="story-menu"><i /><i /><i /></div>
          <div className="story-market"><span>BTC / USDT</span><strong>LIVE REFERENCE</strong></div>
          <div className="story-chart"><span /><span /><span /><span /><span /><span /><span /><span /></div>
          <div className="story-ticket"><i /><i /><i /><b /></div>
          <div className="story-caption">SOURCE VISIBLE · USER-SIGNED EXECUTION</div>
        </div>
      </section>

      <section className="home-final">
        <span>AVENTA / ROBINHOOD CHAIN</span>
        <h2>Move with the market.<br /><em>Keep your footing.</em></h2>
        <Link href="/trade">Open terminal <b>↗</b></Link>
      </section>

      <footer className="home-footer">
        <div><strong>AVENTA</strong><span>PERPETUAL MARKETS IN MOTION</span></div>
        <p>Independent protocol concept built for Robinhood Chain. Not affiliated with or endorsed by Robinhood. Reference data is not an executable price.</p>
      </footer>
      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </main>
  );
}
