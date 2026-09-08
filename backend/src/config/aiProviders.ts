export type AiProviderAuthType = 'api_key' | 'token' | 'oauth' | 'setup_token' | 'device_code' | 'native_cli' | 'aws_sdk';
export type AiProviderValidationMethod = 'bearer' | 'x-api-key' | 'query-param';

export interface StepInstruction {
  stepNumber: number;
  title: string;
  detail: string;
  substeps?: string[];
  link?: { url: string; label: string };
  note?: string;
}

export interface AiProviderModelPreset {
  id: string;
  name: string;
  tier: 'frontier' | 'balanced' | 'fast';
  description: string;
}

export interface AiProviderAuthOption {
  type: AiProviderAuthType;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface AiProviderDangerNote {
  title: string;
  detail: string;
  compactDetail?: string;
  link?: { url: string; label: string };
}

export type AiProviderGuidedSetup =
  | {
    status: 'available';
    authTypes: AiProviderAuthType[];
  }
  | {
    status: 'manual';
    reason: string;
    action: { url: string; label: string };
  };

export interface AiProviderMeta {
  id: string;
  name: string;
  icon: string;
  tier: 1 | 2 | 3;
  authTypes: AiProviderAuthType[];
  primaryAuthType: AiProviderAuthType;
  guidedSetup: AiProviderGuidedSetup;
  authOptions?: AiProviderAuthOption[];
  keyPrefix?: string;
  keyPlaceholder?: string;
  consoleUrl: string;
  signupUrl: string;
  pricingNote: string;
  freeTier: string | null;
  description: string;
  dangerNote?: AiProviderDangerNote;
  validationEndpoint?: string;
  validationMethod?: AiProviderValidationMethod;
  onboardAuthChoice?: string;
  onboardKeyFlag?: string;
  requiresPlugin?: string;
  defaultModels: AiProviderModelPreset[];
  setupInstructions: StepInstruction[];
}

const guidedSetup = (...authTypes: AiProviderAuthType[]): AiProviderGuidedSetup => ({
  status: 'available',
  authTypes,
});

const manualSetup = (
  reason: string,
  url: string,
  label = 'Open provider documentation',
): AiProviderGuidedSetup => ({
  status: 'manual',
  reason,
  action: { url, label },
});

export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'anthropic',
    name: 'Claude (OpenClaw)',
    icon: 'sparkles',
    tier: 1,
    authTypes: ['setup_token', 'api_key'],
    primaryAuthType: 'setup_token',
    guidedSetup: guidedSetup('setup_token', 'api_key'),
    keyPrefix: 'sk-ant-',
    keyPlaceholder: 'Paste an existing Claude setup-token',
    consoleUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    signupUrl: 'https://claude.ai/',
    pricingNote: 'Supports Anthropic API-key billing or an existing setup-token. This setup flow does not launch interactive Claude Code host sign-in.',
    freeTier: null,
    description: 'Connect Claude to OpenClaw with an API key or an existing setup-token. Claude Project Sandbox sign-in is a separate process-free flow.',
    validationEndpoint: 'https://api.anthropic.com/v1/models',
    validationMethod: 'x-api-key',
    onboardAuthChoice: 'anthropic-api-key',
    onboardKeyFlag: 'anthropic-api-key',
    defaultModels: [
      { id: 'anthropic/claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'frontier', description: 'Anthropic\'s latest model for demanding, long-horizon agentic work, with always-on adaptive thinking and a 1M-token context window.' },
      { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', tier: 'frontier', description: 'Anthropic\'s highest-capability Claude model with always-on adaptive thinking. Available through the supported Claude CLI path.' },
      { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', tier: 'frontier', description: 'Near-frontier Claude intelligence at roughly half the cost of Fable 5. A strong everyday default for demanding coding and reasoning work.' },
      { id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'frontier', description: 'Previous-generation frontier Claude model for complex reasoning and difficult tasks.' },
      { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'balanced', description: 'Proven all-round default for most users.' },
      { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'fast', description: 'Fastest and lowest-cost Claude model.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Choose an existing credential', detail: 'Use an Anthropic API key or paste a setup-token created in a separately managed environment.' },
      { stepNumber: 2, title: 'Paste and validate it', detail: 'Portal saves the supplied credential without launching the managed Claude Code host package.' },
      { stepNumber: 3, title: 'Activation unavailable', detail: 'Default-model routing is unchanged. Routing activation is unavailable in this release until a separately supported maintenance operation ships.' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT)',
    icon: 'sparkles',
    tier: 1,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    keyPrefix: 'sk-',
    keyPlaceholder: 'sk-proj-...',
    consoleUrl: 'https://platform.openai.com/settings/organization/api-keys',
    signupUrl: 'https://platform.openai.com/signup',
    pricingNote: 'Usage-based OpenAI Platform billing. Model availability and rates can change; verify them in the OpenAI pricing dashboard.',
    freeTier: null,
    description: 'GPT models. Strong general-purpose AI with wide tool and function support.',
    validationEndpoint: 'https://api.openai.com/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'openai-api-key',
    onboardKeyFlag: 'openai-api-key',
    defaultModels: [
      { id: 'openai/gpt-5.6', name: 'GPT-5.6', tier: 'frontier', description: 'Current OpenClaw default for direct OpenAI API-key agent setup. Account access can vary.' },
      { id: 'openai/gpt-5.5', name: 'GPT-5.5', tier: 'balanced', description: 'Compatibility choice when GPT-5.6 is unavailable to the configured OpenAI account.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Create an OpenAI account', detail: 'Go to https://platform.openai.com/signup. Sign up with email or Google/Microsoft account. Verify your email. You\'ll land on the Platform dashboard.', link: { url: 'https://platform.openai.com/signup', label: 'Open OpenAI Platform' } },
      { stepNumber: 2, title: 'Review billing and limits', detail: 'Open the Platform billing page and configure billing if your project requires it. Credits, limits, and model access are controlled by OpenAI and can differ by account.' },
      { stepNumber: 3, title: 'Create an API key', detail: 'Click "API keys" in the left sidebar (or go to https://platform.openai.com/settings/organization/api-keys). Click "Create new secret key". Name it anything (for example "my-portal"). Select "All" for permissions unless you have a reason to restrict.', link: { url: 'https://platform.openai.com/settings/organization/api-keys', label: 'Open OpenAI API Keys' } },
      { stepNumber: 4, title: 'Copy the key', detail: 'The key is shown ONCE. It starts with sk- (often sk-proj-). Copy it immediately. You cannot view it again after closing the dialog.' },
      { stepNumber: 5, title: 'Paste it in the field below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex (ChatGPT Subscription)',
    icon: 'code-2',
    tier: 1,
    authTypes: ['oauth'],
    primaryAuthType: 'oauth',
    guidedSetup: manualSetup(
      'Codex subscription sign-in is unavailable from Portal in this release. Supervised Agent Chat can use an existing attested host credential, and existing credentials are preserved.',
      'https://developers.openai.com/codex/auth',
      'Review Codex authentication documentation',
    ),
    consoleUrl: 'https://chatgpt.com/',
    signupUrl: 'https://chatgpt.com/',
    pricingNote: 'Uses your existing ChatGPT Plus/Pro/Team subscription. No per-token charges.',
    freeTier: 'Requires an eligible paid ChatGPT plan; eligibility is controlled by OpenAI.',
    description: 'Use your ChatGPT subscription for AI. OpenAI explicitly supports this for external tools.',
    onboardAuthChoice: 'openai-codex',
    defaultModels: [
      { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', tier: 'frontier', description: 'Newest Codex model. Availability depends on staged rollout and your ChatGPT account; seeing this candidate does not confirm access.' },
      { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', tier: 'frontier', description: 'Recommended GPT-5.6 tier and OpenClaw\'s fresh-setup default. Requires GPT-5.6 access on your ChatGPT account.' },
      { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', tier: 'balanced', description: 'Alternate GPT-5.6 tier. Availability depends on your ChatGPT plan.' },
      { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', tier: 'balanced', description: 'Alternate GPT-5.6 tier with maximum-effort thinking. Availability depends on your ChatGPT plan.' },
      { id: 'openai/gpt-5.5', name: 'GPT-5.5', tier: 'balanced', description: 'Compatibility choice for Codex workspaces that do not expose GPT-5.6.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Host sign-in unavailable in this release', detail: 'Portal preserves existing Codex subscription credentials but does not launch interactive Codex host sign-in. Supervised Agent Chat can use an existing attested host credential.', link: { url: 'https://developers.openai.com/codex/auth', label: 'Review Codex authentication documentation' } },
    ],
  },
  {
    id: 'google-gemini-cli',
    name: 'Google Gemini CLI (OpenClaw)',
    icon: 'terminal',
    tier: 1,
    authTypes: ['oauth'],
    primaryAuthType: 'oauth',
    guidedSetup: manualSetup(
      'Portal cannot launch the OpenClaw Gemini OAuth process in this release. Existing credentials remain readable.',
      'https://docs.openclaw.ai/providers/google',
      'Review OpenClaw Google provider documentation',
    ),
    consoleUrl: 'https://gemini.google.com/',
    signupUrl: 'https://gemini.google.com/',
    pricingNote: 'Uses Gemini CLI OAuth through OpenClaw. This is an unofficial Google integration; use a non-critical Google account if you are risk-sensitive.',
    freeTier: 'Depends on your Google Gemini plan/account',
    description: 'Use OpenClaw\'s bundled Gemini CLI backend with Google OAuth. This is separate from the native Antigravity agent path.',
    dangerNote: {
      title: 'Unofficial Google OAuth path',
      detail: 'OpenClaw documents Gemini CLI OAuth as an unofficial integration. Use a non-critical Google account if that risk matters to you.',
      compactDetail: 'Unofficial OAuth path; use a non-critical account if risk-sensitive.',
    },
    onboardAuthChoice: 'google-gemini-cli',
    defaultModels: [
      { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', tier: 'frontier', description: 'OpenClaw\'s default Gemini CLI model, stored under the canonical Google namespace.' },
      { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', tier: 'balanced', description: 'Balanced Gemini CLI model using the canonical Google model ID.' },
      { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', tier: 'fast', description: 'Fast Gemini CLI preset using the canonical Google model ID.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'OpenClaw OAuth maintenance required', detail: 'Portal preserves existing credentials but does not launch this OpenClaw host login flow in this release.' },
    ],
  },
  {
    id: 'google-antigravity',
    name: 'Google Antigravity',
    icon: 'globe',
    tier: 1,
    authTypes: ['native_cli'],
    primaryAuthType: 'native_cli',
    guidedSetup: guidedSetup('native_cli'),
    consoleUrl: 'https://gemini.google.com/',
    signupUrl: 'https://gemini.google.com/',
    pricingNote: 'Uses your Google/Gemini subscription through the Antigravity CLI on the server.',
    freeTier: 'Depends on your Google Gemini plan/account',
    description: 'Use Google Antigravity as Portal\'s native Gemini coding agent. OpenClaw\'s Gemini CLI OAuth remains a separate provider and credential path.',
    dangerNote: {
      title: 'Native Antigravity path',
      detail: 'Antigravity uses Portal\'s separate native CLI authentication and native Agent Chat harness. It does not register an OpenClaw provider or change OpenClaw\'s default model.',
      compactDetail: 'Portal-native auth and Agent Chat; separate from OpenClaw Gemini OAuth.',
    },
    defaultModels: [
      { id: 'google-antigravity/gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', tier: 'frontier', description: 'Highest-capability Gemini model currently reported by Antigravity.' },
      { id: 'google-antigravity/gemini-3.5-flash', name: 'Gemini 3.5 Flash', tier: 'balanced', description: 'Fast default Gemini model for most Antigravity tasks.' },
      { id: 'google-antigravity/gemini-3.5-flash-low', name: 'Gemini 3.5 Flash Low', tier: 'fast', description: 'Fastest Antigravity Gemini option.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Start Antigravity sign-in', detail: 'Use the portal native CLI login flow to start Antigravity on the server.' },
      { stepNumber: 2, title: 'Authorize with Google', detail: 'Open the Google authorization link and sign in with the Google account tied to your Gemini plan.' },
      { stepNumber: 3, title: 'Paste the authorization code', detail: 'Copy the authorization code from Google and paste it back into the portal so `agy` can finish signing in.' },
      { stepNumber: 4, title: 'Choose an exact Agent Chat model', detail: 'After login, Portal verifies Antigravity readiness, loads the exact models exposed by your account, and saves your choice for the native Gemini Agent Chat harness. OpenClaw defaults are not changed.' },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    icon: 'gem',
    tier: 1,
    authTypes: ['api_key', 'oauth'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    keyPrefix: 'AIza',
    keyPlaceholder: 'AIzaSy...',
    consoleUrl: 'https://aistudio.google.com/apikey',
    signupUrl: 'https://aistudio.google.com/',
    pricingNote: 'Google AI Studio API-key quotas and billing vary by model and project. Verify current limits in AI Studio.',
    freeTier: null,
    description: 'Google Gemini through a Google AI Studio API key, separate from Gemini CLI OAuth.',
    validationEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    validationMethod: 'query-param',
    onboardAuthChoice: 'gemini-api-key',
    onboardKeyFlag: 'gemini-api-key',
    defaultModels: [
      { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', tier: 'frontier', description: 'Current OpenClaw default for Google API-key setup.' },
      { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', tier: 'balanced', description: 'Balanced Gemini option; availability and quotas depend on the Google project.' },
      { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', tier: 'fast', description: 'Fast Gemini option for supported Google projects.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Go to Google AI Studio', detail: 'Open https://aistudio.google.com/apikey in your browser. Sign in with any Google account (Gmail works fine).', link: { url: 'https://aistudio.google.com/apikey', label: 'Open Google AI Studio API Keys' } },
      { stepNumber: 2, title: 'Click "Create API Key"', detail: 'On the API keys page, click the blue "Create API key" button.' },
      { stepNumber: 3, title: 'Select a Google Cloud project', detail: 'If prompted, either select an existing project or click "Create API key in new project". Google creates a project automatically — you do not need to configure anything.' },
      { stepNumber: 4, title: 'Copy the key', detail: 'The key appears in a dialog. It starts with AIza. Click the copy icon. Unlike OpenAI, you can view this key again later on this same page.' },
      { stepNumber: 5, title: 'Paste it in the field below', detail: 'Come back to this page and paste the key.', note: 'API-key quotas and billing are separate from Gemini CLI OAuth. The portal discovers live models after validation and uses this list only as an offline fallback.' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: 'route',
    tier: 1,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    keyPrefix: 'sk-or-',
    keyPlaceholder: 'sk-or-v1-...',
    consoleUrl: 'https://openrouter.ai/settings/keys',
    signupUrl: 'https://openrouter.ai/',
    pricingNote: 'Pricing and availability come from OpenRouter and the selected upstream model; verify current terms before use.',
    freeTier: null,
    description: 'One API key for a broad, live-discovered catalog of upstream model providers.',
    validationEndpoint: 'https://openrouter.ai/api/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'openrouter-api-key',
    onboardKeyFlag: 'openrouter-api-key',
    defaultModels: [
      { id: 'openrouter/anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6 via OpenRouter', tier: 'balanced', description: 'Claude Sonnet via OpenRouter.' },
      { id: 'openrouter/google/gemini-2.5-flash', name: 'Gemini 2.5 Flash via OpenRouter', tier: 'fast', description: 'Gemini Flash via OpenRouter.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Create an OpenRouter account', detail: 'Go to https://openrouter.ai/ and click "Sign Up" (top-right). You can sign up with Google, GitHub, or email.', link: { url: 'https://openrouter.ai/', label: 'Open OpenRouter' } },
      { stepNumber: 2, title: 'Review credits and limits', detail: 'Open the Credits page and add funds if required by the models you intend to use. Availability and pricing vary by model.' },
      { stepNumber: 3, title: 'Create an API key', detail: 'Go to https://openrouter.ai/settings/keys (or click your profile → "Keys"). Click "Create Key". Name it anything.', link: { url: 'https://openrouter.ai/settings/keys', label: 'Open OpenRouter Keys' } },
      { stepNumber: 4, title: 'Copy the key', detail: 'It starts with sk-or-. Copy it.' },
      { stepNumber: 5, title: 'Paste it in the field below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    icon: 'zap',
    tier: 1,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    authOptions: [
      {
        type: 'api_key',
        label: 'Use an xAI API key',
        description: 'Save an xAI developer API key without changing OpenClaw routing. Subscription OAuth mutation is unavailable in this release until a separately supported maintenance operation ships.',
        recommended: true,
      },
    ],
    keyPrefix: 'xai-',
    keyPlaceholder: 'xai-...',
    consoleUrl: 'https://x.ai/',
    signupUrl: 'https://x.ai/',
    pricingNote: 'Guided setup supports usage-based xAI API billing. OpenClaw subscription OAuth is unavailable from Portal in this release.',
    freeTier: null,
    description: 'Save a separately billed xAI API key. Portal does not enable the plugin, change auth order, register models, select defaults, or probe a host turn during credential entry.',
    validationEndpoint: 'https://api.x.ai/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'xai-api-key',
    onboardKeyFlag: 'xai-api-key',
    requiresPlugin: 'xai',
    defaultModels: [
      { id: 'xai/grok-4.5', name: 'Grok 4.5', tier: 'frontier', description: 'Newest Grok flagship (500K context). Credential setup does not register or select this model.' },
      { id: 'xai/grok-4.3', name: 'Grok 4.3', tier: 'frontier', description: 'General-purpose Grok model in the tested OpenClaw 2026.7.1 catalog.' },
      { id: 'xai/grok-build-0.1', name: 'Grok Build 0.1', tier: 'balanced', description: 'Coding/build model in the tested OpenClaw 2026.7.1 catalog.' },
      { id: 'xai/grok-4.20-beta-latest-reasoning', name: 'Grok 4.20 Beta Reasoning', tier: 'frontier', description: 'Reasoning beta from the tested OpenClaw catalog. Credential setup does not register, select, or probe it.' },
      { id: 'xai/grok-4.20-beta-latest-non-reasoning', name: 'Grok 4.20 Beta', tier: 'fast', description: 'Non-reasoning beta from the tested OpenClaw catalog. Credential setup does not register, select, or probe it.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Create an xAI API key', detail: 'Use the xAI Console to create a separately billed developer API key.', link: { url: 'https://console.x.ai/', label: 'Open xAI Console' } },
      { stepNumber: 2, title: 'Validate and save it', detail: 'Portal validates the key against xAI and saves only the credential.' },
      { stepNumber: 3, title: 'Activation unavailable', detail: 'Plugin policy, auth order, model registration, routing, and host probes remain unchanged. Those mutations and routing activation are unavailable in this release until a separately supported maintenance operation ships.' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    icon: 'wind',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    consoleUrl: 'https://console.mistral.ai/api-keys',
    signupUrl: 'https://console.mistral.ai/',
    pricingNote: 'Pay-per-token. Very competitive pricing.',
    freeTier: null,
    description: 'Mistral-hosted frontier and efficient models.',
    validationEndpoint: 'https://api.mistral.ai/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'mistral-api-key',
    onboardKeyFlag: 'mistral-api-key',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Create a Mistral account', detail: 'Go to https://console.mistral.ai/ and sign up.', link: { url: 'https://console.mistral.ai/', label: 'Open Mistral Console' } },
      { stepNumber: 2, title: 'Add payment', detail: 'Go to Billing and add a payment method.' },
      { stepNumber: 3, title: 'Create an API key', detail: 'Go to https://console.mistral.ai/api-keys. Click "Create new key". Name it.', link: { url: 'https://console.mistral.ai/api-keys', label: 'Open Mistral API Keys' } },
      { stepNumber: 4, title: 'Copy and paste it below', detail: 'Copy the new key and paste it into the field here.' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: 'rocket',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    keyPrefix: 'gsk_',
    keyPlaceholder: 'gsk_...',
    consoleUrl: 'https://console.groq.com/keys',
    signupUrl: 'https://console.groq.com/',
    pricingNote: 'Groq controls model pricing, quotas, and rate limits; verify current terms in the Groq Console.',
    freeTier: null,
    description: 'Extremely fast inference for supported models.',
    validationEndpoint: 'https://api.groq.com/openai/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'token',
    onboardKeyFlag: 'token',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Create a Groq account', detail: 'Go to https://console.groq.com/ and sign up with Google, GitHub, or email.', link: { url: 'https://console.groq.com/', label: 'Open Groq Console' } },
      { stepNumber: 2, title: 'Create an API key', detail: 'Click "API Keys" in the sidebar → "Create API Key". Name it.' },
      { stepNumber: 3, title: 'Copy the key', detail: 'It starts with gsk_. Copy it.' },
      { stepNumber: 4, title: 'Paste below', detail: 'Come back to this page and paste the key.' },
      { stepNumber: 5, title: 'If Groq onboard auth-choice is unavailable', detail: 'This roadmap expects groq-api-key. If your installed OpenClaw build does not support that auth choice, fall back to the generic token flow with provider groq.', note: 'This is a roadmap/codebase compatibility edge case. Document it if encountered.' },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    icon: 'layers-3',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    consoleUrl: 'https://api.together.ai/settings/api-keys',
    signupUrl: 'https://api.together.ai/',
    pricingNote: 'Usage-based Together AI billing; verify current model rates and any promotional credits in the provider console.',
    freeTier: null,
    description: 'Hosted open-source models and fine-tuning through one API key.',
    validationEndpoint: 'https://api.together.ai/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'together-api-key',
    onboardKeyFlag: 'together-api-key',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Create a Together AI account', detail: 'Go to https://api.together.ai/ and sign up.', link: { url: 'https://api.together.ai/', label: 'Open Together AI' } },
      { stepNumber: 2, title: 'Go to API Keys', detail: 'Navigate to https://api.together.ai/settings/api-keys.', link: { url: 'https://api.together.ai/settings/api-keys', label: 'Open Together API Keys' } },
      { stepNumber: 3, title: 'Create and copy the key', detail: 'Create a key and copy it from the dialog.' },
      { stepNumber: 4, title: 'Paste below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'search',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: guidedSetup('api_key'),
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    signupUrl: 'https://platform.deepseek.com/',
    pricingNote: 'Usage-based DeepSeek billing; verify current rates and account credits in the provider console.',
    freeTier: null,
    description: 'Low-cost reasoning and chat models from DeepSeek.',
    validationEndpoint: 'https://api.deepseek.com/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'deepseek-api-key',
    onboardKeyFlag: 'deepseek-api-key',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Create a DeepSeek account', detail: 'Go to https://platform.deepseek.com/ and sign up.', link: { url: 'https://platform.deepseek.com/', label: 'Open DeepSeek Platform' } },
      { stepNumber: 2, title: 'Go to API Keys', detail: 'Click "API Keys" in the sidebar.', link: { url: 'https://platform.deepseek.com/api_keys', label: 'Open DeepSeek API Keys' } },
      { stepNumber: 3, title: 'Create and copy a key', detail: 'Create a new key and copy it.' },
      { stepNumber: 4, title: 'Paste below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen (Model Provider)',
    icon: 'terminal-square',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'This is the OpenCode Zen hosted model-provider account used by OpenClaw. It is separate from the native OpenCode ACP harness and its Portal-profile login; Portal never copies credentials between them. Guided Zen key saving is not yet authoritative, so configure this account through reviewed OpenClaw server maintenance.',
      'https://opencode.ai',
      'Open OpenCode Zen documentation',
    ),
    consoleUrl: 'https://opencode.ai',
    signupUrl: 'https://opencode.ai',
    pricingNote: 'Access to multiple model providers through a single key.',
    freeTier: null,
    description: 'OpenCode Zen hosted model access for OpenClaw. This account does not configure the separate native OpenCode ACP harness.',
    onboardAuthChoice: 'opencode-zen',
    onboardKeyFlag: 'opencode-zen-api-key',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Open the OpenCode Zen site', detail: 'Go to https://opencode.ai and sign in or create an account for the hosted Zen model provider.', link: { url: 'https://opencode.ai', label: 'Open OpenCode Zen' } },
      { stepNumber: 2, title: 'Create or locate your Zen API key', detail: 'Follow the dashboard prompts to create a hosted Zen API key. This key is not imported into the native OpenCode harness profile.' },
      { stepNumber: 3, title: 'Copy the key', detail: 'Copy the full key value from the dashboard.' },
      { stepNumber: 4, title: 'Paste below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local Models)',
    icon: 'server',
    tier: 2,
    authTypes: ['token'],
    primaryAuthType: 'token',
    guidedSetup: manualSetup(
      'Ollama is configured through Portal’s dedicated Ollama controls, not through the OpenClaw credential modal.',
      'https://docs.ollama.com/',
      'Open Ollama documentation',
    ),
    consoleUrl: 'https://ollama.com/',
    signupUrl: 'https://ollama.com/',
    pricingNote: 'Runs on your own server hardware. No per-token fees.',
    freeTier: 'Local-only; compute costs are your own hardware.',
    description: 'Run models on this server, or connect to an Ollama host you control. Remote Ollama requests leave the Portal host. No provider API key is required.',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Use the existing Ollama section', detail: 'Ollama is already handled by the existing setup and settings UI. Use that section to pull models and verify the service is running.' },
    ],
  },
  {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    icon: 'cloud',
    tier: 3,
    authTypes: ['aws_sdk'],
    primaryAuthType: 'aws_sdk',
    guidedSetup: guidedSetup('aws_sdk'),
    consoleUrl: 'https://console.aws.amazon.com/bedrock',
    signupUrl: 'https://aws.amazon.com/bedrock/',
    pricingNote: 'AWS usage-based billing. Charges and model access depend on the selected AWS account and region.',
    freeTier: null,
    description: 'Uses AWS SDK credentials on the OpenClaw gateway host. Amazon Bedrock does not use an OAuth browser sign-in.',
    defaultModels: [],
    setupInstructions: [
      {
        stepNumber: 1,
        title: 'Enable Bedrock in the correct AWS account and region',
        detail: 'Sign in to the AWS console, choose the region you will use, and confirm that the required Bedrock models are available to that account.',
        link: { url: 'https://console.aws.amazon.com/bedrock', label: 'Open Amazon Bedrock console' },
      },
      {
        stepNumber: 2,
        title: 'Configure AWS credentials on the gateway host',
        detail: 'Use the AWS SDK default credential chain: an EC2 instance role, a shared AWS profile/SSO session, access-key environment variables, or AWS_BEARER_TOKEN_BEDROCK. Put environment credentials on the OpenClaw gateway service itself; exporting them in an unrelated shell is not enough.',
        substeps: [
          'Prefer an instance role or renewable shared-profile/SSO credentials for production.',
          'For a non-AWS VPS, a Bedrock bearer API key can be supplied as AWS_BEARER_TOKEN_BEDROCK. AWS recommends short-term keys for production and describes long-term keys as exploration-only.',
          'Set AWS_REGION (or AWS_DEFAULT_REGION) to the same region selected in the Bedrock console.',
        ],
        link: { url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html', label: 'Read AWS Bedrock credential guidance' },
      },
      {
        stepNumber: 3,
        title: 'Install the OpenClaw provider if it is missing',
        detail: 'This OpenClaw release may distribute the Bedrock provider separately. Check with "openclaw plugins info amazon-bedrock". If it is missing, install the official package with "openclaw plugins install --pin @openclaw/amazon-bedrock-provider".',
      },
      {
        stepNumber: 4,
        title: 'Enable model discovery',
        detail: 'Run "openclaw config set plugins.entries.amazon-bedrock.config.discovery.enabled true" and set the discovery region with "openclaw config set plugins.entries.amazon-bedrock.config.discovery.region us-east-1" (replace the region as needed). Restart the OpenClaw gateway after changing its environment.',
      },
      {
        stepNumber: 5,
        title: 'Verify the provider before selecting a model',
        detail: 'Run "openclaw models list --provider amazon-bedrock". The IAM principal needs bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream, bedrock:ListFoundationModels, and bedrock:ListInferenceProfiles. Do not select Bedrock until this command returns usable models.',
        link: { url: 'https://docs.openclaw.ai/providers/bedrock', label: 'Read the OpenClaw Bedrock guide' },
      },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    icon: 'smile',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Portal does not yet have an authoritative Hugging Face credential-validation and save flow. Configure it through reviewed OpenClaw server maintenance.',
      'https://huggingface.co/docs',
      'Open Hugging Face documentation',
    ),
    consoleUrl: 'https://huggingface.co/settings/tokens',
    signupUrl: 'https://huggingface.co/join',
    pricingNote: 'Varies by endpoint/provider.',
    freeTier: 'Some free hosted options',
    description: 'Hosted inference and model access from Hugging Face.',
    onboardAuthChoice: 'huggingface-api-key',
    onboardKeyFlag: 'huggingface-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create a Hugging Face token, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    icon: 'moon',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Portal does not yet have an authoritative Moonshot credential-validation and save flow. Configure it through reviewed OpenClaw server maintenance.',
      'https://platform.moonshot.ai/',
      'Open Moonshot documentation',
    ),
    consoleUrl: 'https://platform.moonshot.ai/',
    signupUrl: 'https://platform.moonshot.ai/',
    pricingNote: 'Provider pricing varies.',
    freeTier: null,
    description: 'Moonshot / Kimi API access.',
    onboardAuthChoice: 'moonshot-api-key',
    onboardKeyFlag: 'moonshot-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create a Moonshot key, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'venice',
    name: 'Venice AI',
    icon: 'venetian-mask',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Portal does not yet have an authoritative Venice credential-validation and save flow. Configure it through reviewed OpenClaw server maintenance.',
      'https://docs.venice.ai/',
      'Open Venice documentation',
    ),
    consoleUrl: 'https://venice.ai/',
    signupUrl: 'https://venice.ai/',
    pricingNote: 'Subscription/provider pricing.',
    freeTier: null,
    description: 'Venice-hosted AI access.',
    onboardAuthChoice: 'venice-api-key',
    onboardKeyFlag: 'venice-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create a Venice key, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    icon: 'cpu',
    tier: 3,
    authTypes: ['token'],
    primaryAuthType: 'token',
    guidedSetup: manualSetup(
      'Portal does not render or validate Cerebras token setup yet. Configure it through reviewed OpenClaw server maintenance.',
      'https://inference-docs.cerebras.ai/',
      'Open Cerebras documentation',
    ),
    consoleUrl: 'https://inference.cerebras.ai/',
    signupUrl: 'https://inference.cerebras.ai/',
    pricingNote: 'Provider pricing applies.',
    freeTier: null,
    description: 'Cerebras inference access via token-based auth.',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create a Cerebras token, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'kilocode',
    name: 'Kilo Gateway',
    icon: 'waypoints',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Portal does not yet have an authoritative Kilo Gateway credential-validation and save flow. Configure it through reviewed OpenClaw server maintenance.',
      'https://kilocode.ai/docs',
      'Open Kilo documentation',
    ),
    consoleUrl: 'https://kilocode.ai/',
    signupUrl: 'https://kilocode.ai/',
    pricingNote: 'Provider pricing varies.',
    freeTier: null,
    description: 'Kilo Gateway API access.',
    onboardAuthChoice: 'kilocode-api-key',
    onboardKeyFlag: 'kilocode-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create a Kilo Gateway key, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    icon: 'shield-cloud',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Cloudflare AI Gateway needs account, gateway, upstream-provider, and credential settings that Portal does not collect or validate as one transaction.',
      'https://developers.cloudflare.com/ai-gateway/',
      'Open Cloudflare AI Gateway documentation',
    ),
    consoleUrl: 'https://dash.cloudflare.com/',
    signupUrl: 'https://dash.cloudflare.com/sign-up',
    pricingNote: 'Cloudflare AI Gateway pricing applies.',
    freeTier: null,
    description: 'Requires account ID and gateway ID in addition to API key.',
    onboardAuthChoice: 'cloudflare-ai-gateway-api-key',
    onboardKeyFlag: 'cloudflare-ai-gateway-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Configure the account ID, gateway ID, upstream provider, and credentials through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'byteplus',
    name: 'BytePlus',
    icon: 'cable',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Portal does not yet have an authoritative BytePlus credential-validation and save flow. Configure it through reviewed OpenClaw server maintenance.',
      'https://docs.byteplus.com/',
      'Open BytePlus documentation',
    ),
    consoleUrl: 'https://console.byteplus.com/',
    signupUrl: 'https://console.byteplus.com/',
    pricingNote: 'Provider pricing varies.',
    freeTier: null,
    description: 'BytePlus model provider.',
    onboardAuthChoice: 'byteplus-api-key',
    onboardKeyFlag: 'byteplus-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create BytePlus credentials, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'volcengine',
    name: 'Volcengine',
    icon: 'flame',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Portal does not yet have an authoritative Volcengine credential-validation and save flow. Configure it through reviewed OpenClaw server maintenance.',
      'https://www.volcengine.com/docs/',
      'Open Volcengine documentation',
    ),
    consoleUrl: 'https://console.volcengine.com/',
    signupUrl: 'https://console.volcengine.com/',
    pricingNote: 'Provider pricing varies.',
    freeTier: null,
    description: 'Volcengine model provider.',
    onboardAuthChoice: 'volcengine-api-key',
    onboardKeyFlag: 'volcengine-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Create Volcengine credentials, then configure the provider through reviewed OpenClaw server maintenance.' }],
  },
  {
    id: 'custom',
    name: 'Custom / Self-hosted',
    icon: 'wrench',
    tier: 3,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    guidedSetup: manualSetup(
      'Custom providers need a base URL, compatibility mode, model IDs, and provider-specific credentials. Portal cannot safely reduce that to one API-key field.',
      'https://docs.openclaw.ai/',
      'Open OpenClaw provider documentation',
    ),
    consoleUrl: 'https://docs.openclaw.ai/',
    signupUrl: 'https://docs.openclaw.ai/',
    pricingNote: 'Depends on your own infrastructure.',
    freeTier: null,
    description: 'Bring your own OpenAI- or Anthropic-compatible endpoint.',
    onboardAuthChoice: 'custom-api-key',
    onboardKeyFlag: 'custom-api-key',
    defaultModels: [],
    setupInstructions: [{ stepNumber: 1, title: 'Manual configuration only', detail: 'Configure the base URL, compatibility mode, model IDs, and credentials through reviewed OpenClaw server maintenance.' }],
  },
];

const GUIDED_OAUTH_PROVIDERS = new Set<string>();

export function assertAiProviderGuidedSetupContract(provider: AiProviderMeta): void {
  if (provider.guidedSetup.status === 'manual') return;

  const authTypes = provider.guidedSetup.authTypes;
  if (!authTypes.length || new Set(authTypes).size !== authTypes.length) {
    throw new Error(`Provider ${provider.id} has an invalid guided-setup auth list`);
  }
  if (!authTypes.includes(provider.primaryAuthType)) {
    throw new Error(`Provider ${provider.id} does not support its primary auth type in guided setup`);
  }
  for (const authType of authTypes) {
    if (!provider.authTypes.includes(authType)) {
      throw new Error(`Provider ${provider.id} advertises unavailable guided auth type ${authType}`);
    }
    if (authType === 'api_key' && (
      !provider.validationEndpoint
      || !provider.validationMethod
      || !provider.onboardAuthChoice
      || !provider.onboardKeyFlag
    )) {
      throw new Error(`Provider ${provider.id} lacks the complete guided API-key validation/save contract`);
    }
    if (authType === 'oauth' && !GUIDED_OAUTH_PROVIDERS.has(provider.id)) {
      throw new Error(`Provider ${provider.id} lacks a supported guided OAuth route`);
    }
    if (authType === 'setup_token' && provider.id !== 'anthropic') {
      throw new Error(`Provider ${provider.id} lacks a supported guided setup-token route`);
    }
    if (authType === 'native_cli' && provider.id !== 'google-antigravity') {
      throw new Error(`Provider ${provider.id} lacks a supported native CLI setup route`);
    }
    if (authType === 'aws_sdk' && provider.id !== 'amazon-bedrock') {
      throw new Error(`Provider ${provider.id} lacks a supported AWS SDK setup flow`);
    }
    if (authType === 'token' || authType === 'device_code') {
      throw new Error(`Provider ${provider.id} uses an unrendered guided auth type ${authType}`);
    }
  }
  if (provider.authOptions?.some((option) => !authTypes.includes(option.type))) {
    throw new Error(`Provider ${provider.id} exposes an auth choice without a complete guided flow`);
  }
}

for (const provider of AI_PROVIDERS) {
  assertAiProviderGuidedSetupContract(provider);
}

export const AI_PROVIDER_MAP = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]));

export interface PublicAiProviderMeta {
  id: string;
  name: string;
  icon: string;
  tier: 1 | 2 | 3;
  primaryAuthType: AiProviderAuthType;
  guidedSetup: AiProviderGuidedSetup;
  authOptions?: AiProviderAuthOption[];
  keyPlaceholder?: string;
  consoleUrl: string;
  signupUrl: string;
  pricingNote: string;
  freeTier: string | null;
  description: string;
  dangerNote?: AiProviderDangerNote;
  defaultModels: AiProviderModelPreset[];
  setupInstructions: StepInstruction[];
}

/**
 * The browser consumes this projection instead of maintaining its own provider
 * catalog. Operational details such as validation endpoints and OpenClaw flags
 * remain server-only.
 */
export function getPublicAiProviderCatalog(): PublicAiProviderMeta[] {
  return AI_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    tier: provider.tier,
    primaryAuthType: provider.primaryAuthType,
    guidedSetup: provider.guidedSetup,
    ...(provider.authOptions ? { authOptions: provider.authOptions } : {}),
    ...(provider.keyPlaceholder ? { keyPlaceholder: provider.keyPlaceholder } : {}),
    consoleUrl: provider.consoleUrl,
    signupUrl: provider.signupUrl,
    pricingNote: provider.pricingNote,
    freeTier: provider.freeTier,
    description: provider.description,
    ...(provider.dangerNote ? { dangerNote: provider.dangerNote } : {}),
    defaultModels: provider.defaultModels,
    setupInstructions: provider.setupInstructions,
  }));
}

export function getAiProviderMeta(providerId: string): AiProviderMeta | undefined {
  return AI_PROVIDER_MAP.get(providerId);
}

export function isGuidedSetupAuthTypeAvailable(
  providerId: string,
  authType: AiProviderAuthType,
): boolean {
  const provider = getAiProviderMeta(providerId);
  return provider?.guidedSetup.status === 'available'
    && provider.guidedSetup.authTypes.includes(authType);
}

export function getKnownProviderIds(): string[] {
  return AI_PROVIDERS.map((provider) => provider.id);
}
