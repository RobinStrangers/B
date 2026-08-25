import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Markets',
  description:
    'Discover 35 live and delayed reference markets across crypto, forex, metals, commodities, and shares on Aventa.',
};

export default function MarketsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
