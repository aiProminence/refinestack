export const providers = [
  {
    key: "openai",
    name: "OpenAI",
    surface: "ChatGPT-compatible API capture",
  },
  {
    key: "claude",
    name: "Claude",
    surface: "Anthropic API capture",
  },
  {
    key: "google_ai_overview",
    name: "Google AI Overviews",
    surface: "Search-result surface capture",
  },
] as const;

export type ProviderKey = (typeof providers)[number]["key"];
