/**
 * ExecApprovalModal — Dark glass-morphism modal for exec command approvals.
 * 
 * Shows when the agent requests permission to run a shell command.
 * The user can Approve, Always Allow, or Deny the command.
 * 
 * Auto-expires based on the expiresAtMs from the approval request.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Shield, Terminal, Clock, CheckCircle2, XCircle, ShieldCheck, Loader2 } from 'lucide-react';
import type { ExecApprovalRequest } from './useAgentRuntime';
import ViewportModal from '../ViewportModal';

type ExecApprovalDecision = 'allow-once' | 'deny' | 'allow-always';

interface ExecApprovalModalProps {
  approval: ExecApprovalRequest;
  queueCount?: number;
  onResolve: (approvalId: string, decision: 'allow-once' | 'deny' | 'allow-always') => void | Promise<void>;
  onDismiss: (approvalId: string) => void;
}

export function ExecApprovalModal({ approval, queueCount = 1, onResolve, onDismiss }: ExecApprovalModalProps) {
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [isClosing, setIsClosing] = useState(false);
  const [resolvingDecision, setResolvingDecision] = useState<ExecApprovalDecision | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const isResolving = resolvingDecision !== null;

  // Mount sites key this modal by approval id, but guard here too: stale
  // isResolving/isClosing carried into the next queued approval renders it
  // dead (buttons stuck spinning) or invisible while the agent waits on it.
  useEffect(() => {
    setIsClosing(false);
    setResolvingDecision(null);
    setResolveError(null);
  }, [approval.id]);

  const handleDismiss = useCallback(() => {
    if (isClosing || isResolving) return;
    setIsClosing(true);
    setTimeout(() => {
      onDismiss(approval.id);
    }, 200);
  }, [approval.id, isClosing, isResolving, onDismiss]);

  // Calculate and update time remaining
  useEffect(() => {
    const updateTimeLeft = () => {
      const remaining = Math.max(0, approval.expiresAtMs - Date.now());
      setTimeLeft(remaining);

      // Auto-dismiss when expired
      if (remaining <= 0) {
        handleDismiss();
      }
    };

    updateTimeLeft();
    const interval = setInterval(updateTimeLeft, 100);
    return () => clearInterval(interval);
  }, [approval.expiresAtMs, handleDismiss]);

  const handleDecision = useCallback((decision: ExecApprovalDecision) => {
    if (isResolving) return;
    setResolvingDecision(decision);
    setResolveError(null);
    Promise.resolve(onResolve(approval.id, decision)).catch((err: any) => {
      setResolvingDecision(null);
      const detail = err?.response?.data?.error || err?.message || '';
      setResolveError(detail && !/^Request failed/i.test(detail)
        ? `Couldn't submit decision (${detail}) — retry or deny.`
        : "Couldn't submit decision — retry or deny.");
    });
  }, [approval.id, onResolve, isResolving]);

  const handleButtonClick = useCallback((decision: ExecApprovalDecision) => (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    handleDecision(decision);
  }, [handleDecision]);

  // Format command for display (handle long commands)
  const formatCommand = (cmd: string) => {
    if (cmd.length > 200) {
      return cmd.substring(0, 200) + '…';
    }
    return cmd;
  };

  // Format time remaining
  const formatTimeLeft = (ms: number) => {
    const seconds = Math.ceil(ms / 1000);
    return `${seconds}s`;
  };

  // Calculate progress for the countdown ring
  const totalDuration = approval.expiresAtMs - approval.createdAtMs;
  const progress = totalDuration > 0
    ? Math.max(0, Math.min(1, timeLeft / totalDuration))
    : 0;

  return (
    <ViewportModal
      open={!isClosing}
      onDismiss={() => handleDecision('deny')}
      dismissible={!isResolving}
      initialFocusRef={denyButtonRef}
      className="bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[#0D1130]/95 shadow-2xl shadow-black/50 backdrop-blur-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="exec-approval-title"
      >
              {/* Header */}
              <div className="px-6 py-4 border-b border-white/10 flex items-center gap-3">
                <div className="p-2 bg-amber-500/20 rounded-xl">
                  <Shield className="w-5 h-5 text-amber-400" />
                </div>
                <div className="flex-1">
                  <h2 id="exec-approval-title" className="text-lg font-semibold text-white">Command Approval Required</h2>
                  <p className="text-sm text-white/60">
                    The agent wants to run a command{queueCount > 1 ? `, 1 of ${queueCount} pending` : ''}
                  </p>
                </div>
                {/* Countdown timer */}
                <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-full">
                  <Clock className="w-4 h-4 text-white/50" />
                  <span className={`text-sm font-mono ${timeLeft < 5000 ? 'text-red-400' : 'text-white/70'}`}>
                    {formatTimeLeft(timeLeft)}
                  </span>
                  {/* Progress ring */}
                  <svg className="w-4 h-4 -rotate-90" viewBox="0 0 20 20">
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="text-white/10"
                    />
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeDasharray={50.27}
                      strokeDashoffset={50.27 * (1 - progress)}
                      className={timeLeft < 5000 ? 'text-red-400' : 'text-amber-400'}
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>

              {/* Command display */}
              <div className="px-6 py-4 space-y-4">
                {/* Command */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-white/60">
                    <Terminal className="w-4 h-4" />
                    <span>Command</span>
                  </div>
                  <div className="bg-black/40 rounded-xl p-4 border border-white/5 overflow-x-auto">
                    <code className="text-sm font-mono text-emerald-300 whitespace-pre-wrap break-all">
                      {formatCommand(approval.request.command)}
                    </code>
                  </div>
                </div>

                {/* Working directory */}
                {approval.request.cwd && (
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-white/50">Working directory:</span>
                    <code className="px-2 py-1 bg-white/5 rounded-md font-mono text-white/80">
                      {approval.request.cwd}
                    </code>
                  </div>
                )}

                {/* Agent info */}
                {approval.request.agentId && (
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-white/50">Agent:</span>
                    <span className="text-white/80">{approval.request.agentId}</span>
                  </div>
                )}

                {approval.request.sessionKey && (
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-white/50">Session:</span>
                    <code className="px-2 py-1 bg-white/5 rounded-md font-mono text-white/80 break-all">
                      {approval.request.sessionKey}
                    </code>
                  </div>
                )}

                {queueCount > 1 && (
                  <div className="rounded-xl border border-amber-400/15 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                    {queueCount - 1} more approval{queueCount - 1 === 1 ? '' : 's'} waiting behind this one.
                  </div>
                )}

                {/* Host/Security info */}
                <div className="flex items-center gap-4 text-sm">
                  {approval.request.host && (
                    <div className="flex items-center gap-2">
                      <span className="text-white/50">Host:</span>
                      <span className="px-2 py-0.5 bg-violet-500/20 text-violet-300 rounded-md text-xs font-medium">
                        {approval.request.host}
                      </span>
                    </div>
                  )}
                  {approval.request.security && (
                    <div className="flex items-center gap-2">
                      <span className="text-white/50">Security:</span>
                      <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                        approval.request.security === 'full' 
                          ? 'bg-red-500/20 text-red-300' 
                          : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        {approval.request.security}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Resolve error */}
              {resolveError && (
                <div className="px-6 pb-2">
                  <div className="rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {resolveError}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-col gap-3 border-t border-white/10 px-6 py-4 sm:flex-row sm:items-center">
                {/* Deny button */}
                <button
                  ref={denyButtonRef}
                  type="button"
                  onClick={handleButtonClick('deny')}
                  disabled={isResolving}
                  aria-busy={resolvingDecision === 'deny'}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-xl transition-colors font-medium disabled:opacity-50"
                >
                  {resolvingDecision === 'deny' ? <Loader2 className="w-5 h-5 animate-spin" /> : <XCircle className="w-5 h-5" />}
                  {resolvingDecision === 'deny' ? 'Denying…' : 'Deny'}
                </button>

                {/* Always Allow button */}
                <button
                  type="button"
                  onClick={handleButtonClick('allow-always')}
                  disabled={isResolving}
                  aria-busy={resolvingDecision === 'allow-always'}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-violet-500/20 hover:bg-violet-500/30 text-violet-400 rounded-xl transition-colors font-medium disabled:opacity-50"
                >
                  {resolvingDecision === 'allow-always' ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShieldCheck className="w-5 h-5" />}
                  {resolvingDecision === 'allow-always' ? 'Allowing…' : 'Always Allow'}
                </button>

                {/* Approve button */}
                <button
                  type="button"
                  onClick={handleButtonClick('allow-once')}
                  disabled={isResolving}
                  aria-busy={resolvingDecision === 'allow-once'}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl transition-colors font-medium disabled:opacity-50"
                >
                  {resolvingDecision === 'allow-once' ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                  {resolvingDecision === 'allow-once' ? 'Approving…' : 'Approve'}
                </button>
              </div>

              {/* Warning footer */}
              <div className="px-6 py-3 bg-amber-500/5 border-t border-amber-500/10">
                <p className="text-xs text-amber-400/70 text-center">
                  ⚠️ This command will execute with the permissions of the server process.
                  Review carefully before approving.
                </p>
              </div>
      </motion.div>
    </ViewportModal>
  );
}
