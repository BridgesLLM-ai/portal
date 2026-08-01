import fs from 'fs';

export type OllamaModelRecommendation = {
  name: string;
  description: string;
  size: string;
  sizeBytes: number;
  minAvailableRamGb: number;
  contextWindow: string;
  useCase: 'general' | 'coding' | 'reasoning';
  sourceUrl: string;
};

export type OllamaRecommendationSet = {
  ramTier: string;
  availableRamGb: number;
  reservedHeadroomGb: number;
  warning: string | null;
  recommendedModels: OllamaModelRecommendation[];
};

const GIB = 1024 ** 3;

export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';

export const OLLAMA_DEFAULT_MODEL_CANDIDATES = [
  'qwen3.5:4b',
  'qwen3.5:9b',
  'qwen3.5:2b',
  'qwen3.5:0.8b',
  'qwen3.6:27b',
  'qwen3.6:35b',
  'gemma4:12b',
  'deepseek-r1:8b',
  'deepseek-r1:1.5b',
] as const;

export function isValidOllamaModelName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const model = value.trim();
  return model === value
    && model.length > 0
    && model.length <= 200
    && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(model);
}

// Refreshed 2026-07-18 from the official Ollama library. Download size is not
// runtime memory: every recommendation also reserves room for the OS, Ollama,
// KV cache, and Portal services. Long contexts can require substantially more.
export const OLLAMA_RECOMMENDATION_CATALOG: readonly OllamaModelRecommendation[] = [
  {
    name: 'qwen3.5:0.8b',
    description: 'Small current multimodal Qwen for very constrained hosts. Prefer cloud providers for heavier coding or reasoning.',
    size: '1.0GB',
    sizeBytes: 1.0 * GIB,
    minAvailableRamGb: 2.5,
    contextWindow: '256K',
    useCase: 'general',
    sourceUrl: 'https://ollama.com/library/qwen3.5',
  },
  {
    name: 'qwen3.5:2b',
    description: 'Responsive general-purpose model for small servers with enough memory left after the operating system and Portal.',
    size: '2.7GB',
    sizeBytes: 2.7 * GIB,
    minAvailableRamGb: 4.5,
    contextWindow: '256K',
    useCase: 'general',
    sourceUrl: 'https://ollama.com/library/qwen3.5',
  },
  {
    name: 'qwen3.5:4b',
    description: 'Balanced Portal default for everyday chat, tools, coding, and multimodal work on a modest local server.',
    size: '3.4GB',
    sizeBytes: 3.4 * GIB,
    minAvailableRamGb: 6,
    contextWindow: '256K',
    useCase: 'general',
    sourceUrl: 'https://ollama.com/library/qwen3.5',
  },
  {
    name: 'qwen3.5:9b',
    description: 'Stronger general and agentic model for hosts with real runtime headroom; not a safe recommendation for an 8GB machine.',
    size: '6.6GB',
    sizeBytes: 6.6 * GIB,
    minAvailableRamGb: 11,
    contextWindow: '256K',
    useCase: 'general',
    sourceUrl: 'https://ollama.com/library/qwen3.5',
  },
  {
    name: 'gemma4:12b',
    description: 'Current Gemma workstation option for reasoning, coding, tool use, and multimodal input when enough memory is available.',
    size: '7.6GB',
    sizeBytes: 7.6 * GIB,
    minAvailableRamGb: 12,
    contextWindow: '256K',
    useCase: 'general',
    sourceUrl: 'https://ollama.com/library/gemma4',
  },
  {
    name: 'deepseek-r1:1.5b',
    description: 'Compact reasoning alternative. Use it for deliberate logic on small hosts, not as the automatic general default.',
    size: '1.1GB',
    sizeBytes: 1.1 * GIB,
    minAvailableRamGb: 3,
    contextWindow: '128K',
    useCase: 'reasoning',
    sourceUrl: 'https://ollama.com/library/deepseek-r1',
  },
  {
    name: 'deepseek-r1:8b',
    description: 'Reasoning-focused alternative for debugging, math, and difficult prompts when slower responses are acceptable.',
    size: '5.2GB',
    sizeBytes: 5.2 * GIB,
    minAvailableRamGb: 10,
    contextWindow: '128K',
    useCase: 'reasoning',
    sourceUrl: 'https://ollama.com/library/deepseek-r1',
  },
  {
    name: 'deepseek-r1:14b',
    description: 'Larger reasoning alternative for workstation-class hosts with enough memory for the model and context cache.',
    size: '9.0GB',
    sizeBytes: 9.0 * GIB,
    minAvailableRamGb: 16,
    contextWindow: '128K',
    useCase: 'reasoning',
    sourceUrl: 'https://ollama.com/library/deepseek-r1',
  },
  {
    name: 'qwen3.6:27b',
    description: 'Agentic-coding-focused Qwen 3.6 for workstation servers. Portal recommends it only with at least 24GB currently available.',
    size: '17GB',
    sizeBytes: 17 * GIB,
    minAvailableRamGb: 24,
    contextWindow: '256K',
    useCase: 'coding',
    sourceUrl: 'https://ollama.com/library/qwen3.6',
  },
  {
    name: 'qwen3.6:35b',
    description: 'Largest recommended Qwen 3.6 coding model for high-memory local workstations; context length can push usage higher.',
    size: '24GB',
    sizeBytes: 24 * GIB,
    minAvailableRamGb: 32,
    contextWindow: '256K',
    useCase: 'coding',
    sourceUrl: 'https://ollama.com/library/qwen3.6',
  },
] as const;

