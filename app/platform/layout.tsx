import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Platform',
  description:
    'Explore Aventa market-data sources, Robinhood Chain integration, and the safeguards required before perpetual execution can activate.',
};

export default function PlatformLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
