const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ROBINHOOD_CHAIN_ID = 4663;
const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

type RpcResult = {
  id: number;
  result?: string;
  error?: { code?: number; message?: string };
};

const tokens = [
  {
    symbol: 'USDG',
    address: process.env.NEXT_PUBLIC_USDG_ADDRESS?.trim() || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    identity: 'Robinhood Chain USDG',
  },
] as const;

function balanceOfData(address: string) {
  return `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function formatUnits(hexValue: string, decimals: number, precision = 8) {
  const value = BigInt(hexValue);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, Math.min(decimals, precision))
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function rpcCall(id: number, method: string, params: unknown[]) {
  return { jsonrpc: '2.0', id, method, params };
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address')?.trim() ?? '';
  if (!ADDRESS_PATTERN.test(address)) {
    return Response.json({ error: { code: 'INVALID_ADDRESS', message: 'A valid EVM wallet address is required.' } }, { status: 400 });
  }

  const rpcUrl = process.env.ROBINHOOD_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL?.trim()
    || PUBLIC_RPC_URL;
  const requests = [
    rpcCall(1, 'eth_chainId', []),
    rpcCall(2, 'eth_blockNumber', []),
    rpcCall(3, 'eth_getBalance', [address, 'latest']),
    ...tokens.flatMap((token, index) => {
      const baseId = 10 + index * 3;
      return [
        rpcCall(baseId, 'eth_getCode', [token.address, 'latest']),
        rpcCall(baseId + 1, 'eth_call', [{ to: token.address, data: balanceOfData(address) }, 'latest']),
        rpcCall(baseId + 2, 'eth_call', [{ to: token.address, data: '0x313ce567' }, 'latest']),
      ];
    }),
  ];

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requests),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`RPC returned ${response.status}.`);
    const payload = await response.json() as RpcResult[];
    if (!Array.isArray(payload)) throw new Error('RPC batch response was malformed.');
    const results = new Map(payload.map((item) => [item.id, item]));
    const chainIdHex = results.get(1)?.result;
    if (!chainIdHex || Number(BigInt(chainIdHex)) !== ROBINHOOD_CHAIN_ID) {
      throw new Error('RPC is not connected to Robinhood Chain mainnet.');
    }

    const nativeHex = results.get(3)?.result;
    if (!nativeHex) throw new Error('ETH balance was not returned by the RPC.');

    const assets = [
      {
        symbol: 'ETH',
        identity: 'Robinhood Chain native asset',
        configured: true,
        balance: formatUnits(nativeHex, 18),
        decimals: 18,
        status: 'live',
      },
      ...tokens.map((token, index) => {
        const baseId = 10 + index * 3;
        const code = results.get(baseId)?.result;
        const rawBalance = results.get(baseId + 1)?.result;
        const rawDecimals = results.get(baseId + 2)?.result;
        const configured = Boolean(code && code !== '0x' && code !== '0x0');
        if (!configured || !rawBalance || !rawDecimals) {
          return {
            symbol: token.symbol,
            identity: token.identity,
            contractAddress: token.address,
            configured,
            status: configured ? 'error' : 'not-found',
          };
        }
        const decimals = Number(BigInt(rawDecimals));
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
          return {
            symbol: token.symbol,
            identity: token.identity,
            contractAddress: token.address,
            configured: true,
            status: 'error',
          };
        }
        return {
          symbol: token.symbol,
          identity: token.identity,
          contractAddress: token.address,
          configured: true,
          balance: formatUnits(rawBalance, decimals),
          decimals,
          status: 'live',
        };
      }),
    ];

    return Response.json({
      chainId: ROBINHOOD_CHAIN_ID,
      blockNumber: results.get(2)?.result ? Number(BigInt(results.get(2)?.result as string)) : null,
      address,
      assets,
      updatedAt: Date.now(),
    }, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch {
    return Response.json({
      error: {
        code: 'CHAIN_READ_FAILED',
        message: 'Robinhood Chain did not return a verified balance snapshot. Please retry.',
      },
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
