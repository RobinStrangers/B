import type { AnchorHTMLAttributes, ReactNode } from 'react';

type InternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  children: ReactNode;
  href: string;
};

/**
 * Uses native document navigation for app routes.
 *
 * The deployed Vinext client router currently throws while handling Next Link
 * transitions. A native anchor keeps every route reachable even if client-side
 * prefetching is unavailable.
 */
export default function InternalLink({ children, href, ...props }: InternalLinkProps) {
  return <a href={href} {...props}>{children}</a>;
}
