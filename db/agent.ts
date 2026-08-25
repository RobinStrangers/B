import type { AgentIntentAnalysis, AgentIntentStatus, AgentIntentType } from '@/app/lib/agent-intent';
import { getDatabase } from './index';

const MAX_ACTIVE_CONVERSATIONS = 30;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const MAX_MESSAGES_PER_MINUTE = 20;
const AGENT_VERSION = 'intent-policy-v1';
const MODEL_ID = 'structured-policy-v1';

export class AgentResourceNotFoundError extends Error {
  constructor() {
    super('The requested Signal Desk resource was not found.');
    this.name = 'AgentResourceNotFoundError';
  }
}

export class AgentConflictError extends Error {
  constructor(message = 'The Signal Desk state changed. Refresh and try again.') {
    super(message);
    this.name = 'AgentConflictError';
  }
}

export class AgentRateLimitError extends Error {
  constructor(message = 'The Signal Desk request limit was reached. Wait a moment and try again.') {
    super(message);
    this.name = 'AgentRateLimitError';
  }
}

type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  status: 'active' | 'archived';
  agent_version: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  sequence_no: number;
  role: 'user' | 'assistant';
  status: 'complete' | 'failed';
  content_text: string;
  metadata_json: string;
  content_hash: string;
  client_request_id_hash: string | null;
  request_id: string;
  model_id: string | null;
  agent_version: string;
  created_at: number;
};

type IntentRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  source_message_id: string;
  intent_type: AgentIntentType;
  summary_text: string;
  status: 'needs_input' | 'proposed' | 'acknowledged' | 'rejected' | 'expired' | 'blocked' | 'completed';
  execution_mode: 'record_only';
  payload_json: string;
  payload_schema_version: number;
  payload_hash: string;
  risk_json: string;
  request_id: string;
  policy_version: string;
  version: number;
  expires_at: number | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
};

export type AgentConversation = ReturnType<typeof mapConversation>;
export type AgentMessage = ReturnType<typeof mapMessage>;
export type AgentFinancialIntent = ReturnType<typeof mapIntent>;

function safeJsonObject(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapConversation(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    agentVersion: row.agent_version,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at * 1000).toISOString() : null,
  };
}

function mapMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequenceNo: row.sequence_no,
    role: row.role,
    status: row.status,
    content: row.content_text,
    metadata: safeJsonObject(row.metadata_json),
    contentHash: row.content_hash,
    requestId: row.request_id,
    modelId: row.model_id,
    agentVersion: row.agent_version,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  };
}

function mapIntent(row: IntentRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    intentType: row.intent_type,
    summary: row.summary_text,
    status: row.status,
    executionMode: row.execution_mode,
    payload: safeJsonObject(row.payload_json),
    payloadSchemaVersion: row.payload_schema_version,
    payloadHash: row.payload_hash,
    risk: safeJsonObject(row.risk_json),
    requestId: row.request_id,
    policyVersion: row.policy_version,
    version: row.version,
    expiresAt: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at * 1000).toISOString() : null,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = Array.from(new Uint8Array(digest));
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

async function ownedConversationRow(userId: string, conversationId: string) {
  return getDatabase().prepare(`
    SELECT id, user_id, title, status, agent_version, created_at, updated_at, archived_at
    FROM agent_conversations
    WHERE id = ? AND user_id = ?
    LIMIT 1
  `).bind(conversationId, userId).first<ConversationRow>();
}

async function ownedIntentRow(userId: string, intentId: string) {
  return getDatabase().prepare(`
    SELECT id, user_id, conversation_id, source_message_id, intent_type, summary_text,
      status, execution_mode, payload_json, payload_schema_version, payload_hash,
      risk_json, request_id, policy_version, version, expires_at, closed_at, created_at, updated_at
    FROM agent_financial_intents
    WHERE id = ? AND user_id = ?
    LIMIT 1
  `).bind(intentId, userId).first<IntentRow>();
}

