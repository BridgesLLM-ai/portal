export type OllamaModelRecommendation = {
  name: string;
  description: string;
  size: string;
};

export type OllamaRecommendationSet = {
  ramTier: string;
  warning: string | null;
  recommendedModels: OllamaModelRecommendation[];
};

// Refreshed on 2026-04-08 using current official release pages from Google,
// Qwen, DeepSeek, and the Ollama library. Sizes below match current Ollama
// library listings. Recommendations stay conservative so the lowest RAM value
// in each tier still has a reasonable chance of working.
export function getOllamaRecommendationsByRam(totalBytes: number): OllamaRecommendationSet {
  const gb = totalBytes / (1024 ** 3);

  if (gb >= 16) {
    return {
      ramTier: '16GB+',
      warning: null,
      recommendedModels: [
        {
          name: 'gemma4:e4b',
          description: 'Best updated local default in this tier. Google\'s newest edge Gemma is a real step up, especially for reasoning and code, without jumping to a giant workstation model.',
          size: '9.6GB',
        },
        {
          name: 'qwen3:14b',
          description: 'Strong general-purpose dense model with excellent multilingual, tool-use, and assistant behavior. Safer everyday pick than a slower reasoning-first model.',
          size: '9.3GB',
        },
        {
          name: 'deepseek-r1:14b',
          description: 'Best choice here when the job is harder reasoning, debugging, or math and you can tolerate slower replies.',
          size: '9.0GB',
        },
      ],
    };
  }

  if (gb >= 8) {
    return {
      ramTier: '8-16GB',
      warning: null,
      recommendedModels: [
        {
          name: 'qwen3:8b',
          description: 'Best balanced recommendation for this tier. Fast enough for daily use, modern, and meaningfully stronger than the old Llama 3.1 / Mistral defaults.',
          size: '5.2GB',
        },
        {
          name: 'gemma4:e2b',
          description: 'Gemma 4 stretch pick for this tier. Use it when the host is closer to 16GB than 8GB and you want Google\'s newest local model family.',
          size: '7.2GB',
        },
        {
          name: 'deepseek-r1:8b',
          description: 'Reasoning-focused alternative for tougher prompts. Use this when you care more about logic quality than raw speed.',
          size: '5.2GB',
        },
      ],
    };
  }

  if (gb >= 4) {
    return {
      ramTier: '4-8GB',
      warning: 'Your server has limited RAM. Stay with smaller models and avoid treating this tier like a workstation.',
      recommendedModels: [
        {
          name: 'qwen3:4b',
          description: 'Current best general-purpose fit for a low-memory local host.',
          size: '2.5GB',
        },
        {
          name: 'qwen3:1.7b',
          description: 'Smaller modern fallback that is still worth using, not just a toy model.',
          size: '1.4GB',
        },
        {
          name: 'deepseek-r1:1.5b',
          description: 'Tiny reasoning model for harder prompts when you can accept slower output.',
          size: '1.1GB',
        },
      ],
    };
  }

  return {
    ramTier: 'under 4GB',
    warning: 'Very limited RAM. Use tiny local models only and prefer cloud providers for anything serious.',
    recommendedModels: [
      {
        name: 'qwen3:0.6b',
        description: 'Smallest current all-purpose model here that still feels worth recommending.',
        size: '523MB',
      },
      {
        name: 'qwen3:1.7b',
        description: 'Stretch option if this machine is close to 4GB and you want a noticeably better tiny model.',
        size: '1.4GB',
      },
    ],
  };
}
