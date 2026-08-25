import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reference terminal',
  description: 'Live crypto and global-market reference charts with an execution-safe perpetual order preview.',
};

export default function TradeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
