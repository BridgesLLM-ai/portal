import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../contexts/AuthContext';
import { Eye, EyeOff, Loader2, ArrowLeft, Shield, Mail, RefreshCw } from 'lucide-react';
import {
  authAPI,
  TwoFactorEmailRecoveryIndeterminateError,
  type TwoFactorEmailDelivery,
} from '../api/auth';
import PublicAuthBrand from '../components/PublicAuthBrand';
import { usePublicSettings } from '../hooks/usePublicSettings';
import { resolveSafePortalRedirect } from '../utils/authRedirect';
import { validatePortalPassword } from '../utils/passwordPolicy';

type AuthOperation =
  | 'login'
  | 'signup'
  | 'two-factor'
  | 'resend-two-factor'
  | 'recover-email-two-factor';

const EMAIL_2FA_RECOVERY_CONFIRMATION = 'DISABLE EMAIL 2FA';

function TwoFactorInput({
  onSubmit,
  onCancel,
  onResendEmail,
  onRecoverEmail,
  isLoading,
  verificationBusy,
  recoveryBusy,
  interactionBlocked,
  error,
  clearError,
  method,
  emailDelivery,
}: {
  onSubmit: (code: string) => void;
  onCancel: () => void;
  onResendEmail?: () => Promise<string | null>;
  onRecoverEmail?: (currentPassword: string, confirmation: string) => Promise<boolean>;
  isLoading: boolean;
  verificationBusy: boolean;
  recoveryBusy: boolean;
  interactionBlocked: () => boolean;
  error: string | null;
  clearError: () => void;
  method: 'totp' | 'email';
  emailDelivery: TwoFactorEmailDelivery | null;
}) {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [activeEmailDelivery, setActiveEmailDelivery] = useState(emailDelivery);
  const emailDeliveryState = activeEmailDelivery?.state ?? 'unknown';
  const emailCodeReady = method === 'email' && emailDeliveryState === 'sent';
  const [useBackupCode, setUseBackupCode] = useState(
    method === 'email' && emailDeliveryState !== 'sent',
  );
  const [backupCode, setBackupCode] = useState('');
  const [resendCountdown, setResendCountdown] = useState(0);
  const [resending, setResending] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const resendInFlightRef = useRef(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const handleDigitChange = useCallback((index: number, value: string) => {
    if (interactionBlocked()) return;
    clearError();
    const digit = value.replace(/\D/g, '').slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (digit && index === 5) {
      const code = newDigits.join('');
      if (code.length === 6) {
        onSubmit(code);
      }
    }
  }, [digits, clearError, interactionBlocked, onSubmit]);

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (interactionBlocked()) return;
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }, [digits, interactionBlocked]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    if (interactionBlocked()) return;
    clearError();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      const newDigits = pasted.split('');
      setDigits(newDigits);
      inputRefs.current[5]?.focus();
      onSubmit(pasted);
    } else {
      const newDigits = [...digits];
      pasted.split('').forEach((d, i) => {
        if (i < 6) newDigits[i] = d;
      });
      setDigits(newDigits);
    }
  }, [digits, clearError, interactionBlocked, onSubmit]);

  const handleBackupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!interactionBlocked() && backupCode.trim().length >= 6) {
      onSubmit(backupCode.trim());
    }
  };

  const handleEmailDeliveryAttempt = async () => {
    if (
      !onResendEmail
      || interactionBlocked()
      || resendCountdown > 0
      || resendInFlightRef.current
      || emailDeliveryState === 'unavailable'
    ) {
      return;
    }
    resendInFlightRef.current = true;
    setResending(true);
    try {
      const message = await onResendEmail();
      if (message) {
        setActiveEmailDelivery({ state: 'sent', message });
        setDigits(['', '', '', '', '', '']);
        setBackupCode('');
        setShowRecovery(false);
        setUseBackupCode(false);
        setResendCountdown(60);
      }
    } finally {
      resendInFlightRef.current = false;
      setResending(false);
    }
  };

  const handleRecoverySubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !onRecoverEmail
      || interactionBlocked()
      || !recoveryPassword
      || recoveryConfirmation !== EMAIL_2FA_RECOVERY_CONFIRMATION
    ) {
      return;
    }
    await onRecoverEmail(recoveryPassword, recoveryConfirmation);
  };

  const emailDeliveryTitle = emailDeliveryState === 'unavailable'
    ? 'Email verification unavailable'
    : emailDeliveryState === 'failed'
      ? 'Verification email not sent'
      : emailDeliveryState === 'sent'
        ? 'Check your email'
        : 'Email delivery unconfirmed';
  const heading = showRecovery
    ? 'Recover account access'
    : useBackupCode
      ? 'Use a backup code'
      : method === 'email'
        ? emailDeliveryTitle
        : 'Two-Factor Authentication';
  const description = showRecovery
    ? 'Disable legacy Email Code 2FA, revoke every session, and return to a fresh sign-in.'
    : useBackupCode
      ? 'Enter one of the backup codes you saved when 2FA was enabled.'
      : method === 'email'
        ? activeEmailDelivery?.message || 'Portal could not confirm whether a verification email was delivered.'
        : 'Enter the 6-digit code from your authenticator app.';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      <div className="text-center">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
          style={{
            background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.05))',
            border: '1px solid rgba(16,185,129,0.2)',
          }}>
          {method === 'email' ? (
            <Mail size={24} className="text-emerald-400" />
          ) : (
            <Shield size={24} className="text-emerald-400" />
          )}
        </div>
        <h2 className="text-xl font-bold text-white mb-1">{heading}</h2>
        <p className="text-sm text-slate-400">{description}</p>
      </div>

      {method === 'email' && emailDeliveryState !== 'sent' && !showRecovery && (
        <div
          role={emailDeliveryState === 'failed' ? 'alert' : 'status'}
          className={`rounded-xl border px-4 py-3 text-sm ${
            emailDeliveryState === 'failed'
              ? 'border-red-500/20 bg-red-500/10 text-red-200'
              : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
          }`}
        >
          <p>
            {activeEmailDelivery?.message
              || 'Portal could not confirm whether a verification email was delivered. No email code is being assumed.'}
          </p>
          {emailDeliveryState !== 'unavailable' && onResendEmail && (
            <button
              type="button"
              onClick={handleEmailDeliveryAttempt}
              disabled={isLoading || resending}
              aria-busy={resending}
              className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-300 hover:text-emerald-200 transition-colors disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} className={resending ? 'animate-spin' : ''} />
              {resending ? 'Sending code…' : 'Try sending a code'}
            </button>
          )}
        </div>
      )}

      {showRecovery ? (
        <form onSubmit={handleRecoverySubmit} className="space-y-4">
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            Use this only when no backup code remains. You will need to sign in again and should enable Authenticator App 2FA afterward.
          </div>
          <div>
            <label htmlFor="email-two-factor-recovery-password" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Enter your password again
            </label>
            <input
              id="email-two-factor-recovery-password"
              type="password"
              autoComplete="current-password"
              value={recoveryPassword}
              onChange={(event) => {
                if (interactionBlocked()) return;
                setRecoveryPassword(event.target.value);
                clearError();
              }}
              disabled={isLoading}
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/40"
              autoFocus
              required
            />
          </div>
          <div>
            <label htmlFor="email-two-factor-recovery-confirmation" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Type {EMAIL_2FA_RECOVERY_CONFIRMATION}
            </label>
            <input
              id="email-two-factor-recovery-confirmation"
              type="text"
              autoComplete="off"
              value={recoveryConfirmation}
              onChange={(event) => {
                if (interactionBlocked()) return;
                setRecoveryConfirmation(event.target.value);
                clearError();
              }}
              disabled={isLoading}
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none transition focus:border-emerald-400/40"
              required
            />
          </div>
          <motion.button
            type="submit"
            disabled={
              isLoading
              || !recoveryPassword
              || recoveryConfirmation !== EMAIL_2FA_RECOVERY_CONFIRMATION
            }
            aria-busy={recoveryBusy}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950 transition disabled:opacity-50"
          >
            {recoveryBusy && <Loader2 size={16} className="animate-spin" />}
            {recoveryBusy ? 'Recovering…' : 'Disable Email Code 2FA'}
          </motion.button>
          <button
            type="button"
            onClick={() => {
              if (interactionBlocked()) return;
              setShowRecovery(false);
              setRecoveryPassword('');
              setRecoveryConfirmation('');
              clearError();
            }}
            disabled={isLoading}
            className="mx-auto block text-xs text-slate-400 transition-colors hover:text-white"
          >
            Return to backup code
          </button>
        </form>
      ) : !useBackupCode ? (
        <div>
          {/* Hidden auto-fill target — iOS/iPadOS fills this from Mail codes */}
          <input
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            disabled={isLoading}
            aria-hidden="true"
            tabIndex={-1}
            style={{
              position: 'absolute',
              opacity: 0,
              pointerEvents: 'none',
              width: 0,
              height: 0,
              overflow: 'hidden',
            }}
            onChange={e => {
              if (interactionBlocked()) return;
              const val = e.target.value.replace(/\D/g, '').slice(0, 6);
              if (val.length === 6) {
                const newDigits = val.split('');
                setDigits(newDigits);
                inputRefs.current[5]?.focus();
                onSubmit(val);
              }
            }}
          />
          {/* 6-digit input */}
          <div
            role="group"
            aria-label={method === 'email' ? 'Six-digit email verification code' : 'Six-digit authenticator verification code'}
            className="flex justify-center gap-2 mb-4"
            onPaste={handlePaste}
          >
            {digits.map((digit, i) => (
              <input
                key={i}
                ref={el => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                aria-label={`Verification code digit ${i + 1} of 6`}
                maxLength={1}
                value={digit}
                onChange={e => handleDigitChange(i, e.target.value)}
                onKeyDown={e => handleKeyDown(i, e)}
                disabled={isLoading}
                className="w-11 h-14 text-center text-xl font-bold rounded-xl text-white outline-none transition-all duration-200"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: digit ? '1px solid rgba(16,185,129,0.4)' : '1px solid rgba(255,255,255,0.08)',
                  boxShadow: digit ? '0 0 12px rgba(16,185,129,0.1)' : 'inset 0 1px 2px rgba(0,0,0,0.2)',
                }}
                autoFocus={i === 0}
              />
            ))}
          </div>

          <div
            role="status"
            aria-live="polite"
            aria-busy={verificationBusy}
            className="mb-3 flex min-h-5 items-center justify-center gap-1.5 text-xs text-emerald-300"
          >
            {verificationBusy && <><Loader2 size={13} className="animate-spin" /> Verifying…</>}
          </div>

          <div className="flex flex-col items-center gap-2">
            {method === 'email' && onResendEmail && (
              <button
                type="button"
                onClick={handleEmailDeliveryAttempt}
                disabled={isLoading || resendCountdown > 0 || resending}
                aria-busy={resending}
                className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors disabled:text-slate-500 disabled:cursor-not-allowed"
              >
                <RefreshCw size={12} className={resending ? 'animate-spin' : ''} />
                {resending ? 'Sending code…' : resendCountdown > 0 ? `Resend code (${resendCountdown}s)` : 'Resend code'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (interactionBlocked()) return;
                setUseBackupCode(true);
                clearError();
              }}
              disabled={isLoading}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              Use a backup code instead
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleBackupSubmit}>
          <label htmlFor="two-factor-backup-code" className="sr-only">Backup code</label>
          <input
            id="two-factor-backup-code"
            type="text"
            autoComplete="one-time-code"
            value={backupCode}
            onChange={e => {
              if (interactionBlocked()) return;
              setBackupCode(e.target.value);
              clearError();
            }}
            placeholder="Enter backup code"
            disabled={isLoading}
            className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm outline-none transition-all duration-300 mb-4 font-mono tracking-wider"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)',
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'rgba(16,185,129,0.4)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'rgba(255,255,255,0.08)';
            }}
            autoFocus
          />
          <motion.button
            type="submit"
            disabled={isLoading || backupCode.trim().length < 6}
            aria-busy={verificationBusy}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className="w-full py-3 rounded-xl text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 mb-3"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 0 20px rgba(16,185,129,0.15), 0 4px 15px rgba(0,0,0,0.3)',
            }}
          >
            {verificationBusy && <Loader2 size={16} className="animate-spin" />}
            {verificationBusy ? 'Verifying…' : 'Verify Backup Code'}
          </motion.button>
          {(method !== 'email' || emailCodeReady) && (
            <button
              type="button"
              onClick={() => {
                if (interactionBlocked()) return;
                setUseBackupCode(false);
                setBackupCode('');
                clearError();
              }}
              disabled={isLoading}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors mx-auto block"
            >
              {method === 'email' ? 'Use email code instead' : 'Use authenticator code instead'}
            </button>
          )}
          {method === 'email' && (
            <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-slate-400">
              If this is your last backup code, it can finish this sign-in. If email stays unavailable, sign out afterward and sign in with your password again to open recovery and switch to Authenticator App 2FA.
            </p>
          )}
          {method === 'email' && emailDeliveryState === 'unavailable' && activeEmailDelivery?.recoveryAvailable === true && onRecoverEmail && (
            <button
              type="button"
              onClick={() => {
                if (interactionBlocked()) return;
                setShowRecovery(true);
                setBackupCode('');
                clearError();
              }}
              disabled={isLoading}
              className="mx-auto mt-4 block text-xs font-medium text-amber-300 transition-colors hover:text-amber-200"
            >
              No backup codes remain? Recover access
            </button>
          )}
          {method === 'email' && emailDeliveryState === 'unavailable' && activeEmailDelivery?.recoveryAvailable !== true && (
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              {activeEmailDelivery?.recoveryAvailable === false
                ? 'Recovery is unavailable while Portal still has a backup code on record. If you no longer have any saved code, an administrator must repair the account from the server console.'
                : 'Portal could not confirm whether recovery is safe. Use a backup code, or ask an administrator to repair the account from the server console.'}
            </p>
          )}
        </form>
      )}

      <AnimatePresence>
        {error && (
          <motion.div
            role="alert"
            aria-live="assertive"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="text-red-400 text-sm rounded-xl px-4 py-2.5 overflow-hidden"
            style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.15)',
            }}
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={onCancel}
        disabled={isLoading}
        className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors mx-auto"
      >
        <ArrowLeft size={14} />
        Back to sign in
      </button>
    </motion.div>
  );
}

