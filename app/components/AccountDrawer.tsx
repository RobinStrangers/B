'use client';

import { TokenIcon } from '@web3icons/react/dynamic';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import AuthSheet from './AuthSheet';
import { useAventaAuth } from './useAventaAuth';
import { shortAddress, type RobinhoodAccountState, type WalletAssetBalance } from './useRobinhoodAccount';

type AccountDrawerProps = {
  account: RobinhoodAccountState;
  open: boolean;
  onClose: () => void;
};

type DrawerTab = 'balances' | 'transfer' | 'history';
type TransferMode = 'deposit' | 'withdraw';

type DisplaySession = {
  authenticated: boolean;
  persistence: { provider: 'd1'; status: 'ready' | 'authentication-required' };
  user: { displayName: string; email: string | null } | null;
};

type VaultHistoryItem = {
  id: string;
  type: 'deposit' | 'withdraw';
  asset: string;
  amount: string;
  status: 'confirmed' | 'pending' | 'failed';
  timestamp: string;
  transactionHash: string;
};

type VaultHistoryResponse = {
  configured: boolean;
  indexed: boolean;
  items: VaultHistoryItem[];
  message?: string;
};

type HistoryState = {
  key: string;
  response: VaultHistoryResponse;
};

const drawerTabs: { id: DrawerTab; label: string }[] = [
  { id: 'balances', label: 'Balances' },
  { id: 'transfer', label: 'Deposit / Withdraw' },
  { id: 'history', label: 'History' },
];

function assetValue(asset: WalletAssetBalance) {
  if (!asset.configured || asset.status === 'not-found') return 'Not on network';
  if (asset.status === 'loading') return 'Refreshing…';
  if (asset.status === 'error') return 'Retry required';
  if (asset.status !== 'live' || asset.balance === undefined) return '—';
  return `${asset.balance} ${asset.symbol}`;
}

function assetStatus(asset: WalletAssetBalance) {
  if (!asset.configured || asset.status === 'not-found') return 'Contract not detected';
  if (asset.status === 'live') return 'Live onchain balance';
  if (asset.status === 'error') return 'Chain read needs retry';
  if (asset.status === 'loading') return 'Reading Robinhood Chain';
  return 'Connect wallet to read';
}

function parseHistoryResponse(value: unknown): VaultHistoryResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.configured !== 'boolean' || typeof candidate.indexed !== 'boolean' || !Array.isArray(candidate.items)) return undefined;

  const items = candidate.items.filter((item): item is VaultHistoryItem => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return typeof record.id === 'string'
      && (record.type === 'deposit' || record.type === 'withdraw')
      && typeof record.asset === 'string'
      && typeof record.amount === 'string'
      && (record.status === 'confirmed' || record.status === 'pending' || record.status === 'failed')
      && typeof record.timestamp === 'string'
      && !Number.isNaN(Date.parse(record.timestamp))
      && typeof record.transactionHash === 'string'
      && /^0x[a-fA-F0-9]{64}$/.test(record.transactionHash);
  });

  if (items.length !== candidate.items.length) return undefined;
  return {
    configured: candidate.configured,
    indexed: candidate.indexed,
    items,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
  };
}

