import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import Providers from './providers';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

function safeSiteUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ];

  for (const rawValue of candidates) {
    const value = rawValue?.trim();
    if (!value) continue;

    const candidate = /^https?:\/\//i.test(value)
      ? value
      : `${/^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(value) ? 'http' : 'https'}://${value}`;

    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url;
    } catch {
      // Ignore malformed deployment variables and continue to a safe fallback.
    }
  }

  return new URL('http://localhost:3000');
}

const metadataBase = safeSiteUrl();

export const metadata: Metadata = {
  metadataBase,
  applicationName: 'Aventa',
  title: {
    default: 'Aventa — Move with intent. Trade with clarity.',
    template: '%s · Aventa',
  },

  other: {
  'virtual-protocol-site-verification': '0bc381a221039d1cd89b8ad5572351da',
},
  
  description: 'A live multi-asset reference terminal and perpetual trading interface for Robinhood Chain.',
  keywords: ['perpetual markets', 'Robinhood Chain', 'crypto', 'forex', 'metals', 'commodities', 'equity references'],
  icons: { icon: '/aventa-mark.png', apple: '/aventa-mark.png' },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    title: 'Aventa — Move with intent. Trade with clarity.',
    description: 'Live reference markets across crypto and global assets on Robinhood Chain.',
    siteName: 'Aventa',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Aventa — Move with intent. Trade with clarity.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Aventa — Move with intent. Trade with clarity.',
    description: 'Live reference markets across crypto and global assets on Robinhood Chain.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <Providers privyAppId={privyAppId}>{children}</Providers>
      </body>
    </html>
  );
}
