import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Aventa account identity, connected-wallet balances, and self-custody controls.',
};

export default function ProfileLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
