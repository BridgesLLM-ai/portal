import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import ViewportModal from "../ViewportModal";
import type { ProviderStatus } from "./ProviderCard";
import type { ProviderUIConfig } from "./providerConfig";

interface AwsSdkSetupFlowProps {
  provider: ProviderUIConfig;
  status?: ProviderStatus | null;
  refreshing?: boolean;
  onRefresh?: () => void | Promise<void>;
  onCancel: () => void;
}

const OPENCLAW_BEDROCK_DOCS = "https://docs.openclaw.ai/providers/bedrock";
const AWS_BEDROCK_KEY_DOCS =
  "https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html";

export default function AwsSdkSetupFlow({
  provider,
  status,
  refreshing = false,
  onRefresh,
  onCancel,
}: AwsSdkSetupFlowProps) {
  const readiness = status?.readiness;
  const readinessReady = readiness?.state === "ready";
  const readinessNeedsSetup = readiness?.state === "needs_setup";
  const ReadinessIcon = readinessReady ? CheckCircle2 : AlertTriangle;
  const readinessTitle = readinessReady
    ? "Amazon Bedrock is ready"
    : readiness?.state === "missing_plugin"
      ? "Provider plugin is missing"
      : readiness?.state === "plugin_unavailable"
        ? "Provider plugin needs attention"
        : readinessNeedsSetup
          ? "AWS setup is not ready"
          : readiness?.state === "probe_error"
            ? "Readiness check could not finish"
            : "Readiness has not been checked";
  const readinessMessage = readiness?.message
    || status?.error
    || status?.warning
    || "Portal has not run the bounded, read-only OpenClaw readiness check yet.";
  const readinessTone = readinessReady
    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-100"
    : readinessNeedsSetup
      ? "border-amber-500/25 bg-amber-500/10 text-amber-100"
      : readiness
        ? "border-red-500/25 bg-red-500/10 text-red-100"
        : "border-theme-border bg-theme-surface-raised text-theme-text";

  return (
    <ViewportModal
      open
      onDismiss={onCancel}
      className="bg-black/50 p-4 backdrop-blur-sm"
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-4xl overflow-y-auto rounded-3xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aws-sdk-setup-title"
      >
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-6 py-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
              Manual AWS setup
            </div>
            <h2
              id="aws-sdk-setup-title"
              className="mt-2 text-2xl font-semibold text-theme-text"
            >
              Connect {provider.name}
            </h2>
            <p className="mt-2 text-sm text-theme-text-subtle">
              {provider.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-theme-border bg-theme-surface-raised p-2 text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text"
            aria-label={`Close ${provider.name} setup`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-6">
          <div className={`flex flex-col gap-3 rounded-2xl border px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between ${readinessTone}`}>
            <div className="flex min-w-0 items-start gap-3">
              <ReadinessIcon className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <div className="font-semibold">{readinessTitle}</div>
                <p className="mt-1 leading-relaxed opacity-90">{readinessMessage}</p>
                {readiness ? (
                  <p className="mt-1 text-xs opacity-65">
                    Checked {new Date(readiness.checkedAt).toLocaleString()}
                    {readiness.cached ? " · cached result" : " · fresh result"}
                  </p>
                ) : null}
              </div>
            </div>
            {onRefresh ? (
              <button
                type="button"
                onClick={() => void onRefresh()}
                disabled={refreshing}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-current/20 bg-theme-surface px-3 py-2 text-xs font-semibold transition hover:bg-theme-surface-hover disabled:cursor-wait disabled:opacity-60"
              >
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Check again
              </button>
            ) : null}
          </div>

          <div className="flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <div className="font-semibold">
                Amazon Bedrock is not an OAuth provider
              </div>
              <p className="mt-1 leading-relaxed text-amber-100 opacity-90">
                There is no browser authorization callback for Portal to
                complete. OpenClaw authenticates with the AWS SDK credential
                chain on the gateway host. Portal deliberately does not collect
                AWS account access keys, SSO credentials, or instance-role
                credentials in this screen.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <div className="font-semibold">
                Use renewable credentials for production
              </div>
              <p className="mt-1 leading-relaxed text-emerald-100 opacity-[0.85]">
                Prefer an EC2 instance role or a renewable AWS shared
                profile/SSO session. On a non-AWS VPS, Bedrock bearer keys are
                supported through{" "}
                <code className="rounded bg-theme-surface-strong px-1 py-0.5">
                  AWS_BEARER_TOKEN_BEDROCK
                </code>
                ; AWS recommends short-term keys for production and describes
                long-term keys as exploration-only.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {provider.setupInstructions.map((instruction) => (
              <section
                key={instruction.stepNumber}
                className="rounded-2xl border border-theme-border bg-theme-surface-raised p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-sm font-semibold text-amber-300">
                    {instruction.stepNumber}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-theme-text">
                      {instruction.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-theme-text-subtle">
                      {instruction.detail}
                    </p>
                    {instruction.substeps?.length ? (
                      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-theme-text-subtle">
                        {instruction.substeps.map((substep) => (
                          <li key={substep}>{substep}</li>
                        ))}
                      </ul>
                    ) : null}
                    {instruction.link ? (
                      <a
                        href={instruction.link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-2 rounded-xl border border-theme-border-strong bg-theme-surface px-3 py-2 text-sm text-theme-text transition hover:bg-theme-surface-hover"
                      >
                        {instruction.link.label}
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    ) : null}
                  </div>
                </div>
              </section>
            ))}
          </div>

          <section className="rounded-2xl border border-theme-border bg-theme-surface-raised p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-theme-text">
              <Terminal className="h-4 w-4 text-amber-300" />
              OpenClaw discovery commands
            </div>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl border border-theme-border bg-theme-bg p-3 text-xs leading-6 text-theme-text-subtle">
              <code>{`openclaw plugins info amazon-bedrock
# If missing:
openclaw plugins install --pin @openclaw/amazon-bedrock-provider
# If installed but disabled:
openclaw plugins enable amazon-bedrock

openclaw config set plugins.entries.amazon-bedrock.config.discovery.enabled true
openclaw config set plugins.entries.amazon-bedrock.config.discovery.region us-east-1
openclaw models list --provider amazon-bedrock`}</code>
            </pre>
            <p className="mt-3 text-xs leading-relaxed text-theme-text-muted">
              Replace <code>us-east-1</code> with your AWS region. Environment
              credentials must be attached to the OpenClaw gateway service, and
              the gateway must be restarted after its environment changes.
            </p>
          </section>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-3 text-sm">
              <a
                href={AWS_BEDROCK_KEY_DOCS}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
              >
                AWS credential guide <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <a
                href={OPENCLAW_BEDROCK_DOCS}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
              >
                OpenClaw Bedrock guide <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl bg-theme-text px-4 py-2 text-sm font-semibold text-theme-surface transition hover:opacity-90"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </ViewportModal>
  );
}