export async function listAgentConversations(userId: string) {
  const rows = await getDatabase().prepare(`
    SELECT id, user_id, title, status, agent_version, created_at, updated_at, archived_at
    FROM agent_conversations
    WHERE user_id = ? AND status = 'active'
    ORDER BY updated_at DESC, id DESC
    LIMIT 30
  `).bind(userId).all<ConversationRow>();
  return rows.results.map(mapConversation);
}

export async function createAgentConversation(userId: string, title?: string | null) {
  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const id = createId('agc');
  const normalizedTitle = title?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'New signal session';
  const count = await database.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_conversations
    WHERE user_id = ? AND status = 'active'
  `).bind(userId).first<{ count: number }>();

  if (Number(count?.count ?? 0) >= MAX_ACTIVE_CONVERSATIONS) {
    throw new AgentRateLimitError('Archive an existing session before creating another Signal Desk session.');
  }

  await database.batch([
    database.prepare(`
      INSERT INTO agent_conversations
        (id, user_id, title, status, agent_version, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)
    `).bind(id, userId, normalizedTitle, AGENT_VERSION, now, now),
    database.prepare(`
      INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
      VALUES (?, ?, 'agent.conversation.created', ?, ?)
    `).bind(createId('aud'), userId, canonicalJson({ conversationId: id, agentVersion: AGENT_VERSION }), now),
  ]);

  const row = await ownedConversationRow(userId, id);
  if (!row) throw new Error('The Signal Desk session could not be loaded.');
  return mapConversation(row);
}

export async function archiveAgentConversation(userId: string, conversationId: string) {
  const current = await ownedConversationRow(userId, conversationId);
  if (!current) throw new AgentResourceNotFoundError();
  if (current.status === 'archived') return mapConversation(current);

  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  await database.batch([
    database.prepare(`
      UPDATE agent_conversations
      SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'active'
    `).bind(now, now, conversationId, userId),
    database.prepare(`
      INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
      VALUES (?, ?, 'agent.conversation.archived', ?, ?)
    `).bind(createId('aud'), userId, canonicalJson({ conversationId }), now),
  ]);
  const archived = await ownedConversationRow(userId, conversationId);
  if (!archived) throw new AgentResourceNotFoundError();
  return mapConversation(archived);
}

export async function getAgentConversation(userId: string, conversationId: string) {
  const conversation = await ownedConversationRow(userId, conversationId);
  if (!conversation) throw new AgentResourceNotFoundError();

  const database = getDatabase();
  const [messages, intents] = await Promise.all([
    database.prepare(`
      SELECT id, conversation_id, user_id, sequence_no, role, status, content_text,
        metadata_json, content_hash, client_request_id_hash, request_id, model_id, agent_version, created_at
      FROM agent_messages
      WHERE conversation_id = ? AND user_id = ? AND visibility = 'user'
      ORDER BY sequence_no ASC
      LIMIT ${MAX_MESSAGES_PER_CONVERSATION}
    `).bind(conversationId, userId).all<MessageRow>(),
    database.prepare(`
      SELECT id, user_id, conversation_id, source_message_id, intent_type, summary_text,
        status, execution_mode, payload_json, payload_schema_version, payload_hash,
        risk_json, request_id, policy_version, version, expires_at, closed_at, created_at, updated_at
      FROM agent_financial_intents
      WHERE conversation_id = ? AND user_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ${MAX_MESSAGES_PER_CONVERSATION}
    `).bind(conversationId, userId).all<IntentRow>(),
  ]);

  return {
    conversation: mapConversation(conversation),
    messages: messages.results.map(mapMessage),
    intents: intents.results.map(mapIntent),
  };
}

function databaseStatus(status: AgentIntentStatus) {
  return status === 'completed' ? 'completed' : status;
}

export async function appendAgentTurn(
  userId: string,
  conversationId: string,
  clientRequestId: string,
  text: string,
  contextMarketId: string | null,
  analysis: AgentIntentAnalysis,
) {
  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const requestId = createId('agr');
  const metadataJson = canonicalJson({ contextMarketId, mode: 'record_only' });
  const [contentHash, clientRequestIdHash] = await Promise.all([
    sha256Hex(text),
    sha256Hex(`${userId}:${clientRequestId}`),
  ]);
  const existing = await database.prepare(`
    SELECT id, conversation_id, user_id, sequence_no, role, status, content_text,
      metadata_json, content_hash, client_request_id_hash, request_id, model_id, agent_version, created_at
    FROM agent_messages
    WHERE user_id = ? AND client_request_id_hash = ?
    LIMIT 1
  `).bind(userId, clientRequestIdHash).first<MessageRow>();

  if (existing) {
    if (
      existing.content_hash !== contentHash
      || existing.conversation_id !== conversationId
      || existing.metadata_json !== metadataJson
    ) {
      throw new AgentConflictError('That client request identifier was already used for different content.');
    }
    return { ...(await getAgentConversation(userId, conversationId)), replayed: true };
  }

  const conversation = await ownedConversationRow(userId, conversationId);
  if (!conversation || conversation.status !== 'active') throw new AgentResourceNotFoundError();

  const [messageCount, recentCount] = await Promise.all([
    database.prepare(`
      SELECT COUNT(*) AS count FROM agent_messages
      WHERE conversation_id = ? AND user_id = ?
    `).bind(conversationId, userId).first<{ count: number }>(),
    database.prepare(`
      SELECT COUNT(*) AS count FROM agent_messages
      WHERE user_id = ? AND role = 'user' AND created_at >= ?
    `).bind(userId, now - 60).first<{ count: number }>(),
  ]);
  if (Number(messageCount?.count ?? 0) + 2 > MAX_MESSAGES_PER_CONVERSATION) {
    throw new AgentRateLimitError('This session is full. Start a new Signal Desk session.');
  }
  if (Number(recentCount?.count ?? 0) >= MAX_MESSAGES_PER_MINUTE) {
    throw new AgentRateLimitError();
  }

  const userMessageId = createId('agm');
  const assistantMessageId = createId('agm');
  const intentId = analysis.intentType ? createId('agi') : null;
  const assistantContentHash = await sha256Hex(analysis.assistantMessage);
  const payloadJson = canonicalJson(analysis.payload);
  const riskJson = canonicalJson(analysis.risk);
  const [payloadHash, idempotencyKeyHash] = await Promise.all([
    sha256Hex(payloadJson),
    sha256Hex(`${userId}:${clientRequestId}:intent`),
  ]);
  const statements: D1PreparedStatement[] = [
    database.prepare(`
      INSERT INTO agent_messages
        (id, conversation_id, user_id, sequence_no, role, visibility, status, content_text,
         metadata_json, content_hash, client_request_id_hash, request_id, model_id, agent_version, created_at)
      SELECT ?, ?, ?,
        (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM agent_messages WHERE conversation_id = ?),
        'user', 'user', 'complete', ?, ?, ?, ?, ?, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_conversations
        WHERE id = ? AND user_id = ? AND status = 'active'
      )
    `).bind(
      userMessageId, conversationId, userId, conversationId, text, metadataJson, contentHash,
      clientRequestIdHash, requestId, AGENT_VERSION, now, conversationId, userId,
    ),
    database.prepare(`
      INSERT INTO agent_messages
        (id, conversation_id, user_id, sequence_no, role, visibility, status, content_text,
         metadata_json, content_hash, client_request_id_hash, request_id, model_id, agent_version, created_at)
      SELECT ?, ?, ?,
        (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM agent_messages WHERE conversation_id = ?),
        'assistant', 'user', 'complete', ?, ?, ?, NULL, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_messages
        WHERE id = ? AND conversation_id = ? AND user_id = ? AND role = 'user'
      )
    `).bind(
      assistantMessageId, conversationId, userId, conversationId, analysis.assistantMessage,
      canonicalJson({ intentType: analysis.intentType, status: analysis.status }), assistantContentHash,
      requestId, MODEL_ID, AGENT_VERSION, now, userMessageId, conversationId, userId,
    ),
  ];

  if (intentId && analysis.intentType && analysis.status) {
    const expiresAt = analysis.expiresAtMs ? Math.floor(analysis.expiresAtMs / 1000) : null;
    statements.push(database.prepare(`
      INSERT INTO agent_financial_intents
        (id, user_id, conversation_id, source_message_id, intent_type, summary_text,
         status, execution_mode, payload_json, payload_schema_version, payload_hash,
         risk_json, idempotency_key_hash, request_id, policy_version, version,
         expires_at, closed_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'record_only', ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_messages
        WHERE id = ? AND conversation_id = ? AND user_id = ? AND role = 'assistant'
      )
    `).bind(
      intentId, userId, conversationId, assistantMessageId, analysis.intentType,
      analysis.summary.slice(0, 240), databaseStatus(analysis.status), payloadJson, payloadHash,
      riskJson, idempotencyKeyHash, requestId, AGENT_VERSION, expiresAt,
      analysis.status === 'completed' || analysis.status === 'blocked' ? now : null, now, now,
      assistantMessageId, conversationId, userId,
    ));
  }

  statements.push(
    database.prepare(`
      UPDATE agent_conversations
      SET title = CASE WHEN title = 'New signal session' THEN ? ELSE title END,
          updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'active'
    `).bind(analysis.title.slice(0, 80), now, conversationId, userId),
    database.prepare(`
      INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
      SELECT ?, ?, 'agent.turn.recorded', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agent_messages
        WHERE id = ? AND conversation_id = ? AND user_id = ?
      )
    `).bind(createId('aud'), userId, canonicalJson({
      conversationId,
      userMessageId,
      assistantMessageId,
      intentId,
      requestId,
      contentHash,
      payloadHash: intentId ? payloadHash : null,
    }), now, userMessageId, conversationId, userId),
  );

  try {
    await database.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique constraint failed/i.test(message)) {
      const replay = await database.prepare(`
        SELECT id, conversation_id, user_id, sequence_no, role, status, content_text,
          metadata_json, content_hash, client_request_id_hash, request_id, model_id, agent_version, created_at
        FROM agent_messages
        WHERE user_id = ? AND client_request_id_hash = ?
        LIMIT 1
      `).bind(userId, clientRequestIdHash).first<MessageRow>();
      if (
        replay?.content_hash === contentHash
        && replay.conversation_id === conversationId
        && replay.metadata_json === metadataJson
      ) {
        return { ...(await getAgentConversation(userId, conversationId)), replayed: true };
      }
      throw new AgentConflictError();
    }
    throw error;
  }

  const recorded = await getAgentConversation(userId, conversationId);
  if (
    !recorded.messages.some((message) => message.id === userMessageId)
    || !recorded.messages.some((message) => message.id === assistantMessageId)
  ) {
    throw new AgentConflictError('The session changed while the message was being recorded.');
  }
  return { ...recorded, replayed: false };
}

export async function getAgentIntent(userId: string, intentId: string) {
  const row = await ownedIntentRow(userId, intentId);
  if (!row) throw new AgentResourceNotFoundError();
  return mapIntent(row);
}

export async function reviewAgentIntent(
  userId: string,
  intentId: string,
  decision: 'acknowledge' | 'reject',
  payloadHash: string,
  version: number,
) {
  const database = getDatabase();
  const current = await ownedIntentRow(userId, intentId);
  if (!current) throw new AgentResourceNotFoundError();
  if (current.payload_hash !== payloadHash) {
    throw new AgentConflictError('The intent payload changed. Refresh before reviewing it.');
  }
  if (current.version !== version) throw new AgentConflictError();

  const now = Math.floor(Date.now() / 1000);
  if (current.expires_at && current.expires_at <= now && (current.status === 'proposed' || current.status === 'acknowledged')) {
    const expiredVersion = version + 1;
    const expiryAuditId = `aud_${(await sha256Hex(`${userId}:${intentId}:${version}:expired`)).slice(0, 32)}`;
    const [expiryResult] = await database.batch([
      database.prepare(`
        UPDATE agent_financial_intents
        SET status = 'expired', closed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND user_id = ? AND version = ?
          AND status IN ('proposed', 'acknowledged') AND expires_at <= ?
      `).bind(now, now, intentId, userId, version, now),
      database.prepare(`
        INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
        SELECT ?, ?, 'agent.intent.expired', ?, ?
        WHERE changes() = 1 AND EXISTS (
          SELECT 1 FROM agent_financial_intents
          WHERE id = ? AND user_id = ? AND status = 'expired' AND version = ? AND payload_hash = ?
        )
      `).bind(expiryAuditId, userId, canonicalJson({
        intentId,
        payloadHash,
        fromStatus: current.status,
        toStatus: 'expired',
        version: expiredVersion,
      }), now, intentId, userId, expiredVersion, payloadHash),
    ]);
    if (Number(expiryResult.meta?.changes ?? 0) !== 1) throw new AgentConflictError();
    throw new AgentConflictError('This intent preview expired. Create a fresh preview before reviewing it.');
  }

  const allowed = decision === 'acknowledge'
    ? current.status === 'proposed'
    : current.status === 'proposed' || current.status === 'acknowledged';
  if (!allowed) {
    throw new AgentConflictError(`This intent cannot be ${decision === 'acknowledge' ? 'acknowledged' : 'rejected'} from its current state.`);
  }

  const nextStatus = decision === 'acknowledge' ? 'acknowledged' : 'rejected';
  const closedAt = decision === 'reject' ? now : null;
  const nextVersion = version + 1;
  const auditId = `aud_${(await sha256Hex(`${userId}:${intentId}:${version}:${nextStatus}`)).slice(0, 32)}`;
  const [updateResult] = await database.batch([
    database.prepare(`
    UPDATE agent_financial_intents
    SET status = ?,
        expires_at = CASE WHEN ? = 'rejected' THEN NULL ELSE expires_at END,
        closed_at = ?,
        updated_at = ?,
        version = version + 1
    WHERE id = ? AND user_id = ? AND version = ?
      AND execution_mode = 'record_only'
      AND status ${decision === 'acknowledge' ? "= 'proposed'" : "IN ('proposed', 'acknowledged')"}
      AND (? <> 'acknowledged' OR expires_at > ?)
  `).bind(nextStatus, nextStatus, closedAt, now, intentId, userId, version, nextStatus, now),
    database.prepare(`
      INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
      SELECT ?, ?, 'agent.intent.reviewed', ?, ?
      WHERE changes() = 1 AND EXISTS (
        SELECT 1 FROM agent_financial_intents
        WHERE id = ? AND user_id = ? AND status = ? AND version = ? AND payload_hash = ?
      )
    `).bind(auditId, userId, canonicalJson({
      intentId,
      payloadHash,
      fromStatus: current.status,
      toStatus: nextStatus,
      version: nextVersion,
    }), now, intentId, userId, nextStatus, nextVersion, payloadHash),
  ]);
  if (Number(updateResult.meta?.changes ?? 0) !== 1) throw new AgentConflictError();

  const result = await ownedIntentRow(userId, intentId);
  if (!result || result.status !== nextStatus || result.version !== nextVersion || result.payload_hash !== payloadHash) {
    throw new AgentConflictError('The reviewed intent could not be verified after the state transition.');
  }
  return mapIntent(result);
}