export default function LoginPage() {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const authOperationRef = useRef<AuthOperation | null>(null);
  const [authOperation, setAuthOperation] = useState<AuthOperation | null>(null);
  const publicSettings = usePublicSettings();
  const registrationMode = publicSettings?.registrationMode;
  const registrationAvailable = registrationMode === 'open' || registrationMode === 'approval';
  const {
    login,
    signup,
    completeTwoFactor,
    recoverEmailTwoFactor,
    cancelTwoFactor,
    twoFactorPending,
    twoFactorPendingToken,
    twoFactorMethod,
    twoFactorEmailDelivery,
    isLoading,
    error,
    clearError,
  } = useAuthStore();
  const searchParams = new URLSearchParams(window.location.search);
  const passwordChanged = searchParams.get('password') === 'changed';
  const displayError = formError || error;
  const authBusy = isLoading || authOperation !== null;
  const primaryBusy = !twoFactorPending && authBusy;
  const verificationBusy = authOperation === 'two-factor'
    || (twoFactorPending && isLoading && authOperation === null);
  const recoveryBusy = authOperation === 'recover-email-two-factor';

  const beginAuthOperation = useCallback((operation: AuthOperation) => {
    if (authOperationRef.current || isLoading) return false;
    authOperationRef.current = operation;
    setAuthOperation(operation);
    return true;
  }, [isLoading]);

  const finishAuthOperation = useCallback((operation: AuthOperation) => {
    if (authOperationRef.current !== operation) return;
    authOperationRef.current = null;
    setAuthOperation(null);
  }, []);

  const isAuthOperationActive = useCallback(
    () => authOperationRef.current !== null || isLoading,
    [isLoading],
  );

  const clearDisplayedError = useCallback(() => {
    setFormError(null);
    clearError();
  }, [clearError]);

  useEffect(() => {
    if (!authBusy && !registrationAvailable && isSignup) {
      setIsSignup(false);
      setFormError(null);
      clearError();
    }
  }, [authBusy, clearError, isSignup, registrationAvailable]);

  const handleRedirect = () => {
    const params = new URLSearchParams(window.location.search);
    const redirect = resolveSafePortalRedirect(params.get('redirect'), window.location.origin);
    window.location.assign(redirect || '/dashboard');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const operation: AuthOperation = isSignup ? 'signup' : 'login';
    const admittedEmail = email;
    const admittedUsername = username;
    const admittedPassword = password;
    const admittedRegistrationAvailable = registrationAvailable;

    if (operation === 'signup') {
      if (!admittedRegistrationAvailable) {
        setIsSignup(false);
        return;
      }
      const policyError = validatePortalPassword(admittedPassword);
      if (policyError) {
        setFormError(policyError);
        return;
      }
    }
    if (!beginAuthOperation(operation)) return;
    setAuthNotice(null);

    try {
      if (operation === 'signup') {
        const result = await signup(admittedEmail, admittedUsername, admittedPassword);
        if (result.pending) {
          const pendingMessage = result.message?.trim()
            || 'Your access request is pending administrator review.';
          const notificationGuidance = publicSettings?.mail?.available === false
            ? ' Email notifications are unavailable here, so an administrator may need to notify you directly after reviewing the request.'
            : '';
          setPassword('');
          setIsSignup(false);
          setAuthNotice(`${pendingMessage}${notificationGuidance}`);
        } else {
          handleRedirect();
        }
      } else {
        const result = await login(admittedEmail, admittedPassword);
        if (!result.requiresTwoFactor) {
          handleRedirect();
        }
        // If 2FA required, the UI will switch to 2FA input automatically
      }
    } catch {} finally {
      finishAuthOperation(operation);
    }
  };

  const handleTwoFactorSubmit = async (code: string) => {
    const operation: AuthOperation = 'two-factor';
    const admittedCode = code;
    if (!beginAuthOperation(operation)) return;
    try {
      await completeTwoFactor(admittedCode);
      handleRedirect();
    } catch {} finally {
      finishAuthOperation(operation);
    }
  };

  const handleResendTwoFactorEmail = async () => {
    const operation: AuthOperation = 'resend-two-factor';
    const admittedToken = twoFactorPendingToken;
    if (!admittedToken || !beginAuthOperation(operation)) return null;
    setFormError(null);
    clearError();
    try {
      const response = await authAPI.twoFactorSendEmail(admittedToken);
      return response.message || 'A verification code was sent to your email address.';
    } catch (resendError: any) {
      setFormError(
        resendError?.response?.data?.error
          || resendError?.response?.data?.message
          || 'The verification code could not be sent. Please try again.',
      );
      return null;
    } finally {
      finishAuthOperation(operation);
    }
  };

  const handleRecoverEmailTwoFactor = async (
    currentPassword: string,
    confirmation: string,
  ) => {
    const operation: AuthOperation = 'recover-email-two-factor';
    if (!beginAuthOperation(operation)) return false;
    setFormError(null);
    setAuthNotice(null);
    clearError();
    try {
      const response = await recoverEmailTwoFactor(currentPassword, confirmation);
      setPassword('');
      setAuthNotice(response.message);
      return true;
    } catch (recoveryError: any) {
      if (
        recoveryError instanceof TwoFactorEmailRecoveryIndeterminateError
        || recoveryError?.requiresFreshLogin === true
      ) {
        setPassword('');
        setAuthNotice(
          recoveryError.message
          || 'Portal could not confirm the recovery result. Sign in again to verify the account state before retrying.',
        );
        return true;
      }
      setFormError(
        recoveryError?.response?.data?.error
          || recoveryError?.response?.data?.message
          || 'Email Code recovery failed. Sign in again and retry.',
      );
      return false;
    } finally {
      finishAuthOperation(operation);
    }
  };

  const handleCancelTwoFactor = () => {
    if (isAuthOperationActive()) return;
    cancelTwoFactor();
    setPassword('');
    setAuthNotice(null);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center relative overflow-hidden px-4"
      style={{ background: 'linear-gradient(135deg, #0A0E27 0%, #0d1117 40%, #0A0E27 70%, #111827 100%)' }}>

      {/* Static accents avoid running large blurred GPU animations on low-spec clients. */}
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-32 -left-24 h-80 w-80 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-blue-500/10 blur-3xl" />
      </div>

      {/* Subtle grid overlay */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />

      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md relative z-10"
      >
        {/* Glassmorphism card */}
        <div className="relative rounded-2xl p-8 overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 0 60px rgba(16, 185, 129, 0.06), 0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
          }}>

          {/* Top glow line */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />

          <AnimatePresence mode="wait">
            {twoFactorPending ? (
              <motion.div
                key="2fa"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
              >
                <TwoFactorInput
                  onSubmit={handleTwoFactorSubmit}
                  onCancel={handleCancelTwoFactor}
                  onResendEmail={
                    twoFactorMethod === 'email'
                    && twoFactorPendingToken
                    && twoFactorEmailDelivery?.state !== 'unavailable'
                      ? handleResendTwoFactorEmail
                      : undefined
                  }
                  onRecoverEmail={
                    twoFactorMethod === 'email'
                    && twoFactorPendingToken
                    && twoFactorEmailDelivery?.state === 'unavailable'
                    && twoFactorEmailDelivery.recoveryAvailable === true
                      ? handleRecoverEmailTwoFactor
                      : undefined
                  }
                  isLoading={authBusy}
                  verificationBusy={verificationBusy}
                  recoveryBusy={recoveryBusy}
                  interactionBlocked={isAuthOperationActive}
                  error={displayError}
                  clearError={clearDisplayedError}
                  method={twoFactorMethod || 'totp'}
                  emailDelivery={twoFactorEmailDelivery}
                />
              </motion.div>
            ) : (
              <motion.div
                key="login"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="text-center mb-8"
                >
                  <PublicAuthBrand />
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={isSignup ? 'signup' : 'signin'}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="text-slate-400 text-sm mt-2"
                    >
                      {isSignup
                        ? registrationMode === 'approval' ? 'Request portal access' : 'Create your account'
                        : 'Welcome back'}
                    </motion.p>
                  </AnimatePresence>
                </motion.div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                    <label htmlFor="login-email" className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">Email</label>
                    <input
                      id="login-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        if (isAuthOperationActive()) return;
                        setEmail(e.target.value);
                        setFormError(null);
                        clearError();
                      }}
                      disabled={authBusy}
                      className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm outline-none transition-all duration-300"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'rgba(16,185,129,0.4)';
                        e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2), 0 0 20px rgba(16,185,129,0.08)';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'rgba(255,255,255,0.08)';
                        e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2)';
                      }}
                      placeholder="you@example.com"
                      required
                    />
                  </motion.div>

                  <AnimatePresence>
                    {isSignup && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                        className="overflow-hidden"
                      >
                        <label htmlFor="signup-username" className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">Username</label>
                        <input
                          id="signup-username"
                          type="text"
                          autoComplete="username"
                          value={username}
                          onChange={(e) => {
                            if (isAuthOperationActive()) return;
                            setUsername(e.target.value);
                            setFormError(null);
                            clearError();
                          }}
                          disabled={authBusy}
                          className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm outline-none transition-all duration-300"
                          style={{
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)',
                          }}
                          onFocus={(e) => {
                            e.target.style.borderColor = 'rgba(16,185,129,0.4)';
                            e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2), 0 0 20px rgba(16,185,129,0.08)';
                          }}
                          onBlur={(e) => {
                            e.target.style.borderColor = 'rgba(255,255,255,0.08)';
                            e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2)';
                          }}
                          placeholder="username"
                          required={isSignup}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
                    <label htmlFor="login-password" className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">Password</label>
                    <div className="relative">
                      <input
                        id="login-password"
                        type={showPass ? 'text' : 'password'}
                        autoComplete={isSignup ? 'new-password' : 'current-password'}
                        value={password}
                        onChange={(e) => {
                          if (isAuthOperationActive()) return;
                          setPassword(e.target.value);
                          setFormError(null);
                          clearError();
                        }}
                        disabled={authBusy}
                        className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm pr-10 outline-none transition-all duration-300"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)',
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor = 'rgba(16,185,129,0.4)';
                          e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2), 0 0 20px rgba(16,185,129,0.08)';
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = 'rgba(255,255,255,0.08)';
                          e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2)';
                        }}
                        placeholder="••••••••"
                        minLength={isSignup ? 8 : undefined}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => { if (!isAuthOperationActive()) setShowPass(!showPass); }}
                        disabled={authBusy}
                        aria-label={showPass ? 'Hide password' : 'Show password'}
                        aria-pressed={showPass}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-emerald-400 transition-colors duration-200"
                      >
                        {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    {!isSignup && (
                      <div className="flex justify-end mt-1.5">
                        <Link
                          to="/forgot-password"
                          aria-disabled={authBusy}
                          tabIndex={authBusy ? -1 : undefined}
                          onClick={(event) => { if (isAuthOperationActive()) event.preventDefault(); }}
                          className={`text-xs text-emerald-400 transition-colors duration-200 ${authBusy ? 'pointer-events-none opacity-50' : 'hover:text-emerald-300'}`}
                        >
                          Forgot password?
                        </Link>
                      </div>
                    )}
                    {isSignup && (
                      <p className="mt-1.5 text-xs text-slate-500">Use 8+ characters with uppercase, lowercase, and a number.</p>
                    )}
                  </motion.div>

                  <AnimatePresence>
                    {authNotice && !displayError && (
                      <motion.div
                        role="status"
                        aria-live="polite"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="text-emerald-300 text-sm rounded-xl px-4 py-2.5 overflow-hidden"
                        style={{
                          background: 'rgba(16,185,129,0.08)',
                          border: '1px solid rgba(16,185,129,0.15)',
                        }}
                      >
                        {authNotice}
                      </motion.div>
                    )}
                    {passwordChanged && !authNotice && !displayError && (
                      <motion.div
                        role="status"
                        aria-live="polite"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="text-emerald-300 text-sm rounded-xl px-4 py-2.5 overflow-hidden"
                        style={{
                          background: 'rgba(16,185,129,0.08)',
                          border: '1px solid rgba(16,185,129,0.15)',
                        }}
                      >
                        Your password was changed successfully. For safety, all active sessions were signed out. Sign in again with your new password.
                      </motion.div>
                    )}
                    {displayError && (
                      <motion.div
                        role="alert"
                        aria-live="assertive"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="text-red-400 text-sm rounded-xl px-4 py-2.5 overflow-hidden"
                        style={{
                          background: 'rgba(239,68,68,0.08)',
                          border: '1px solid rgba(239,68,68,0.15)',
                        }}
                      >
                        {displayError}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
                    <motion.button
                      type="submit"
                      disabled={authBusy}
                      aria-busy={primaryBusy}
                      whileHover={{ scale: 1.01, boxShadow: '0 0 30px rgba(16,185,129,0.25)' }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full py-3 rounded-xl text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 relative overflow-hidden"
                      style={{
                        background: 'linear-gradient(135deg, #10b981, #059669)',
                        boxShadow: '0 0 20px rgba(16,185,129,0.15), 0 4px 15px rgba(0,0,0,0.3)',
                      }}
                    >
                      {primaryBusy && <Loader2 size={16} className="animate-spin" />}
                      {primaryBusy
                        ? authOperation === 'signup'
                          ? registrationMode === 'approval' ? 'Submitting request…' : 'Creating account…'
                          : 'Signing in…'
                        : isSignup
                          ? registrationMode === 'approval' ? 'Submit Access Request' : 'Create Account'
                          : 'Sign In'}
                    </motion.button>
                  </motion.div>
                </form>

                {(isSignup || registrationAvailable) && <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="text-center text-sm text-slate-400 mt-6"
                >
                  {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
                  <button
                    type="button"
                    onClick={() => {
                      if (isAuthOperationActive()) return;
                      setIsSignup(!isSignup);
                      setFormError(null);
                      clearError();
                    }}
                    disabled={authBusy}
                    className="text-emerald-400 hover:text-emerald-300 transition-colors duration-200 font-medium"
                  >
                    {isSignup ? 'Sign In' : registrationMode === 'approval' ? 'Request Access' : 'Sign Up'}
                  </button>
                </motion.p>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
