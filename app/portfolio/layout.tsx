import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Wallet',
  description:
    'Review wallet assets, collateral, positions, orders, and account activity in Aventa.',
};

export default function PortfolioLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
