'use client';

import { TokenIcon } from '@web3icons/react/dynamic';
import type { IconType } from 'react-icons';
import { FaMicrosoft } from 'react-icons/fa6';
import {
  GiCorn,
  GiDiamondHard,
  GiFlame,
  GiGoldBar,
  GiMetalBar,
  GiOilDrum,
  GiWheat,
} from 'react-icons/gi';
import {
  SiAmazon,
  SiAmd,
  SiApple,
  SiCoinbase,
  SiGoogle,
  SiMeta,
  SiNetflix,
  SiNvidia,
  SiTesla,
} from 'react-icons/si';
import type { Market } from '../markets';

type AssetLogoProps = {
  market: Pick<Market, 'base' | 'category' | 'name'>;
  size?: number;
  className?: string;
};

const shareIcons: Record<string, IconType> = {
  AAPL: SiApple,
  MSFT: FaMicrosoft,
  NVDA: SiNvidia,
  AMZN: SiAmazon,
  GOOGL: SiGoogle,
  META: SiMeta,
  TSLA: SiTesla,
  AMD: SiAmd,
  NFLX: SiNetflix,
  COIN: SiCoinbase,
};

const materialIcons: Record<string, IconType> = {
  XAU: GiGoldBar,
  XAG: GiDiamondHard,
  COPPER: GiMetalBar,
  PLATINUM: GiDiamondHard,
  WTI: GiOilDrum,
  BRENT: GiOilDrum,
  NATGAS: GiFlame,
  CORN: GiCorn,
  WHEAT: GiWheat,
};

const currencyFlags: Record<string, string> = {
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  USD: '🇺🇸',
  JPY: '🇯🇵',
  AUD: '🇦🇺',
  CAD: '🇨🇦',
  CHF: '🇨🇭',
};

export function AssetLogo({ market, size = 28, className = '' }: AssetLogoProps) {
  if (market.category === 'crypto') {
    return (
      <span className={`asset-logo asset-logo-crypto ${className}`} style={{ width: size, height: size }}>
        <TokenIcon
          symbol={market.base}
          variant="branded"
          size={size}
          aria-label={`${market.base} logo`}
          fallback={<span className="asset-logo-fallback">{market.base.slice(0, 2)}</span>}
        />
      </span>
    );
  }

  if (market.category === 'shares') {
    const Logo = shareIcons[market.base];
    return (
      <span className={`asset-logo asset-logo-share asset-logo-${market.base.toLowerCase()} ${className}`} style={{ width: size, height: size }} aria-label={`${market.base} company logo`}>
        {Logo ? <Logo aria-hidden="true" /> : <span className="asset-logo-fallback">{market.base.slice(0, 2)}</span>}
      </span>
    );
  }

  if (market.category === 'forex') {
    return (
      <span className={`asset-logo asset-logo-forex ${className}`} style={{ width: size, height: size }} aria-label={`${market.base} currency flag`}>
        <span>{currencyFlags[market.base] ?? '🌐'}</span>
      </span>
    );
  }

  const MaterialLogo = materialIcons[market.base];
  return (
    <span className={`asset-logo asset-logo-material ${className}`} style={{ width: size, height: size }} aria-label={`${market.name} icon`}>
      {MaterialLogo ? <MaterialLogo aria-hidden="true" /> : <GiMetalBar aria-hidden="true" />}
    </span>
  );
}
