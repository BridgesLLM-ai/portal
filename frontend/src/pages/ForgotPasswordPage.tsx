import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ArrowLeft, Loader2, Mail, RefreshCw } from 'lucide-react';
import client from '../api/client';
import PublicAuthBrand from '../components/PublicAuthBrand';
import { usePasswordRecoveryCapability } from '../hooks/usePasswordRecoveryCapability';

export default function ForgotPasswordPage() {
  const recoveryCapability = usePasswordRecoveryCapability();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const submissionRef = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submissionRef.current) return;
    const admittedEmail = email;
    submissionRef.current = true;
    setError('');
    setIsLoading(true);

    try {
      await client.post('/auth/forgot-password', { email: admittedEmail });
      setSubmitted(true);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || 'Something went wrong. Please try again.';
      setError(msg);
    } finally {
      submissionRef.current = false;
      setIsLoading(false);
    }
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
            <p className="text-slate-400 text-sm mt-2">Reset your password</p>
          </motion.div>

          <AnimatePresence mode="wait">
            {!recoveryCapability.capability ? (
              <motion.div
                key="capability-check"
                role={recoveryCapability.checkState === 'failed' ? 'alert' : 'status'}
                aria-live="polite"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-center"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                  style={{
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.2)',
                  }}
                >
                  {recoveryCapability.checkState === 'checking'
                    ? <Loader2 className="animate-spin text-amber-300" size={28} />
                    : <AlertTriangle className="text-amber-300" size={28} />}
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">
                  {recoveryCapability.checkState === 'checking'
                    ? 'Checking password recovery'
                    : 'Recovery availability not verified'}
                </h2>
                <p className="text-slate-400 text-sm leading-relaxed mb-5">
                  {recoveryCapability.checkState === 'checking'
                    ? 'Portal is checking whether it can deliver password reset email.'
                    : 'Portal could not verify whether password reset email is available. No recovery request has been sent.'}
                </p>
                {(recoveryCapability.checkState === 'failed' || recoveryCapability.retrying) && (
                  <button
                    type="button"
                    onClick={() => void recoveryCapability.retry()}
                    disabled={recoveryCapability.retrying}
                    aria-busy={recoveryCapability.retrying}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-400/15 disabled:opacity-50"
                  >
                    {recoveryCapability.retrying
                      ? <Loader2 size={15} className="animate-spin" />
                      : <RefreshCw size={15} />}
                    {recoveryCapability.retrying ? 'Checking again…' : 'Retry availability check'}
                  </button>
                )}
                <div className="mt-6">
                  <Link
                    to="/login"
                    className="inline-flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition-colors text-sm font-medium"
                  >
                    <ArrowLeft size={16} />
                    Back to sign in
                  </Link>
                </div>
              </motion.div>
            ) : !recoveryCapability.capability.available ? (
              <motion.div
                key="unavailable"
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
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.2)',
                  }}
                >
                  <AlertTriangle className="text-amber-300" size={28} />
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Password recovery unavailable</h2>
                <p className="text-slate-300 text-sm leading-relaxed mb-3">
                  {recoveryCapability.capability.reason
                    || 'Password reset email is unavailable for this Portal installation.'}
                </p>
                <p className="text-slate-500 text-sm leading-relaxed mb-6">
                  Ask a Portal administrator for help. Existing reset links remain usable until they expire.
                </p>
                <Link
                  to="/login"
                  className="inline-flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition-colors text-sm font-medium"
                >
                  <ArrowLeft size={16} />
                  Back to sign in
                </Link>
              </motion.div>
            ) : submitted ? (
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
                  <Mail className="text-emerald-400" size={28} />
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Check your email</h2>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  If an account exists with that email, you'll receive a password reset link. The link expires in 1 hour.
                </p>
                <Link
                  to="/login"
                  className="inline-flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition-colors text-sm font-medium"
                >
                  <ArrowLeft size={16} />
                  Back to sign in
                </Link>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <p className="text-slate-400 text-sm mb-6 leading-relaxed">
                  Enter your email address and we'll send you a link to reset your password.
                </p>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="forgot-password-email" className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">
                      Email
                    </label>
                    <input
                      id="forgot-password-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        if (submissionRef.current) return;
                        setEmail(e.target.value);
                        setError('');
                      }}
                      disabled={isLoading}
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
                      autoFocus
                    />
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
                    {isLoading ? 'Sending reset link…' : 'Send Reset Link'}
                  </motion.button>
                </form>

                <p className="text-center text-sm text-slate-400 mt-6">
                  <Link
                    to="/login"
                    aria-disabled={isLoading}
                    tabIndex={isLoading ? -1 : undefined}
                    onClick={(event) => { if (submissionRef.current || isLoading) event.preventDefault(); }}
                    className={`inline-flex items-center gap-1.5 text-emerald-400 transition-colors font-medium ${isLoading ? 'pointer-events-none opacity-50' : 'hover:text-emerald-300'}`}
                  >
                    <ArrowLeft size={14} />
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
