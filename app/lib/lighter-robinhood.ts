export const ROBINHOOD_LIGHTER_API = 'https://api.rh.lighter.xyz';
export const ROBINHOOD_LIGHTER_PROXY = '0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d' as const;
export const ROBINHOOD_USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
export const ROBINHOOD_USDG_DECIMALS = 6;
export const ROBINHOOD_USDG_ASSET_INDEX = 3;
export const ROBINHOOD_LIGHTER_PERPS_ROUTE = 0;
export const AVENTA_TREASURY_ACCOUNT_INDEX = 17005;
export const AVENTA_TREASURY_ADDRESS = '0xCe8756522C90B405c9647aE6BbcA169240965225' as const;

export const USDG_ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const ROBINHOOD_LIGHTER_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_assetIndex', type: 'uint16' },
      { name: '_routeType', type: 'uint8' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;