export function readAvailableMemoryBytes(totalBytes: number, meminfoPath = '/proc/meminfo'): number {
  try {
    const meminfo = fs.readFileSync(meminfoPath, 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) {
      const bytes = Number.parseInt(match[1], 10) * 1024;
      if (Number.isFinite(bytes) && bytes > 0) return Math.min(bytes, totalBytes);
    }
  } catch {
    // Non-Linux hosts fall back to a conservative fraction of total memory.
  }
  return Math.max(0, totalBytes * 0.7);
}

function selectModels(names: readonly string[], availableGb: number): OllamaModelRecommendation[] {
  const byName = new Map(OLLAMA_RECOMMENDATION_CATALOG.map((model) => [model.name, model]));
  return names
    .map((name) => byName.get(name))
    .filter((model): model is OllamaModelRecommendation => Boolean(model && model.minAvailableRamGb <= availableGb));
}

export function getOllamaRecommendationsByRam(
  totalBytes: number,
  availableBytes = readAvailableMemoryBytes(totalBytes),
): OllamaRecommendationSet {
  const totalGb = totalBytes / GIB;
  const availableGb = Math.max(0, Math.min(availableBytes, totalBytes)) / GIB;
  const reservedHeadroomGb = Math.max(0, totalGb - availableGb);

  let ramTier = 'under 4GB';
  let names: readonly string[] = ['qwen3.5:0.8b'];
  let warning: string | null = 'Very limited memory. Use tiny local models only and prefer cloud providers for substantial work.';

  if (totalGb >= 48) {
    ramTier = '48GB+';
    names = ['qwen3.6:35b', 'qwen3.6:27b', 'qwen3.5:9b', 'deepseek-r1:14b'];
    warning = null;
  } else if (totalGb >= 32) {
    ramTier = '32-48GB';
    names = ['qwen3.6:27b', 'qwen3.5:9b', 'gemma4:12b', 'deepseek-r1:14b'];
    warning = null;
  } else if (totalGb >= 16) {
    ramTier = '16-32GB';
    names = ['qwen3.5:9b', 'gemma4:12b', 'deepseek-r1:8b', 'qwen3.5:4b'];
    warning = null;
  } else if (totalGb >= 8) {
    ramTier = '8-16GB';
    names = ['qwen3.5:4b', 'qwen3.5:2b', 'deepseek-r1:1.5b'];
    warning = 'Recommendations reserve memory for the OS, Portal, and context cache. Close other heavy workloads before local inference.';
  } else if (totalGb >= 4) {
    ramTier = '4-8GB';
    names = ['qwen3.5:2b', 'qwen3.5:0.8b', 'deepseek-r1:1.5b'];
    warning = 'Limited memory. Portal hides models that do not currently have enough headroom; cloud providers remain the safer default.';
  }

  const recommendedModels = selectModels(names, availableGb);
  if (recommendedModels.length === 0) {
    warning = 'No catalog model has enough currently available memory. Free RAM or use a cloud provider before starting local inference.';
  }

  return {
    ramTier,
    availableRamGb: Math.round(availableGb * 10) / 10,
    reservedHeadroomGb: Math.round(reservedHeadroomGb * 10) / 10,
    warning,
    recommendedModels,
  };
}
