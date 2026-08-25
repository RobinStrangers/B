'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthSheet from '../components/AuthSheet';
import { AssetLogo } from '../components/AssetLogo';
import InternalLink from '../components/InternalLink';
import { useAventaAuth } from '../components/useAventaAuth';
import { maxLeverageForMarket } from '../lib/market-risk';
import { categoryLabels, formatPair, markets } from '../markets';
import { useRobinhoodAccount } from '../components/useRobinhoodAccount';
import { useAventaExecution } from '../components/useAventaExecution';
import { agentExecutionRequest, agentIntentIdempotencyKey, type AgentExecutionRequest } from '../lib/agent-execution';

type Conversation = {
  id: string;
  title: string;
  status: 'active' | 'archived';
  agentVersion: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type AgentMessage = {
  id: string;
  conversationId: string;
  sequenceNo: number;
  role: 'user' | 'assistant';
  status: 'complete' | 'failed';
  content: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  requestId: string;
  modelId: string | null;
  agentVersion: string;
  createdAt: string;
};

type AgentIntent = {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  intentType: string;
  summary: string;
  status: 'needs_input' | 'proposed' | 'acknowledged' | 'rejected' | 'expired' | 'blocked' | 'completed';
  executionMode: 'record_only';
  payload: Record<string, unknown>;
  payloadSchemaVersion: number;
  payloadHash: string;
  risk: Record<string, unknown>;
  requestId: string;
  policyVersion: string;
  version: number;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ConversationDetail = {
  conversation: Conversation;
  messages: AgentMessage[];
  intents: AgentIntent[];
  replayed?: boolean;
};

type Capabilities = {
  execution: {
    state: 'locked' | 'remote-readiness-required';
    code: string;
    canDraft: boolean;
    canReview: boolean;
    canPrepare: boolean;
    canSubmit: boolean;
    message: string;
  };
  intelligence: {
    mode: string;
    modelServiceConnected: boolean;
    modelId: string;
    description: string;
  };
  supportedIntents: string[];
  limits: {
    messageCharacters: number;
    messagesPerMinute: number;
    messagesPerConversation: number;
    activeConversations: number;
  };
};

const quickPrompts = [
  'Open a BTC / USDT long with 100 USDG collateral at 5x isolated',
  'Compare BTC and ETH leverage',
  'Close 50% of my ETH / USDT position',
  'Show me my account balances',
];

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message ? message : fallback;
}

function textArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function fieldLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export default function AgentPage() {
  const { authenticated, requestReady, authFetch, user } = useAventaAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [marketId, setMarketId] = useState('btc-usdt');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState('');
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const activeConversationRef = useRef<string | null>(null);
  const conversationLoadRef = useRef(0);
  const sessionOperationRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const reviewInFlightRef = useRef(false);
  const pendingTurnRef = useRef<{ key: string; clientRequestId: string } | null>(null);
  const selectedMarket = markets.find((market) => market.id === marketId) ?? markets[0];
  const wallet = useRobinhoodAccount();
  const execution = useAventaExecution(marketId);
  const latestIntent = detail?.intents.at(-1) ?? null;
  const displayName = user?.email?.address
    ?? user?.google?.email
    ?? user?.twitter?.username
    ?? 'Privy account';

  const requestJson = useCallback(async <T,>(url: string, init: RequestInit = {}) => {
    const response = await authFetch(url, { cache: 'no-store', ...init });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(payload, 'The Signal Desk request could not be completed.'));
    return payload as T;
  }, [authFetch]);

  const loadConversation = useCallback(async (conversationId: string) => {
    if (sessionOperationRef.current || turnInFlightRef.current || reviewInFlightRef.current) return;
    sessionOperationRef.current = true;
    const requestSequence = ++conversationLoadRef.current;
    setSwitching(true);
    setError('');
    try {
      const nextDetail = await requestJson<ConversationDetail>(
        `/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`,
      );
      if (requestSequence !== conversationLoadRef.current) return;
      activeConversationRef.current = conversationId;
      setDetail(nextDetail);
      setActiveConversationId(conversationId);
    } catch (requestError) {
      if (requestSequence === conversationLoadRef.current) {
        setError(requestError instanceof Error ? requestError.message : 'The signal session could not be loaded.');
      }
    } finally {
      if (requestSequence === conversationLoadRef.current) setSwitching(false);
      sessionOperationRef.current = false;
    }
  }, [requestJson]);

  const createConversation = useCallback(async () => {
    if (sessionOperationRef.current || turnInFlightRef.current || reviewInFlightRef.current) return null;
    sessionOperationRef.current = true;
    const requestSequence = ++conversationLoadRef.current;
    setCreating(true);
    setError('');
    try {
      const created = await requestJson<{ conversation: Conversation }>('/api/agent/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (requestSequence !== conversationLoadRef.current) return null;
      activeConversationRef.current = created.conversation.id;
      setConversations((current) => [created.conversation, ...current]);
      setActiveConversationId(created.conversation.id);
      setDetail({ conversation: created.conversation, messages: [], intents: [] });
      setDraft('');
      pendingTurnRef.current = null;
      return created.conversation;
    } catch (requestError) {
      if (requestSequence === conversationLoadRef.current) {
        setError(requestError instanceof Error ? requestError.message : 'A new signal session could not be created.');
      }
      return null;
    } finally {
      if (requestSequence === conversationLoadRef.current) setCreating(false);
      sessionOperationRef.current = false;
    }
  }, [requestJson]);

  useEffect(() => {
    if (!authenticated) {
      activeConversationRef.current = null;
      pendingTurnRef.current = null;
      const resetState = window.setTimeout(() => {
        setLoadedUserId(null);
        setSwitching(false);
        setCreating(false);
      }, 0);
      return () => window.clearTimeout(resetState);
    }

    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError('');
      try {
        const [capabilityPayload, conversationPayload] = await Promise.all([
          requestJson<Capabilities>('/api/agent/capabilities'),
          requestJson<{ conversations: Conversation[] }>('/api/agent/conversations'),
        ]);
        if (cancelled) return;
        setCapabilities(capabilityPayload);
        let nextConversations = conversationPayload.conversations;
        if (!nextConversations.length) {
          const created = await requestJson<{ conversation: Conversation }>('/api/agent/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          nextConversations = [created.conversation];
        }
        if (cancelled) return;
        setConversations(nextConversations);
        const firstId = nextConversations[0].id;
        const firstDetail = await requestJson<ConversationDetail>(
          `/api/agent/conversations/${encodeURIComponent(firstId)}/messages`,
        );
        if (cancelled) return;
        activeConversationRef.current = firstId;
        setActiveConversationId(firstId);
        setDetail(firstDetail);
      } catch (requestError) {
        if (!cancelled) {
          setCapabilities(null);
          setConversations([]);
          activeConversationRef.current = null;
          setActiveConversationId(null);
          setDetail(null);
          setError(requestError instanceof Error ? requestError.message : 'Signal Desk could not initialize.');
        }
      } finally {
        if (!cancelled) {
          setLoadedUserId(user?.id ?? null);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      conversationLoadRef.current += 1;
      sessionOperationRef.current = false;
    };
  }, [authenticated, requestJson, user?.id]);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    transcriptEndRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
  }, [detail?.messages.length]);

  const submitDraft = async () => {
    const text = draft.trim();
    const conversationId = activeConversationId;
    const requestMarketId = marketId;
    if (!text || !conversationId || turnInFlightRef.current || sessionOperationRef.current || reviewInFlightRef.current) return;
    turnInFlightRef.current = true;
    setSending(true);
    setError('');
    const turnKey = JSON.stringify([conversationId, requestMarketId, text]);
    const pendingTurn = pendingTurnRef.current?.key === turnKey
      ? pendingTurnRef.current
      : { key: turnKey, clientRequestId: `web_${crypto.randomUUID().replace(/-/g, '')}` };
    pendingTurnRef.current = pendingTurn;
    try {
      const nextDetail = await requestJson<ConversationDetail>(
        `/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientRequestId: pendingTurn.clientRequestId,
            text,
            context: { marketId: requestMarketId },
          }),
        },
      );
      if (activeConversationRef.current !== conversationId) return;
      pendingTurnRef.current = null;
      setDraft((current) => current.trim() === text ? '' : current);
      setDetail(nextDetail);
      setConversations((current) => [
        nextDetail.conversation,
        ...current.filter((conversation) => conversation.id !== nextDetail.conversation.id),
      ]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The signal could not be recorded.');
    } finally {
      turnInFlightRef.current = false;
      setSending(false);
    }
  };

  const reviewIntent = async (decision: 'acknowledge' | 'reject') => {
    const intent = latestIntent;
    const conversationId = activeConversationId;
    if (!intent || !conversationId || reviewInFlightRef.current || sessionOperationRef.current || turnInFlightRef.current) return;
    reviewInFlightRef.current = true;
    setReviewing(true);
    setError('');
    try {
      const payload = await requestJson<{ intent: AgentIntent }>(
        `/api/agent/intents/${encodeURIComponent(intent.id)}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            payloadHash: intent.payloadHash,
            version: intent.version,
          }),
        },
      );
      if (activeConversationRef.current !== conversationId) return;
      setDetail((current) => current ? {
        ...current,
        intents: current.intents.map((intent) => intent.id === payload.intent.id ? payload.intent : intent),
      } : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The intent review could not be saved.');
    } finally {
      reviewInFlightRef.current = false;
      setReviewing(false);
    }
  };

  const archiveCurrent = async () => {
    const conversationId = activeConversationId;
    if (!conversationId || sessionOperationRef.current || turnInFlightRef.current || reviewInFlightRef.current) return;
    sessionOperationRef.current = true;
    const requestSequence = ++conversationLoadRef.current;
    setSwitching(true);
    setError('');
    try {
      await requestJson(`/api/agent/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      const remaining = conversations.filter((conversation) => conversation.id !== conversationId);
      let nextConversation: Conversation;
      let nextDetail: ConversationDetail;
      if (remaining.length) {
        nextConversation = remaining[0];
        nextDetail = await requestJson<ConversationDetail>(
          `/api/agent/conversations/${encodeURIComponent(nextConversation.id)}/messages`,
        );
      } else {
        const created = await requestJson<{ conversation: Conversation }>('/api/agent/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        nextConversation = created.conversation;
        remaining.push(nextConversation);
        nextDetail = { conversation: nextConversation, messages: [], intents: [] };
      }
      if (requestSequence !== conversationLoadRef.current) return;
      activeConversationRef.current = nextConversation.id;
      pendingTurnRef.current = null;
      setConversations(remaining);
      setActiveConversationId(nextConversation.id);
      setDetail(nextDetail);
      setDraft('');
    } catch (requestError) {
      if (requestSequence === conversationLoadRef.current) {
        setError(requestError instanceof Error ? requestError.message : 'The session could not be archived.');
      }
    } finally {
      if (requestSequence === conversationLoadRef.current) setSwitching(false);
      sessionOperationRef.current = false;
    }
  };

  const executableIntent = useMemo<AgentExecutionRequest | null>(() => {
    if (!latestIntent || latestIntent.status !== 'acknowledged') return null;
    try {
      return agentExecutionRequest(latestIntent);
    } catch {
      return null;
    }
  }, [latestIntent]);

  const executeLatestIntent = async () => {
    if (!latestIntent || !executableIntent || executing) return;
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
    if (!execution.readiness.canSubmit && executableIntent.action === 'order') {
      setError('Activate your user-owned Lighter trading authority in the terminal before executing this intent.');
      return;
    }
    if (executableIntent.action === 'close' && !execution.readiness.canClose) {
      setError('The signer is not ready to submit a reduce-only close for this account.');
      return;
    }
    if (executableIntent.action === 'cancel' && !execution.readiness.canCancel) {
      setError('The signer is not ready to submit a cancellation for this account.');
      return;
    }
    setExecuting(true);
    setError('');
    try {
      await execution.execute(
        executableIntent.action,
        `/api/agent/intents/${encodeURIComponent(latestIntent.id)}/execute`,
        executableIntent.payload,
        wallet.address,
        wallet.signMessage,
        agentIntentIdempotencyKey(latestIntent.id),
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The signed intent was not submitted.');
    } finally {
      setExecuting(false);
    }
  };

  const interactionLocked = loading || switching || creating || sending || reviewing || executing;

  const intentFields = useMemo(
    () => latestIntent ? Object.entries(latestIntent.payload).filter(([key, value]) => key !== 'defaultsApplied' && value !== null) : [],
    [latestIntent],
  );
  const policyDefaults = textArray(latestIntent?.payload.defaultsApplied);
  const riskChecks = textArray(latestIntent?.risk.checks);
  const riskWarnings = textArray(latestIntent?.risk.warnings);
  const navigationTarget = typeof latestIntent?.payload.target === 'string'
    && latestIntent.payload.target.startsWith('/')
    ? latestIntent.payload.target
    : null;

  return (
    <main className="agent-page-shell">
      <header className="agent-page-header">
        <InternalLink className="agent-page-brand" href="/trade" aria-label="Aventa terminal">
          <span className="agent-page-brand-mark"><img src="/aventa-mark.png" alt="" /></span>
          <span><strong>AVENTA</strong><small>SIGNAL DESK</small></span>
        </InternalLink>
        <nav className="agent-page-nav" aria-label="Signal Desk navigation">
          <InternalLink href="/trade">Terminal</InternalLink>
          <InternalLink href="/markets">Markets</InternalLink>
          <InternalLink href="/trade?account=1">Wallet</InternalLink>
        </nav>
        <button className="agent-account-button" type="button" onClick={() => setAuthOpen(true)}>
          <span aria-hidden="true" />
          {authenticated ? 'Account' : 'Sign in'}
        </button>
      </header>

      {!requestReady || (authenticated && (loadedUserId !== user?.id || (loading && !detail))) ? (
        <section className="agent-loading-state" aria-live="polite">
          <div className="agent-loading-wave" aria-hidden="true">{Array.from({ length: 17 }, (_, index) => <i key={index} />)}</div>
          <p>Opening your private Signal Desk…</p>
        </section>
      ) : !authenticated ? (
        <section className="agent-auth-gate">
          <div className="agent-auth-copy">
            <p className="agent-kicker">ACCOUNT-SCOPED INTENT / PRIVY REQUIRED</p>
            <h1>Ask the signal.<br /><em>Keep the boundary.</em></h1>
            <p>
              Turn plain-English market requests into structured, reviewable intents. Every session belongs to your verified account; executable intents still require an acknowledged payload and a fresh wallet signature.
            </p>
            <button type="button" onClick={() => setAuthOpen(true)}>
              Enter your Signal Desk <span aria-hidden="true">↗</span>
            </button>
          </div>
          <div className="agent-auth-orbit" aria-hidden="true">
            <div className="agent-orbit-ring agent-orbit-ring-one" />
            <div className="agent-orbit-ring agent-orbit-ring-two" />
            <div className="agent-orbit-core"><small>INTENT</small><img src="/aventa-mark.png" alt="" /><span>SIGNED FLOW</span></div>
            <span className="agent-orbit-note agent-orbit-note-a">01 / READ</span>
            <span className="agent-orbit-note agent-orbit-note-b">02 / REVIEW</span>
            <span className="agent-orbit-note agent-orbit-note-c">03 / LOCK</span>
          </div>
          <div className="agent-auth-rail">
            <span>Natural-language intent</span><i />
            <span>Deterministic policy</span><i />
            <span>Human review</span><i />
            <span>Wallet-signed execution</span>
          </div>
        </section>
      ) : (
        <>
          <section className="agent-page-intro">
            <div>
              <p className="agent-kicker">AVENTA / SIGNAL DESK</p>
              <h1>Ask the signal. <em>Keep the boundary.</em></h1>
            </div>
            <div className="agent-intro-status">
              <span aria-hidden="true" />
              <div><strong>STRUCTURED INTELLIGENCE</strong><small>{execution.readiness.canSubmit ? 'SIGNED EXECUTION READY' : 'EXECUTION GATED'}</small></div>
            </div>
          </section>

          <section className="agent-desk-grid" aria-busy={interactionLocked}>
            <aside className="agent-context-rail" aria-label="Market and session context">
              <div className="agent-rail-heading"><span>01</span><strong>CONTEXT</strong></div>
              <label className="agent-market-selector">
                <span>Reference market</span>
                <div>
                  <AssetLogo market={selectedMarket} size={31} />
                  <span><strong>{formatPair(selectedMarket)}</strong><small>{categoryLabels[selectedMarket.category]}</small></span>
                  <select value={marketId} onChange={(event) => setMarketId(event.target.value)} aria-label="Reference market" disabled={interactionLocked}>
                    {markets.map((market) => <option value={market.id} key={market.id}>{formatPair(market)}</option>)}
                  </select>
                  <b aria-hidden="true">⌄</b>
                </div>
              </label>
              <dl className="agent-market-facts">
                <div><dt>Source</dt><dd>{selectedMarket.source}</dd></div>
                <div><dt>Session</dt><dd>{selectedMarket.session}</dd></div>
                <div><dt>Reference cap</dt><dd>{maxLeverageForMarket(selectedMarket)}×</dd></div>
                <div><dt>Settlement</dt><dd>Venue authorization required</dd></div>
              </dl>

              <div className="agent-session-heading">
                <span>Signal sessions</span>
                <button type="button" onClick={() => void createConversation()} disabled={interactionLocked} aria-label="Start a new signal session">+</button>
              </div>
              <div className="agent-session-list">
                {conversations.map((conversation, index) => (
                  <button
                    type="button"
                    className={conversation.id === activeConversationId ? 'active' : ''}
                    key={conversation.id}
                    onClick={() => void loadConversation(conversation.id)}
                    disabled={interactionLocked || conversation.id === activeConversationId}
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <span><strong>{conversation.title}</strong><small>{formatTime(conversation.updatedAt)}</small></span>
                  </button>
                ))}
              </div>
              <button className="agent-archive-button" type="button" onClick={() => void archiveCurrent()} disabled={!activeConversationId || interactionLocked}>
                Archive current session
              </button>
              <p className="agent-private-note"><span aria-hidden="true">●</span> Private to {displayName}</p>
            </aside>

            <section className="agent-transcript-panel" aria-label="Signal transcript">
              <header className="agent-panel-header">
                <div><span>02</span><div><strong>SIGNAL TRANSCRIPT</strong><small>{detail?.conversation.title ?? 'New signal session'}</small></div></div>
                <span className="agent-model-chip">POLICY / V1</span>
              </header>

              <div className="agent-transcript" role="log" aria-live="polite" aria-relevant="additions text">
                {!detail?.messages.length ? (
                  <div className="agent-empty-transcript">
                    <div className="agent-empty-pulse" aria-hidden="true"><i /><i /><i /><i /><i /></div>
                    <span>READY FOR INPUT</span>
                    <h2>State an intent.<br />Review every visible default.</h2>
                    <p>Try a market question or create a precise order intent. Supplied values and policy defaults remain visible in the evidence rack; an acknowledged executable payload still needs your wallet signature.</p>
                    <div className="agent-quick-prompts">
                      {quickPrompts.map((prompt, index) => (
                        <button type="button" key={prompt} onClick={() => setDraft(prompt)} disabled={interactionLocked || !activeConversationId}>
                          <span>{String(index + 1).padStart(2, '0')}</span>{prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : detail.messages.map((message) => (
                  <article className={`agent-message agent-message-${message.role}`} key={message.id}>
                    <div className="agent-message-index">{String(message.sequenceNo).padStart(2, '0')}</div>
                    <div className="agent-message-body">
                      <div className="agent-message-meta">
                        <strong>{message.role === 'user' ? 'YOU / INTENT' : 'AVENTA / POLICY'}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <p>{message.content}</p>
                      {message.role === 'assistant' && <small>Structured response · no price inference · no transaction submitted</small>}
                    </div>
                  </article>
                ))}
                {sending && (
                  <article className="agent-message agent-message-assistant agent-message-pending">
                    <div className="agent-message-index">••</div>
                    <div className="agent-message-body"><div className="agent-thinking-wave" aria-label="Reviewing intent">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div></div>
                  </article>
                )}
                <div ref={transcriptEndRef} />
              </div>

              {error && <p className="agent-error-banner" role="alert"><span>!</span>{error}</p>}

              <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); void submitDraft(); }}>
                <div className="agent-composer-label"><span>INTENT INPUT</span><small>Enter to send · Shift + Enter for a new line</small></div>
                <div className="agent-composer-field">
                  <span className="agent-composer-mark" aria-hidden="true"><img src="/aventa-mark.png" alt="" /></span>
                  <textarea
                    value={draft}
                    maxLength={capabilities?.limits.messageCharacters ?? 1200}
                    rows={2}
                    aria-label="Message your Signal Desk"
                    placeholder="Example: Open a BTC / USDT long with 100 USDG collateral at 5x isolated"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submitDraft();
                      }
                    }}
                  />
                  <button type="submit" disabled={!draft.trim() || !activeConversationId || interactionLocked} aria-label="Send intent">{sending ? '•••' : '↗'}</button>
                </div>
                <div className="agent-composer-foot"><span>{draft.length} / {capabilities?.limits.messageCharacters ?? 1200}</span><span>REVIEW · ACKNOWLEDGE · SIGN</span></div>
              </form>
            </section>

            <aside className="agent-evidence-rack" aria-label="Intent and risk evidence">
              <div className="agent-rail-heading"><span>03</span><strong>EVIDENCE / INTENT</strong></div>
              {latestIntent ? (
                <article className="agent-intent-card">
                  <div className="agent-intent-title"><span className={`agent-intent-state state-${latestIntent.status}`}>{latestIntent.status.replace('_', ' ')}</span><small>{latestIntent.intentType.replaceAll('_', ' ')}</small></div>
                  <h2>{latestIntent.summary}</h2>
                  <dl className="agent-intent-fields">
                    {intentFields.map(([key, value]) => (
                      <div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(value)}</dd></div>
                    ))}
                  </dl>
                  {policyDefaults.length > 0 && (
                    <div className="agent-policy-defaults">
                      <span>POLICY DEFAULTS / REVIEW REQUIRED</span>
                      <p>{policyDefaults.join(' · ')}</p>
                    </div>
                  )}
                  <div className="agent-hash-line"><span>Payload v{latestIntent.payloadSchemaVersion}</span><code title={latestIntent.payloadHash}>{shortHash(latestIntent.payloadHash)}</code></div>
                  {(latestIntent.status === 'proposed' || latestIntent.status === 'acknowledged') && (
                    <div className="agent-review-actions">
                      {latestIntent.status === 'proposed' && <button className="primary" type="button" onClick={() => void reviewIntent('acknowledge')} disabled={interactionLocked}>Acknowledge intent</button>}
                      {latestIntent.status === 'acknowledged' && executableIntent && <button className="primary" type="button" onClick={() => void executeLatestIntent()} disabled={interactionLocked}>{executing ? 'Awaiting wallet…' : 'Execute signed intent'}</button>}
                      <button type="button" onClick={() => void reviewIntent('reject')} disabled={interactionLocked}>Reject</button>
                    </div>
                  )}
                  {navigationTarget && <InternalLink className="agent-route-link" href={navigationTarget}>Open verified route <span>↗</span></InternalLink>}
                </article>
              ) : (
                <div className="agent-empty-intent"><span>∅</span><strong>No structured intent yet</strong><p>Your latest reviewable payload will appear here.</p></div>
              )}

              <article className="agent-risk-card">
                <header><span>RISK LEDGER</span><small>{String(riskChecks.length + riskWarnings.length).padStart(2, '0')} NOTES</small></header>
                {!riskChecks.length && !riskWarnings.length ? (
                  <p>No risk record has been generated in this session.</p>
                ) : (
                  <ul>
                    {riskChecks.map((check) => <li className="check" key={check}><span>✓</span>{check}</li>)}
                    {riskWarnings.map((warning) => <li key={warning}><span>!</span>{warning}</li>)}
                  </ul>
                )}
              </article>

              <article className="agent-execution-lock">
                <div className="agent-lock-mark" aria-hidden="true"><span>{execution.readiness.canSubmit ? '✓' : '×'}</span></div>
                <div><small>EXECUTION STATE</small><strong>{execution.readiness.canSubmit ? 'READY FOR SIGNATURE' : 'GATED'}</strong><p>{execution.error || execution.notice || execution.readiness.message || capabilities?.execution.message}</p></div>
                {execution.readiness.canSubmit ? <button type="button" disabled={!executableIntent || interactionLocked} onClick={() => void executeLatestIntent()}>{executableIntent ? 'Sign exact intent' : 'Acknowledge an executable intent'}</button> : <InternalLink className="agent-route-link" href="/trade">Activate in terminal <span>↗</span></InternalLink>}
              </article>

              <div className="agent-intelligence-note">
                <span>{capabilities?.intelligence.modelServiceConnected ? 'MODEL CONNECTED' : 'MODEL SERVICE NOT CONNECTED'}</span>
                <p>{capabilities?.intelligence.description ?? 'Deterministic intent policy loads after account verification.'}</p>
              </div>
            </aside>
          </section>
        </>
      )}

      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </main>
  );
}
