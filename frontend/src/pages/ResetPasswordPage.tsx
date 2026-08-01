import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Eye, EyeOff, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import client from '../api/client';
import PublicAuthBrand from '../components/PublicAuthBrand';
import { usePasswordRecoveryCapability } from '../hooks/usePasswordRecoveryCapability';
import { validatePortalPassword } from '../utils/passwordPolicy';

function MissingResetTokenPage() {
  const recoveryCapability = usePasswordRecoveryCapability();

  return (
    <div
      className="min-h-dvh flex items-center justify-center relative overflow-hidden px-4"
      style={{ background: 'linear-gradient(135deg, #0A0E27 0%, #0d1117 40%, #0A0E27 70%, #111827 100%)' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-md relative z-10"
      >
        <div
          className="relative rounded-2xl p-8 overflow-hidden text-center"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 0 60px rgba(16, 185, 129, 0.06), 0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          }}
        >
          <AlertTriangle className="text-amber-400 mx-auto mb-4" size={40} />
          <h2 className="text-lg font-semibold text-white mb-2">Invalid Reset Link</h2>
          <p className="text-slate-400 text-sm mb-5">This password reset link is invalid or missing a token.</p>

          {!recoveryCapability.capability ? (
            <div
              role={recoveryCapability.checkState === 'failed' ? 'alert' : 'status'}
              aria-live="polite"
              className="mb-5 rounded-xl border border-amber-300/15 bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-100"
            >
              <div className="flex items-center justify-center gap-2">
                {recoveryCapability.checkState === 'checking'
                  ? <Loader2 size={15} className="animate-spin" />
                  : <AlertTriangle size={15} />}
                <span>
                  {recoveryCapability.checkState === 'checking'
                    ? 'Checking whether another reset link can be requested…'
                    : 'Portal could not verify whether reset email is available.'}
                </span>
              </div>
              {(recoveryCapability.checkState === 'failed' || recoveryCapability.retrying) && (
                <button
                  type="button"
                  onClick={() => void recoveryCapability.retry()}
                  disabled={recoveryCapability.retrying}
                  aria-busy={recoveryCapability.retrying}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-100 underline decoration-amber-200/40 underline-offset-4 hover:text-white disabled:opacity-50"
                >
                  {recoveryCapability.retrying
                    ? <Loader2 size={13} className="animate-spin" />
                    : <RefreshCw size={13} />}
                  {recoveryCapability.retrying ? 'Checking again…' : 'Retry availability check'}
                </button>
              )}
            </div>
          ) : recoveryCapability.capability.available ? (
            <Link
              to="/forgot-password"
              className="text-emerald-400 hover:text-emerald-300 transition-colors text-sm font-medium"
            >
              Request a new reset link
            </Link>
          ) : (
            <div role="status" aria-live="polite" className="mb-5">
              <p className="text-sm leading-relaxed text-amber-100">
                {recoveryCapability.capability.reason
                  || 'Password reset email is unavailable for this Portal installation.'}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                A new link cannot be emailed from this Portal mode. Ask a Portal administrator for help.
              </p>
            </div>
          )}

          <div className="mt-5">
            <Link
              to="/login"
              className="text-slate-400 hover:text-white transition-colors text-sm font-medium"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const [token] = useState(() => {
    const fragmentParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    // Fragment is the current safe transport. Query support keeps already-issued
    // reset emails usable across the upgrade.
    return fragmentParams.get('token') || searchParams.get('token') || '';
  });

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [resetLinkInvalid, setResetLinkInvalid] = useState(false);
  const submissionRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    const scrubbed = new URL(window.location.href);
    scrubbed.searchParams.delete('token');
    const fragmentParams = new URLSearchParams(scrubbed.hash.replace(/^#/, ''));
    fragmentParams.delete('token');
    const remainingFragment = fragmentParams.toString();
    scrubbed.hash = remainingFragment ? `#${remainingFragment}` : '';
    window.history.replaceState(
      window.history.state,
      '',
      `${scrubbed.pathname}${scrubbed.search}${scrubbed.hash}`,
    );
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submissionRef.current) return;
    setError('');
    setResetLinkInvalid(false);

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    const policyError = validatePortalPassword(newPassword);
    if (policyError) {
      setError(policyError);
      return;
    }

    const admittedToken = token;
    const admittedPassword = newPassword;
    submissionRef.current = true;
    setIsLoading(true);
    try {
      await client.post('/auth/reset-password', { token: admittedToken, newPassword: admittedPassword });
      setSuccess(true);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || 'Something went wrong. Please try again.';
      if (
        Number(err?.response?.status) === 400
        && /invalid|expired/i.test(msg)
        && /reset|token|link/i.test(msg)
      ) {
        setResetLinkInvalid(true);
        setError('This password reset link is invalid or expired.');
      } else {
        setError(msg);
      }
    } finally {
      submissionRef.current = false;
      setIsLoading(false);
    }
  };

  // No token provided
  if (!token) {
    return <MissingResetTokenPage />;
  }

  const inputStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)',
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = 'rgba(16,185,129,0.4)';
    e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2), 0 0 20px rgba(16,185,129,0.08)';
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = 'rgba(255,255,255,0.08)';
    e.target.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.2)';
  };

  return (
    <div
      className="min-h-dvh flex items-center justify-center relative overflow-hidden px-4"
      style={{ background: 'linear-gradient(135deg, #0A0E27 0%, #0d1117 40%, #0A0E27 70%, #111827 100%)' }}
    >
      {/* Static accents keep the public shell responsive on low-spec devices. */}
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
        <div
          className="relative rounded-2xl p-8 overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 0 60px rgba(16, 185, 129, 0.06), 0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
          }}
        >
          {/* Top glow line */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-center mb-8"
          >
            <PublicAuthBrand />
            <p className="text-slate-400 text-sm mt-2">Set your new password</p>
          </motion.div>

          <AnimatePresence mode="wait">
            {success ? (
              <motion.div
                key="success"
                role="status"
                aria-live="polite"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-center"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                  style={{
                    background: 'rgba(16,185,129,0.1)',
                    border: '1px solid rgba(16,185,129,0.2)',
                  }}
                >
                  <CheckCircle className="text-emerald-400" size={28} />
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Password reset successfully</h2>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  Your password has been updated, and other active sessions have been signed out. You can now sign in with your new password.
                </p>
                <Link
                  to="/login?password=changed"
                  className="inline-block"
                >
                  <motion.div
                    whileHover={{ scale: 1.01, boxShadow: '0 0 30px rgba(16,185,129,0.25)' }}
                    whileTap={{ scale: 0.98 }}
                    className="px-8 py-3 rounded-xl text-white font-medium text-sm"
                    style={{
                      background: 'linear-gradient(135deg, #10b981, #059669)',
                      boxShadow: '0 0 20px rgba(16,185,129,0.15), 0 4px 15px rgba(0,0,0,0.3)',
                    }}
                  >
                    Go to Sign In
                  </motion.div>
                </Link>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="reset-new-password" className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">
                      New Password
                    </label>
                    <div className="relative">
                      <input
                        id="reset-new-password"
                        type={showPass ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={(e) => {
                          if (submissionRef.current) return;
                          setNewPassword(e.target.value);
                          setError('');
                        }}
                        disabled={isLoading}
                        className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm pr-10 outline-none transition-all duration-300"
                        style={inputStyle}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        placeholder="••••••••"
                        required
                        minLength={8}
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => { if (!submissionRef.current) setShowPass(!showPass); }}
                        disabled={isLoading}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-emerald-400 transition-colors duration-200"
                        aria-label={showPass ? 'Hide new password' : 'Show new password'}
                        aria-pressed={showPass}
                      >
                        {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    <p className="text-xs text-slate-500 mt-1.5">
                      Min 8 characters, 1 uppercase, 1 lowercase, 1 number
                    </p>
                  </div>

                  <div>
                    <label htmlFor="reset-confirm-password" className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">
                      Confirm Password
                    </label>
                    <div className="relative">
                      <input
                        id="reset-confirm-password"
                        type={showConfirm ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => {
                          if (submissionRef.current) return;
                          setConfirmPassword(e.target.value);
                          setError('');
                        }}
                        disabled={isLoading}
                        className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm pr-10 outline-none transition-all duration-300"
                        style={inputStyle}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        placeholder="••••••••"
                        required
                        minLength={8}
                      />
                      <button
                        type="button"
                        onClick={() => { if (!submissionRef.current) setShowConfirm(!showConfirm); }}
                        disabled={isLoading}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-emerald-400 transition-colors duration-200"
                        aria-label={showConfirm ? 'Hide confirmed password' : 'Show confirmed password'}
                        aria-pressed={showConfirm}
                      >
                        {showConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

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
                        {resetLinkInvalid && (
                          <div className="mt-2">
                            <Link
                              to="/forgot-password"
                              className="font-medium text-red-200 underline decoration-red-200/40 underline-offset-4 hover:text-white"
                            >
                              Review password recovery options
                            </Link>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <motion.button
                    type="submit"
                    disabled={isLoading}
                    aria-busy={isLoading}
                    whileHover={{ scale: 1.01, boxShadow: '0 0 30px rgba(16,185,129,0.25)' }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full py-3 rounded-xl text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 relative overflow-hidden"
                    style={{
                      background: 'linear-gradient(135deg, #10b981, #059669)',
                      boxShadow: '0 0 20px rgba(16,185,129,0.15), 0 4px 15px rgba(0,0,0,0.3)',
                    }}
                  >
                    {isLoading && <Loader2 size={16} className="animate-spin" />}
                    {isLoading ? 'Resetting password…' : 'Reset Password'}
                  </motion.button>
                </form>

                <p className="text-center text-sm text-slate-400 mt-6">
                  <Link
                    to="/login"
                    aria-disabled={isLoading}
                    tabIndex={isLoading ? -1 : undefined}
                    onClick={(event) => { if (submissionRef.current || isLoading) event.preventDefault(); }}
                    className={`text-emerald-400 transition-colors font-medium ${isLoading ? 'pointer-events-none opacity-50' : 'hover:text-emerald-300'}`}
                  >
                    Back to sign in
                  </Link>
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