export default function AccountDrawer({ account, open, onClose }: AccountDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>('balances');
  const [mode, setMode] = useState<TransferMode>('deposit');
  const [selectedAsset, setSelectedAsset] = useState<'ETH' | 'USDG'>('USDG');
  const [amount, setAmount] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [session, setSession] = useState<DisplaySession>();
  const [historyState, setHistoryState] = useState<HistoryState>();
  const {
    requestReady: authReady,
    authenticated: privyAuthenticated,
    isModalOpen: privyModalOpen,
    authFetch,
  } = useAventaAuth();
  const portalRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const authOpenRef = useRef(false);
  const privyModalOpenRef = useRef(false);
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS?.trim();
  const vaultConfigured = Boolean(vaultAddress && /^0x[a-fA-F0-9]{40}$/.test(vaultAddress));
  const currentAsset = account.assets.find((asset) => asset.symbol === selectedAsset);
  const maxDepositAmount = currentAsset?.status === 'live' && currentAsset.balance && /^\d+(?:\.\d+)?$/.test(currentAsset.balance)
    ? currentAsset.balance
    : undefined;
  const historyKey = account.address ? account.address.toLowerCase() : '';
  const historyScopeKey = `${historyKey}:${privyAuthenticated ? 'privy' : 'fallback'}`;
  const history = historyState?.key === historyScopeKey ? historyState.response : undefined;
  const historyLoading = Boolean(open && tab === 'history' && historyKey && historyState?.key !== historyScopeKey);
  const liveAssetCount = account.assets.filter((asset) => asset.status === 'live').length;
  const balanceFeedLabel = account.assets.some((asset) => asset.status === 'loading')
    ? 'REFRESHING ONCHAIN'
    : liveAssetCount > 0
      ? `${liveAssetCount} LIVE ONCHAIN`
      : 'CHAIN READ NEEDS RETRY';

  useEffect(() => {
    authOpenRef.current = authOpen;
  }, [authOpen]);

  useEffect(() => {
    privyModalOpenRef.current = privyModalOpen;
  }, [privyModalOpen]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const inerted = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portalRef.current)
      .map((element) => ({ element, inert: element.inert }));
    inerted.forEach(({ element }) => { element.inert = true; });
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (authOpenRef.current || privyModalOpenRef.current) return;
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
      document.body.style.overflow = previousOverflow;
      inerted.forEach(({ element, inert }) => { element.inert = inert; });
      document.removeEventListener('keydown', handleKeyDown);
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected && previousFocus.getClientRects().length > 0) previousFocus.focus();
      else document.querySelector<HTMLButtonElement>('.menu-trigger')?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !authReady) return;
    const controller = new AbortController();
    void authFetch('/api/session', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<DisplaySession> : Promise.reject())
      .then(setSession)
      .catch(() => undefined);
    return () => controller.abort();
  }, [authFetch, authReady, open, privyAuthenticated]);

  useEffect(() => {
    if (!open || tab !== 'history' || !historyKey || historyState?.key === historyScopeKey) return;
    const controller = new AbortController();
    void authFetch(`/api/account/history?address=${encodeURIComponent(historyKey)}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('History request failed.');
        const parsed = parseHistoryResponse(await response.json());
        if (!parsed) throw new Error('History response was malformed.');
        return parsed;
      })
      .then((response) => {
        if (!controller.signal.aborted) setHistoryState({ key: historyScopeKey, response });
      })
      .catch((historyError: unknown) => {
        if ((historyError as Error).name !== 'AbortError' && !controller.signal.aborted) {
          setHistoryState({
            key: historyScopeKey,
            response: { configured: vaultConfigured, indexed: false, items: [], message: 'Verified history could not refresh. Try again later.' },
          });
        }
      });
    return () => controller.abort();
  }, [authFetch, historyKey, historyScopeKey, historyState?.key, open, privyAuthenticated, tab, vaultConfigured]);

  const updatedLabel = useMemo(() => {
    if (!account.updatedAt) return 'Awaiting wallet';
    return `Updated ${new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(account.updatedAt)}`;
  }, [account.updatedAt]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    const nextTab = drawerTabs[nextIndex];
    if (nextTab) setTab(nextTab.id);
    buttons[nextIndex]?.focus();
  };

  const handleAmountChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextAmount = event.target.value.replace(/[^0-9.]/g, '');
    if (/^\d*\.?\d*$/.test(nextAmount)) setAmount(nextAmount);
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="account-drawer-portal" ref={portalRef}>
      <div className="account-drawer-overlay" role="presentation" onMouseDown={onClose}>
        <section ref={dialogRef} className="account-drawer" role="dialog" aria-modal="true" aria-labelledby="account-drawer-title" onMouseDown={(event) => event.stopPropagation()}>
          <header className="account-drawer-header">
            <div>
              <span>WALLET / ROBINHOOD CHAIN</span>
              <h2 id="account-drawer-title">Wallet</h2>
            </div>
            <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close account drawer">×</button>
          </header>

          <div className="account-drawer-identity">
            <span className="account-drawer-avatar"><img src="/aventa-mark.png" alt="Aventa" /></span>
            <div><strong>{session?.user?.displayName ?? 'Guest profile'}</strong><small>{account.address ? shortAddress(account.address) : session?.user?.email ?? 'Wallet not connected'}</small></div>
            <button type="button" onClick={() => setAuthOpen(true)}>{privyAuthenticated ? 'Account & sign out' : 'Sign-in options'}</button>
          </div>

          <div className="account-drawer-tabs" role="tablist" aria-label="Account views">
            {drawerTabs.map((item, index) => <button type="button" role="tab" id={`account-tab-${item.id}`} aria-controls={`account-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} onKeyDown={(event) => handleTabKeyDown(event, index)} key={item.id}>{item.label}</button>)}
          </div>

          {!account.address && <div className="account-connect-state" role="tabpanel" id={`account-panel-${tab}`} aria-labelledby={`account-tab-${tab}`}><span>◎</span><strong>Connect a wallet to read live balances</strong><p>Aventa reads balances directly from Robinhood Chain. No sample balance is displayed.</p><button type="button" onClick={account.connect} disabled={account.busy}>{account.busy ? 'Waiting for wallet…' : 'Connect wallet'}</button></div>}
          {account.address && !account.isRobinhoodChain && <div className="account-network-notice"><span>Wallet network differs from Robinhood Chain.</span><button type="button" onClick={account.switchNetwork} disabled={account.busy}>{account.busy ? 'Waiting…' : 'Switch network'}</button></div>}

          {account.address && account.isRobinhoodChain && !account.ownershipVerified && <div className="account-network-notice"><span>Verify wallet ownership before enabling trading.</span><button type="button" onClick={() => void account.verifyOwnership()} disabled={account.busy || account.verificationBusy}>{account.busy || account.verificationBusy ? 'Waiting for signature…' : 'Verify wallet'}</button></div>}

          {account.address && tab === 'balances' && (
            <div className="account-balances-view" role="tabpanel" id="account-panel-balances" aria-labelledby="account-tab-balances">
              <div className="account-live-row"><span><i />{balanceFeedLabel}</span><small>{updatedLabel}</small><button type="button" onClick={() => void account.refresh()} aria-label="Refresh wallet balances">↻</button></div>
              <div className="account-asset-list">
                {account.assets.map((asset) => (
                  <article key={asset.symbol}>
                    <TokenIcon symbol={asset.symbol} variant="branded" size={39} fallback={asset.symbol.slice(0, 1)} />
                    <div>
                      <strong>{asset.symbol}</strong>
                      <small title={asset.contractAddress}>{asset.identity}{asset.contractAddress ? ` · ${shortAddress(asset.contractAddress)}` : ''}</small>
                    </div>
                    <div><strong>{assetValue(asset)}</strong><small>{assetStatus(asset)}</small></div>
                  </article>
                ))}
              </div>
              <div className="account-balance-disclosure"><strong>Wallet balance</strong><p>These values are read from Robinhood Chain and refresh every 12 seconds. Trading collateral activates after a verified venue account is linked.</p></div>
              <button className="account-wallet-disconnect" type="button" onClick={() => void account.disconnect()} disabled={account.busy}>Disconnect wallet</button>
            </div>
          )}

          {account.address && account.isRobinhoodChain && tab === 'transfer' && (
            <div className="account-transfer-view" role="tabpanel" id="account-panel-transfer" aria-labelledby="account-tab-transfer">
              <div className="account-transfer-mode">{(['deposit', 'withdraw'] as TransferMode[]).map((item) => <button type="button" aria-pressed={mode === item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)} key={item}>{item === 'deposit' ? 'Deposit' : 'Withdraw'}</button>)}</div>
              <span className="account-field-label">Asset</span>
              <div className="account-asset-selector">
                {account.assets.map((asset) => <button type="button" aria-pressed={selectedAsset === asset.symbol} className={selectedAsset === asset.symbol ? 'active' : ''} onClick={() => setSelectedAsset(asset.symbol)} key={asset.symbol}><TokenIcon symbol={asset.symbol} variant="branded" size={22} fallback={asset.symbol.slice(0, 1)} /><span>{asset.symbol}</span><small>{asset.balance ?? '—'}</small></button>)}
              </div>
              <label className="account-amount-field"><span><b>Amount</b><small>{mode === 'deposit' ? `Wallet available ${currentAsset?.balance ?? '—'} ${selectedAsset}` : `Vault available — ${selectedAsset}`}</small></span><div><input inputMode="decimal" value={amount} onChange={handleAmountChange} placeholder="0.00" aria-label={`${mode} amount`} /><button type="button" disabled={mode !== 'deposit' || !maxDepositAmount} onClick={() => maxDepositAmount && setAmount(maxDepositAmount)}>MAX</button><strong>{selectedAsset}</strong></div></label>
              <div className="account-transfer-summary"><div><span>Route</span><strong>{mode === 'deposit' ? 'Wallet → Aventa vault' : 'Aventa vault → Wallet'}</strong></div><div><span>Network</span><strong>Robinhood Chain · 4663</strong></div><div><span>Vault</span><strong>{vaultConfigured ? 'Address configured' : 'Not configured'}</strong></div></div>
              <button className="account-transfer-submit" type="button" disabled>{vaultConfigured ? 'Audited vault adapter required' : 'Vault configuration required'}</button>
              <p className="account-transfer-warning">No approval or transaction request will be sent until the audited vault contract, ABI, limits, and transaction simulation are integrated.</p>
            </div>
          )}

          {account.address && tab === 'history' && (
            <div className="account-history-view" role="tabpanel" id="account-panel-history" aria-labelledby="account-tab-history">
              <div className="account-history-head"><span>VAULT ACTIVITY</span><small>{historyLoading ? 'Refreshing…' : `${history?.items.length ?? 0} events`}</small></div>
              {history?.items.map((item) => <article key={item.id}><span className={`history-direction ${item.type}`}>{item.type === 'deposit' ? '↓' : '↑'}</span><div><strong>{item.type === 'deposit' ? 'Deposit' : 'Withdraw'} · {item.asset}</strong><small>{new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.timestamp))}</small></div><div><strong>{item.amount}</strong><a href={`https://robinhoodchain.blockscout.com/tx/${item.transactionHash}`} target="_blank" rel="noreferrer">{item.status} ↗</a></div></article>)}
              {!historyLoading && !history?.items.length && <div className="account-history-empty"><span>◎</span><strong>No verified history yet</strong><p>{history?.message ?? (vaultConfigured ? 'No verified vault events were returned for this wallet.' : 'History activates after a verified vault and indexer are configured.')}</p></div>}
            </div>
          )}

          {account.error && <p className="account-drawer-error" role="alert">{account.error}</p>}
          <footer className="account-drawer-footer"><span><i />Robinhood Chain</span><strong>{session?.persistence.status === 'ready' ? 'Profile synced · ' : ''}Self-custodial · Chain ID 4663</strong></footer>
        </section>
      </div>
      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>,
    document.body,
  );
}
