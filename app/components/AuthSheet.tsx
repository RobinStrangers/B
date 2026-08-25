'use client';

import { useLogin, usePrivy } from '@privy-io/react-auth';
import { useEffect, useId, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import { FaXTwitter } from 'react-icons/fa6';
import { LuLogOut, LuWalletCards } from 'react-icons/lu';
import { MdOutlineEmail } from 'react-icons/md';
import { SiGoogle } from 'react-icons/si';

type AuthSheetProps = {
  open: boolean;
  onClose: () => void;
};

type PrivyLoginMethod = 'email' | 'google' | 'twitter' | 'wallet';

const authOptions: {
  id: string;
  label: string;
  detail: string;
  loginMethod: PrivyLoginMethod;
  icon: IconType;
}[] = [
  { id: 'email', label: 'Continue with email', detail: 'Secure one-time code', loginMethod: 'email', icon: MdOutlineEmail },
  { id: 'google', label: 'Continue with Google', detail: 'Use your Google account', loginMethod: 'google', icon: SiGoogle },
  { id: 'x', label: 'Continue with X', detail: 'Use your X account', loginMethod: 'twitter', icon: FaXTwitter },
  { id: 'wallet', label: 'Continue with wallet', detail: 'Ethereum wallets only', loginMethod: 'wallet', icon: LuWalletCards },
];

function shortIdentity(value: string) {
  if (value.length <= 26) return value;
  return `${value.slice(0, 14)}…${value.slice(-8)}`;
}

export default function AuthSheet({ open, onClose }: AuthSheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const launchingPrivyRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const { ready, authenticated, user, logout, error: privyError } = usePrivy();
  const { login } = useLogin({
    onError: () => setActionError('Sign-in could not be completed. Please try again.'),
  });
  const emailAccount = user?.linkedAccounts.find((account) => account.type === 'email');
  const email = emailAccount && 'address' in emailAccount ? emailAccount.address : null;
  const identityLabel = email ?? (user?.id ? shortIdentity(user.id) : 'Authenticated Privy user');

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (!launchingPrivyRef.current) previousFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const beginLogin = (loginMethod: PrivyLoginMethod) => {
    setActionError('');
    launchingPrivyRef.current = true;
    login({ loginMethods: [loginMethod], walletChainType: 'ethereum-only' });
    onClose();
  };

  const signOut = async () => {
    setActionError('');
    setLoggingOut(true);
    try {
      await logout();
      onClose();
    } catch {
      setActionError('Sign-out could not be completed. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="auth-sheet-overlay" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="auth-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${statusId}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="auth-sheet-header">
          <div>
            <span className="auth-sheet-kicker">SECURE ACCESS / PRIVY</span>
            <h2 id={titleId}>{authenticated ? 'Your Aventa session' : 'Choose a sign-in method'}</h2>
          </div>
          <button
            className="auth-sheet-close"
            type="button"
            onClick={onClose}
            ref={closeButtonRef}
            aria-label="Close sign-in options"
          >
            ×
          </button>
        </header>

        <p className="auth-sheet-description" id={descriptionId}>
          {authenticated
            ? 'Your Privy identity is active. Account data is authorized separately from trading execution.'
            : 'Access Aventa with email, Google, X, or an Ethereum wallet. Privy securely manages the authentication session.'}
        </p>

        {authenticated ? (
          <div className="auth-sheet-session">
            <span className="auth-sheet-session-mark" aria-hidden="true"><img src="/aventa-mark.png" alt="" /></span>
            <div>
              <small>CONNECTED IDENTITY</small>
              <strong>{identityLabel}</strong>
              <span>{user?.id ? shortIdentity(user.id) : 'Privy session active'}</span>
            </div>
            <button type="button" onClick={() => void signOut()} disabled={loggingOut}>
              <LuLogOut aria-hidden="true" />
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        ) : (
          <div className="auth-sheet-options" aria-label="Sign-in methods">
            {authOptions.map((option) => {
              const OptionIcon = option.icon;
              return (
                <button
                  className="auth-sheet-option"
                  type="button"
                  key={option.id}
                  disabled={!ready || Boolean(privyError)}
                  onClick={() => beginLogin(option.loginMethod)}
                  aria-describedby={statusId}
                >
                  <span className="auth-sheet-option-mark" aria-hidden="true"><OptionIcon /></span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                  <i aria-hidden="true">↗</i>
                </button>
              );
            })}
          </div>
        )}

        <p className={`auth-sheet-status ${authenticated ? 'configured' : ''}`} id={statusId}>
          <span aria-hidden="true" />
          {authenticated
            ? 'Authenticated with Privy. Profile persistence uses a separately verified server token.'
            : privyError
              ? 'Privy could not initialize for this origin. Check the allowed-domain configuration.'
              : ready
              ? 'Privy is ready. Your access token is verified again by Aventa before private data is returned.'
              : 'Initializing secure sign-in…'}
        </p>

        {actionError && <p className="auth-sheet-error" role="alert">{actionError}</p>}

        <p className="auth-sheet-terms">
          By continuing, you agree to use the selected identity provider under its applicable terms and privacy policy.
        </p>
      </section>
    </div>
  );
}
