import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Signal Desk — Aventa',
  description: 'Account-scoped market intent, evidence, and risk review for Aventa on Robinhood Chain.',
};

export default function AgentLayout({ children }: { children: ReactNode }) {
  return children;
}
