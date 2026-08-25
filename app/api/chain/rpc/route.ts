const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const HEX_DATA_PATTERN = /^0x[a-fA-F0-9]*$/;
const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const USDG_ADDRESS = (process.env.NEXT_PUBLIC_USDG_ADDRESS?.trim() || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168').toLowerCase();
const LIGHTER_PROXY = '0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d'.toLowerCase();
const ALLOWED_METHODS = new Set(['eth_call', 'eth_estimateGas', 'eth_getTransactionReceipt']);

type RpcPayload = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type TransactionLike = {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
};

function isAllowedTransaction(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const tx = value as TransactionLike;
  if (!tx.to || !ADDRESS_PATTERN.test(tx.to)) return false;
  const to = tx.to.toLowerCase();
  if (to !== USDG_ADDRESS && to !== LIGHTER_PROXY) return false;
  if (tx.from !== undefined && !ADDRESS_PATTERN.test(tx.from)) return false;
  if (tx.data !== undefined && !HEX_DATA_PATTERN.test(tx.data)) return false;
  if (tx.value !== undefined && tx.value !== '0x0' && tx.value !== '0x00') return false;
  return true;
}

function validateParams(method: string, params: unknown[]) {
  if (method === 'eth_getTransactionReceipt') {
    return params.length === 1 && typeof params[0] === 'string' && HASH_PATTERN.test(params[0]);
  }
  if (method === 'eth_call') {
    return params.length === 2 && isAllowedTransaction(params[0]) && params[1] === 'latest';
  }
  if (method === 'eth_estimateGas') {
    return params.length === 1 && isAllowedTransaction(params[0]);
  }
  return false;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: 'INVALID_JSON', message: 'A valid JSON body is required.' } }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid Robinhood Chain RPC request.' } }, { status: 400 });
  }

  const root = body as Record<string, unknown>;
  const method = typeof root.method === 'string' ? root.method : '';
  const params = Array.isArray(root.params) ? root.params : [];
  if (!ALLOWED_METHODS.has(method) || !validateParams(method, params)) {
    return Response.json({ error: { code: 'RPC_METHOD_BLOCKED', message: 'This Robinhood Chain RPC operation is not permitted.' } }, { status: 400 });
  }

  const rpcUrl = process.env.ROBINHOOD_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL?.trim()
    || PUBLIC_RPC_URL;

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      return Response.json({ error: { code: 'RPC_HTTP_ERROR', message: `Robinhood Chain RPC returned HTTP ${response.status}.` } }, { status: 502 });
    }
    const payload = await response.json() as RpcPayload;
    if (payload.error) {
      return Response.json({
        error: {
          code: 'RPC_REJECTED',
          message: payload.error.message || 'Robinhood Chain rejected the RPC request.',
          rpcCode: payload.error.code,
          data: payload.error.data,
        },
      }, { status: 502 });
    }
    return Response.json({ result: payload.result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({
      error: {
        code: 'RPC_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Robinhood Chain RPC is temporarily unavailable.',
      },
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
