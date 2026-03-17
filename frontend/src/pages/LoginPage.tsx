import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../contexts/AuthContext';
import { Eye, EyeOff, Loader2, ArrowLeft, Shield, Mail, RefreshCw } from 'lucide-react';
import { authAPI } from '../api/auth';

function TwoFactorInput({ onSubmit, onCancel, onResendEmail, isLoading, error, clearError, method }: {
  onSubmit: (code: string) => void;
  onCancel: () => void;
  onResendEmail?: () => void;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  method: 'totp' | 'email';
}) {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [resendCountdown, setResendCountdown] = useState(0);
  const [resending, setResending] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Resend countdown timer
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const handleDigitChange = useCallback((index: number, value: string) => {
    clearError();
    // Only allow digits
    const digit = value.replace(/\D/g, '').slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    // Auto-advance to next input
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (digit && index === 5) {
      const code = newDigits.join('');
      if (code.length === 6) {
        onSubmit(code);
      }
    }
  }, [digits, clearError, onSubmit]);

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }, [digits]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
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
  }, [digits, clearError, onSubmit]);

  const handleBackupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (backupCode.trim().length >= 6) {
      onSubmit(backupCode.trim());
    }
  };

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
        <h2 className="text-xl font-bold text-white mb-1">
          {method === 'email' ? 'Check your email' : 'Two-Factor Authentication'}
        </h2>
        <p className="text-sm text-slate-400">
          {useBackupCode
            ? 'Enter one of your backup codes'
            : method === 'email'
              ? 'We sent a 6-digit code to your email address'
              : 'Enter the 6-digit code from your authenticator app'
          }
        </p>
      </div>

      {!useBackupCode ? (
        <div>
          {/* Hidden auto-fill target — iOS/iPadOS fills this from Mail codes */}
          <input
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
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
          <div className="flex justify-center gap-2 mb-4" onPaste={handlePaste}>
            {digits.map((digit, i) => (
              <input
                key={i}
                ref={el => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
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

          <div className="flex flex-col items-center gap-2">
            {method === 'email' && onResendEmail && (
              <button
                type="button"
                onClick={async () => {
                  if (resendCountdown > 0 || resending) return;
                  setResending(true);
                  try {
                    await onResendEmail();
                    setResendCountdown(60);
                  } catch {} finally {
                    setResending(false);
                  }
                }}
                disabled={resendCountdown > 0 || resending}
                className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors disabled:text-slate-500 disabled:cursor-not-allowed"
              >
                <RefreshCw size={12} className={resending ? 'animate-spin' : ''} />
                {resendCountdown > 0 ? `Resend code (${resendCountdown}s)` : 'Resend code'}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setUseBackupCode(true); clearError(); }}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              Use a backup code instead
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleBackupSubmit}>
          <input
            type="text"
            value={backupCode}
            onChange={e => { setBackupCode(e.target.value); clearError(); }}
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
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className="w-full py-3 rounded-xl text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 mb-3"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 0 20px rgba(16,185,129,0.15), 0 4px 15px rgba(0,0,0,0.3)',
            }}
          >
            {isLoading && <Loader2 size={16} className="animate-spin" />}
            Verify Backup Code
          </motion.button>
          <button
            type="button"
            onClick={() => { setUseBackupCode(false); setBackupCode(''); clearError(); }}
            className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors mx-auto block"
          >
            {method === 'email' ? 'Use email code instead' : 'Use authenticator code instead'}
          </button>
        </form>
      )}

      <AnimatePresence>
        {error && (
          <motion.div
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
  const [mounted, setMounted] = useState(false);
  const { login, signup, completeTwoFactor, cancelTwoFactor, twoFactorPending, twoFactorPendingToken, twoFactorMethod, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => { setMounted(true); }, []);

  const handleRedirect = () => {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
      window.location.href = redirect;
      return;
    }
    if (redirect) {
      console.warn('[Security] Blocked open redirect attempt:', redirect);
    }
    navigate('/dashboard');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isSignup) {
        const result = await signup(email, username, password);
        if (!result.pending) {
          handleRedirect();
        }
      } else {
        const result = await login(email, password);
        if (!result.requiresTwoFactor) {
          handleRedirect();
        }
        // If 2FA required, the UI will switch to 2FA input automatically
      }
    } catch {}
  };

  const handleTwoFactorSubmit = async (code: string) => {
    try {
      await completeTwoFactor(code);
      handleRedirect();
    } catch {}
  };

  const handleCancelTwoFactor = () => {
    cancelTwoFactor();
    setPassword('');
  };

  return (
    <div className="min-h-dvh flex items-center justify-center relative overflow-hidden px-4"
      style={{ background: 'linear-gradient(135deg, #0A0E27 0%, #0d1117 40%, #0A0E27 70%, #111827 100%)' }}>

      {/* Animated background orbs */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          animate={{ scale: [1, 1.2, 1], opacity: [0.08, 0.15, 0.08] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-emerald-500 rounded-full blur-[160px]"
        />
        <motion.div
          animate={{ scale: [1.2, 1, 1.2], opacity: [0.06, 0.12, 0.06] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-blue-500 rounded-full blur-[140px]"
        />
        <motion.div
          animate={{ scale: [1, 1.3, 1], opacity: [0.04, 0.08, 0.04] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-500 rounded-full blur-[180px]"
        />
      </div>

      {/* Subtle grid overlay */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />

      {/* Floating particles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {mounted && [...Array(6)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 bg-emerald-400/30 rounded-full"
            initial={{ x: `${15 + i * 15}%`, y: '110%' }}
            animate={{ y: '-10%', opacity: [0, 0.6, 0] }}
            transition={{ duration: 8 + i * 2, repeat: Infinity, delay: i * 1.5, ease: 'linear' }}
          />
        ))}
      </div>

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
                  onResendEmail={twoFactorMethod === 'email' && twoFactorPendingToken ? async () => {
                    await authAPI.twoFactorSendEmail(twoFactorPendingToken);
                  } : undefined}
                  isLoading={isLoading}
                  error={error}
                  clearError={clearError}
                  method={twoFactorMethod || 'totp'}
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
                  <motion.div
                    whileHover={{ scale: 1.05 }}
                    className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 relative"
                    style={{
                      background: 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05))',
                      border: '1px solid rgba(16,185,129,0.2)',
                      boxShadow: '0 0 30px rgba(16,185,129,0.15), inset 0 1px 0 rgba(16,185,129,0.1)',
                    }}
                  >
                    <span className="text-emerald-400 font-bold text-2xl">B</span>
                  </motion.div>
                  <h1 className="text-2xl font-bold text-white tracking-tight">
                    Bridges<span className="text-emerald-400">LLM</span>
                  </h1>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={isSignup ? 'signup' : 'signin'}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="text-slate-400 text-sm mt-2"
                    >
                      {isSignup ? 'Create your account' : 'Welcome back'}
                    </motion.p>
                  </AnimatePresence>
                </motion.div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                    <label className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">Email</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); clearError(); }}
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
                        <label className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">Username</label>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
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
                    <label className="text-xs font-medium text-slate-400 mb-1.5 block uppercase tracking-wider">Password</label>
                    <div className="relative">
                      <input
                        type={showPass ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); clearError(); }}
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
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPass(!showPass)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-emerald-400 transition-colors duration-200"
                      >
                        {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    {!isSignup && (
                      <div className="flex justify-end mt-1.5">
                        <Link
                          to="/forgot-password"
                          className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors duration-200"
                        >
                          Forgot password?
                        </Link>
                      </div>
                    )}
                  </motion.div>

                  <AnimatePresence>
                    {error && (
                      <motion.div
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

                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
                    <motion.button
                      type="submit"
                      disabled={isLoading}
                      whileHover={{ scale: 1.01, boxShadow: '0 0 30px rgba(16,185,129,0.25)' }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full py-3 rounded-xl text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 relative overflow-hidden"
                      style={{
                        background: 'linear-gradient(135deg, #10b981, #059669)',
                        boxShadow: '0 0 20px rgba(16,185,129,0.15), 0 4px 15px rgba(0,0,0,0.3)',
                      }}
                    >
                      {isLoading && <Loader2 size={16} className="animate-spin" />}
                      {isSignup ? 'Create Account' : 'Sign In'}
                    </motion.button>
                  </motion.div>
                </form>

                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="text-center text-sm text-slate-400 mt-6"
                >
                  {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
                  <button
                    onClick={() => { setIsSignup(!isSignup); clearError(); }}
                    className="text-emerald-400 hover:text-emerald-300 transition-colors duration-200 font-medium"
                  >
                    {isSignup ? 'Sign In' : 'Sign Up'}
                  </button>
                </motion.p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
