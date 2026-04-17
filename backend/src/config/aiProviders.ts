export type AiProviderAuthType = 'api_key' | 'token' | 'oauth' | 'setup_token' | 'device_code';
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

export interface AiProviderMeta {
  id: string;
  name: string;
  icon: string;
  tier: 1 | 2 | 3;
  authTypes: AiProviderAuthType[];
  primaryAuthType: AiProviderAuthType;
  keyPrefix?: string;
  keyPlaceholder?: string;
  consoleUrl: string;
  signupUrl: string;
  pricingNote: string;
  freeTier: string | null;
  description: string;
  validationEndpoint?: string;
  validationMethod?: AiProviderValidationMethod;
  onboardAuthChoice?: string;
  onboardKeyFlag?: string;
  requiresPlugin?: string;
  defaultModels: AiProviderModelPreset[];
  setupInstructions: StepInstruction[];
}

export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    icon: 'brain',
    tier: 1,
    authTypes: ['api_key', 'setup_token'],
    primaryAuthType: 'api_key',
    keyPrefix: 'sk-ant-',
    keyPlaceholder: 'sk-ant-••••',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    signupUrl: 'https://console.anthropic.com/',
    pricingNote: 'Pay-per-token. ~$3/MTok input (Haiku) to ~$15/MTok (Opus). No subscription required.',
    freeTier: null,
    description: 'Most capable AI for complex reasoning, coding, and analysis. Industry-leading safety.',
    validationEndpoint: 'https://api.anthropic.com/v1/models',
    validationMethod: 'x-api-key',
    onboardAuthChoice: 'anthropic-api-key',
    onboardKeyFlag: 'anthropic-api-key',
    defaultModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'frontier', description: 'Most capable. Best for complex reasoning and difficult tasks.' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'balanced', description: 'Balanced. Great all-rounder for most tasks.' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'fast', description: 'Fastest and cheapest. Good for simple tasks.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Create an Anthropic account', detail: 'Go to https://console.anthropic.com/ and click "Sign up". Enter your email, verify it, set a password. You\'ll land on the Console dashboard.', link: { url: 'https://console.anthropic.com/', label: 'Open Anthropic Console' } },
      { stepNumber: 2, title: 'Add a payment method', detail: 'In the Console, click your profile icon (top-right) → "Billing" → "Add payment method". Enter a credit card. Anthropic requires this before issuing API keys. You won\'t be charged until you use the API.' },
      { stepNumber: 3, title: 'Create an API key', detail: 'In the Console, click "API Keys" in the left sidebar (or go directly to https://console.anthropic.com/settings/keys). Click the "Create Key" button. Give it any name (for example "my-portal"). Click "Create Key".', link: { url: 'https://console.anthropic.com/settings/keys', label: 'Open Anthropic API Keys' } },
      { stepNumber: 4, title: 'Copy the key', detail: 'The key is shown ONCE. It starts with sk-ant-•••• Click the copy icon to copy it to your clipboard. If you lose it, you\'ll need to create a new one.' },
      { stepNumber: 5, title: 'Paste it in the field below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT)',
    icon: 'sparkles',
    tier: 1,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    keyPrefix: 'sk-',
    keyPlaceholder: 'sk-proj-...',
    consoleUrl: 'https://platform.openai.com/settings/organization/api-keys',
    signupUrl: 'https://platform.openai.com/signup',
    pricingNote: 'Pay-per-token. Varies by model (~$2-60/MTok). New accounts get $5 trial credit.',
    freeTier: '$5 free trial credit for new accounts',
    description: 'GPT models. Strong general-purpose AI with wide tool and function support.',
    validationEndpoint: 'https://api.openai.com/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'openai-api-key',
    onboardKeyFlag: 'openai-api-key',
    defaultModels: [
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'frontier', description: 'Most capable GPT model. Strong reasoning and multimodal.' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', tier: 'balanced', description: 'Fast and affordable. Good for most tasks.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Create an OpenAI account', detail: 'Go to https://platform.openai.com/signup. Sign up with email or Google/Microsoft account. Verify your email. You\'ll land on the Platform dashboard.', link: { url: 'https://platform.openai.com/signup', label: 'Open OpenAI Platform' } },
      { stepNumber: 2, title: 'Add a payment method (optional for trial)', detail: 'Click "Settings" (gear icon, top-right) → "Billing" → "Add payment method". New accounts get $5 free credit. If you want to use beyond that, add a credit card.' },
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
    consoleUrl: 'https://chatgpt.com/',
    signupUrl: 'https://chatgpt.com/',
    pricingNote: 'Uses your existing ChatGPT Plus/Pro/Team subscription. No per-token charges.',
    freeTier: 'Included with ChatGPT Plus ($20/mo), Pro ($200/mo), or Team plans',
    description: 'Use your ChatGPT subscription for AI. OpenAI explicitly supports this for external tools.',
    onboardAuthChoice: 'openai-codex',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'You need an active ChatGPT subscription', detail: 'ChatGPT Plus ($20/mo), Pro ($200/mo), or Team. Free accounts do NOT work. If you don\'t have one, subscribe at https://chatgpt.com/ → "Upgrade to Plus".', link: { url: 'https://chatgpt.com/', label: 'Open ChatGPT' } },
      { stepNumber: 2, title: 'Click "Start OpenAI Sign-In" below', detail: 'This opens a new browser tab with OpenAI\'s login page.' },
      { stepNumber: 3, title: 'Sign in with your OpenAI account', detail: 'Use the same email/password you use for ChatGPT. If you use Google/Microsoft login, click that.' },
      { stepNumber: 4, title: 'Authorize the connection', detail: 'After signing in, you\'ll be redirected to a URL starting with http://127.0.0.1:1455/.... This page will NOT load — that is completely normal. Your browser will show an error like "This site can\'t be reached."' },
      { stepNumber: 5, title: 'Copy the ENTIRE URL', detail: 'Click in your browser\'s address bar. Select ALL the text (Ctrl+A or Cmd+A). Copy it (Ctrl+C or Cmd+C). The URL will be long and contain ?code=... parameters.' },
      { stepNumber: 6, title: 'Paste the URL in the field below', detail: 'Come back to this page and paste the full URL into the redirect URL field.' },
      { stepNumber: 7, title: 'Click "Complete Sign-In"', detail: 'The portal will exchange the authorization code for access tokens. This takes 2-5 seconds.' },
    ],
  },
  {
    id: 'google-gemini-cli',
    name: 'Google Gemini (Google Subscription)',
    icon: 'globe',
    tier: 1,
    authTypes: ['oauth'],
    primaryAuthType: 'oauth',
    consoleUrl: 'https://gemini.google.com/',
    signupUrl: 'https://gemini.google.com/',
    pricingNote: 'Uses your Google / Gemini account through OAuth instead of an API key.',
    freeTier: 'Depends on your Google Gemini plan/account',
    description: 'Use the Google Gemini subscription/account login flow instead of creating an API key.',
    onboardAuthChoice: 'google-gemini-cli',
    defaultModels: [
      { id: 'google-gemini-cli/gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'frontier', description: 'Best capability and context window.' },
      { id: 'google-gemini-cli/gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'balanced', description: 'Fast and practical default choice.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Start sign-in here', detail: 'Click the sign-in button here to open the Google Gemini authorization flow in a new tab.' },
      { stepNumber: 2, title: 'Accept the Google warning prompt', detail: 'The portal handles the server-side confirmation step automatically. You just continue in your browser.' },
      { stepNumber: 3, title: 'Sign in with your Google account', detail: 'Use the same Google account you want the portal to use for Gemini.' },
      { stepNumber: 4, title: 'Copy the final localhost redirect URL', detail: 'After sign-in, your browser will land on a localhost callback URL that may fail to load. That is normal. Copy the full address bar URL.' },
      { stepNumber: 5, title: 'Paste the full redirect URL back here', detail: 'Return to the portal and paste it to complete sign-in.' },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    icon: 'gem',
    tier: 1,
    authTypes: ['api_key', 'oauth'],
    primaryAuthType: 'api_key',
    keyPrefix: 'AIza',
    keyPlaceholder: 'AIzaSy...',
    consoleUrl: 'https://aistudio.google.com/apikey',
    signupUrl: 'https://aistudio.google.com/',
    pricingNote: 'Generous free tier. Pay-per-token beyond limits.',
    freeTier: 'Free: 250 req/day (Flash), 25 req/day (Pro). No credit card needed.',
    description: 'Google\'s Gemini models. Best free option — generous daily limits with no credit card.',
    validationEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    validationMethod: 'query-param',
    onboardAuthChoice: 'gemini-api-key',
    onboardKeyFlag: 'gemini-api-key',
    defaultModels: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'frontier', description: 'Most capable Gemini. 1M token context window.' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'balanced', description: 'Fast and free (250 req/day). Great for quick tasks.' },
    ],
    setupInstructions: [
      { stepNumber: 1, title: 'Go to Google AI Studio', detail: 'Open https://aistudio.google.com/apikey in your browser. Sign in with any Google account (Gmail works fine).', link: { url: 'https://aistudio.google.com/apikey', label: 'Open Google AI Studio API Keys' } },
      { stepNumber: 2, title: 'Click "Create API Key"', detail: 'On the API keys page, click the blue "Create API key" button.' },
      { stepNumber: 3, title: 'Select a Google Cloud project', detail: 'If prompted, either select an existing project or click "Create API key in new project". Google creates a project automatically — you do not need to configure anything.' },
      { stepNumber: 4, title: 'Copy the key', detail: 'The key appears in a dialog. It starts with AIza. Click the copy icon. Unlike OpenAI, you can view this key again later on this same page.' },
      { stepNumber: 5, title: 'Paste it in the field below', detail: 'Come back to this page and paste the key.', note: 'This is the easiest Google path. No credit card required. If you have a Google AI Pro subscription and want to use that instead, choose Google Gemini (Subscription) from the advanced providers.' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: 'route',
    tier: 1,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    keyPrefix: 'sk-or-',
    keyPlaceholder: 'sk-or-v1-...',
    consoleUrl: 'https://openrouter.ai/settings/keys',
    signupUrl: 'https://openrouter.ai/',
    pricingNote: 'Pass-through pricing from underlying providers + small markup (~5-15%).',
    freeTier: 'Some models are free (Llama, Mistral variants). Paid models require credits.',
    description: 'One API key for all major AI models (Claude, GPT, Gemini, Llama, Mistral, and 200+ more). Best flexibility.',
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
      { stepNumber: 2, title: 'Add credits (optional)', detail: 'Click your profile icon → "Credits" → "Add Credits". You can start with $5. Some models are free without credits.' },
      { stepNumber: 3, title: 'Create an API key', detail: 'Go to https://openrouter.ai/settings/keys (or click your profile → "Keys"). Click "Create Key". Name it anything.', link: { url: 'https://openrouter.ai/settings/keys', label: 'Open OpenRouter Keys' } },
      { stepNumber: 4, title: 'Copy the key', detail: 'It starts with sk-or-. Copy it.' },
      { stepNumber: 5, title: 'Paste it in the field below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    icon: 'zap',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    keyPrefix: 'xai-',
    keyPlaceholder: 'xai-...',
    consoleUrl: 'https://console.x.ai/',
    signupUrl: 'https://console.x.ai/',
    pricingNote: 'Pay-per-token.',
    freeTier: '$25 free monthly credit for new accounts',
    description: 'xAI Grok models with paid API access.',
    validationEndpoint: 'https://api.x.ai/v1/models',
    validationMethod: 'bearer',
    onboardAuthChoice: 'xai-api-key',
    onboardKeyFlag: 'xai-api-key',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Go to the xAI Console', detail: 'Open https://console.x.ai/ and sign in with your X (Twitter) account or email.', link: { url: 'https://console.x.ai/', label: 'Open xAI Console' } },
      { stepNumber: 2, title: 'Navigate to API Keys', detail: 'Click "API Keys" in the left sidebar.' },
      { stepNumber: 3, title: 'Create a new key', detail: 'Click "Create API Key". Name it anything.' },
      { stepNumber: 4, title: 'Copy the key', detail: 'It starts with xai-. Copy it.' },
      { stepNumber: 5, title: 'Paste it below', detail: 'Come back to this page and paste the key.' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    icon: 'wind',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
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
    keyPrefix: 'gsk_',
    keyPlaceholder: 'gsk_...',
    consoleUrl: 'https://console.groq.com/keys',
    signupUrl: 'https://console.groq.com/',
    pricingNote: 'Very fast inference. Free tier available.',
    freeTier: 'Generous free tier with rate limits',
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
    consoleUrl: 'https://api.together.ai/settings/api-keys',
    signupUrl: 'https://api.together.ai/',
    pricingNote: 'Pay-per-token. Affordable open-source model hosting.',
    freeTier: '$5 free credit for new accounts',
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
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    signupUrl: 'https://platform.deepseek.com/',
    pricingNote: 'Very low cost. Strong reasoning models.',
    freeTier: 'Small free credit for new accounts',
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
    name: 'OpenCode',
    icon: 'terminal-square',
    tier: 2,
    authTypes: ['api_key'],
    primaryAuthType: 'api_key',
    consoleUrl: 'https://opencode.ai',
    signupUrl: 'https://opencode.ai',
    pricingNote: 'Access to multiple model providers through a single key.',
    freeTier: null,
    description: 'OpenCode / Zen hosted access for multi-provider coding models.',
    onboardAuthChoice: 'opencode-zen',
    onboardKeyFlag: 'opencode-zen-api-key',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Open the OpenCode site', detail: 'Go to https://opencode.ai and sign in or create an account.', link: { url: 'https://opencode.ai', label: 'Open OpenCode' } },
      { stepNumber: 2, title: 'Create or locate your API key', detail: 'Follow the dashboard prompts to create a Zen / hosted API key.' },
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
    consoleUrl: 'https://ollama.com/',
    signupUrl: 'https://ollama.com/',
    pricingNote: 'Runs on your own server hardware. No per-token fees.',
    freeTier: 'Local-only; compute costs are your own hardware.',
    description: 'Run AI models directly on this server. No data leaves your machine. No API key needed.',
    defaultModels: [],
    setupInstructions: [
      { stepNumber: 1, title: 'Use the existing Ollama section', detail: 'Ollama is already handled by the existing setup and settings UI. Use that section to pull models and verify the service is running.' },
    ],
  },
  {
    id: 'amazon-bedrock', name: 'Amazon Bedrock', icon: 'cloud', tier: 3, authTypes: ['oauth'], primaryAuthType: 'oauth', consoleUrl: 'https://aws.amazon.com/bedrock/', signupUrl: 'https://aws.amazon.com/bedrock/', pricingNote: 'AWS usage-based billing.', freeTier: null, description: 'Requires AWS credentials and additional setup.', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'See docs', detail: 'Bedrock setup is advanced and requires AWS credentials plus extra configuration. Use the provider docs or manual OpenClaw config.' }] },
  { id: 'huggingface', name: 'Hugging Face', icon: 'smile', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://huggingface.co/settings/tokens', signupUrl: 'https://huggingface.co/join', pricingNote: 'Varies by endpoint/provider.', freeTier: 'Some free hosted options', description: 'Hosted inference and model access from Hugging Face.', onboardAuthChoice: 'huggingface-api-key', onboardKeyFlag: 'huggingface-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Create a token', detail: 'Go to https://huggingface.co/settings/tokens and create an access token.' }] },
  { id: 'moonshot', name: 'Moonshot / Kimi', icon: 'moon', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://platform.moonshot.ai/', signupUrl: 'https://platform.moonshot.ai/', pricingNote: 'Provider pricing varies.', freeTier: null, description: 'Moonshot / Kimi API access.', onboardAuthChoice: 'moonshot-api-key', onboardKeyFlag: 'moonshot-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Create a key', detail: 'Follow Moonshot platform instructions to create an API key.' }] },
  { id: 'venice', name: 'Venice AI', icon: 'venetian-mask', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://venice.ai/', signupUrl: 'https://venice.ai/', pricingNote: 'Subscription/provider pricing.', freeTier: null, description: 'Venice-hosted AI access.', onboardAuthChoice: 'venice-api-key', onboardKeyFlag: 'venice-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Create a key', detail: 'Follow Venice AI account instructions to create an API key.' }] },
  { id: 'cerebras', name: 'Cerebras', icon: 'cpu', tier: 3, authTypes: ['token'], primaryAuthType: 'token', consoleUrl: 'https://inference.cerebras.ai/', signupUrl: 'https://inference.cerebras.ai/', pricingNote: 'Provider pricing applies.', freeTier: null, description: 'Cerebras inference access via token-based auth.', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Manual setup', detail: 'Create a Cerebras token and use manual OpenClaw configuration if needed.' }] },
  { id: 'kilocode', name: 'Kilo Gateway', icon: 'waypoints', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://kilocode.ai/', signupUrl: 'https://kilocode.ai/', pricingNote: 'Provider pricing varies.', freeTier: null, description: 'Kilo Gateway API access.', onboardAuthChoice: 'kilocode-api-key', onboardKeyFlag: 'kilocode-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Create a key', detail: 'Create a Kilo Gateway API key in the provider dashboard.' }] },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', icon: 'shield-cloud', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://dash.cloudflare.com/', signupUrl: 'https://dash.cloudflare.com/sign-up', pricingNote: 'Cloudflare AI Gateway pricing applies.', freeTier: null, description: 'Requires account ID and gateway ID in addition to API key.', onboardAuthChoice: 'cloudflare-ai-gateway-api-key', onboardKeyFlag: 'cloudflare-ai-gateway-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'See docs', detail: 'Create a Cloudflare AI Gateway key, account ID, and gateway ID. This path needs extra flags beyond simple setup.' }] },
  { id: 'byteplus', name: 'BytePlus', icon: 'cable', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://console.byteplus.com/', signupUrl: 'https://console.byteplus.com/', pricingNote: 'Provider pricing varies.', freeTier: null, description: 'BytePlus model provider.', onboardAuthChoice: 'byteplus-api-key', onboardKeyFlag: 'byteplus-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Create a key', detail: 'Create a BytePlus API key in the provider console.' }] },
  { id: 'volcengine', name: 'Volcengine', icon: 'flame', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://console.volcengine.com/', signupUrl: 'https://console.volcengine.com/', pricingNote: 'Provider pricing varies.', freeTier: null, description: 'Volcengine model provider.', onboardAuthChoice: 'volcengine-api-key', onboardKeyFlag: 'volcengine-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Create a key', detail: 'Create a Volcengine API key in the provider console.' }] },
  { id: 'custom', name: 'Custom / Self-hosted', icon: 'wrench', tier: 3, authTypes: ['api_key'], primaryAuthType: 'api_key', consoleUrl: 'https://docs.openclaw.ai/', signupUrl: 'https://docs.openclaw.ai/', pricingNote: 'Depends on your own infrastructure.', freeTier: null, description: 'Bring your own OpenAI- or Anthropic-compatible endpoint.', onboardAuthChoice: 'custom-api-key', onboardKeyFlag: 'custom-api-key', defaultModels: [], setupInstructions: [{ stepNumber: 1, title: 'Manual configuration required', detail: 'Custom providers need a base URL, compatibility mode, and model ID in addition to an API key.' }] },
];

export const AI_PROVIDER_MAP = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]));

export function getAiProviderMeta(providerId: string): AiProviderMeta | undefined {
  return AI_PROVIDER_MAP.get(providerId);
}

export function getKnownProviderIds(): string[] {
  return AI_PROVIDERS.map((provider) => provider.id);
}
