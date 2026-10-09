export const defaults: Record<string, string> = {
  mimo: 'mimo-v2.6-flash',
  zai: 'glm-4.7-flash',
  codex: 'gpt-5.6-luna',
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-3.8-flash',
};

export const providerNames: Record<string, string> = {
  mimo: 'MiMo',
  zai: 'ZAI',
  codex: 'OpenAI / Codex',
  claude: 'Anthropic / Claude',
  gemini: 'Google / Gemini',
};

export interface ModelOption {
  id: string;
  label: string;
}

const catalogs: Record<string, { url: string; models: ModelOption[] }> = {
  mimo: {
    url: 'https://mimo.mi.com/docs/en-US/quick-start/model',
    models: [
      { id: 'mimo-v2.6-flash', label: 'MiMo 2.6 Flash · Default' },
      { id: 'mimo-v2.6-pro', label: 'MiMo 2.6 Pro' },
    ],
  },
  zai: {
    url: 'https://docs.z.ai/guides/overview/pricing',
    models: [
      { id: 'glm-4.7-flash', label: 'GLM 4.7 Flash · Default' },
      { id: 'glm-4.5-flash', label: 'GLM 4.5 Flash · Free tier' },
      { id: 'glm-4.7-flashx', label: 'GLM 4.7 FlashX · Paid' },
      { id: 'glm-4.7', label: 'GLM 4.7 · Paid' },
      { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash · Paid' },
      { id: 'glm-5.3', label: 'GLM 5.3 · Paid' },
    ],
  },
  codex: {
    url: 'https://developers.openai.com/api/docs/models',
    models: [
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · Default' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra · Higher cost' },
    ],
  },
  claude: {
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · Workspace default' }],
  },
  gemini: {
    url: 'https://ai.google.dev/gemini-api/docs/models',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · Default' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · Preview' },
    ],
  },
};

export function modelOptions(
  provider: string,
  connections: { provider: string; model: string }[],
  current: string,
) {
  const models = [...(catalogs[provider]?.models ?? [])];
  if (provider === 'claude') return models;
  const known = new Set(models.map((model) => model.id));
  for (const connection of connections) {
    if (connection.provider !== provider || known.has(connection.model)) continue;
    known.add(connection.model);
    models.push({ id: connection.model, label: `${connection.model} · Saved model` });
  }
  if (current && !known.has(current))
    models.push({ id: current, label: `${current} · Current model` });
  return models;
}

export function modelCatalogUrl(provider: string) {
  return catalogs[provider]?.url;
}
