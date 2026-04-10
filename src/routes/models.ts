/**
 * AI Models REST API Routes
 *
 * List available AI models from all registered providers.
 * Results are cached for 5 minutes.
 * Mounted at /api/ai/models by the plugin system.
 */

import { Elysia, t } from "elysia";

export interface ModelRouteDeps {
  getAIProvider: (agentType: string) => unknown | undefined;
  listAIProviders: () => Array<{ pluginName: string; isDefault: boolean }>;
}

interface AIModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
}

interface ModelCache {
  data: AIModelInfo[];
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createModelRoutes(deps: ModelRouteDeps) {
  const { getAIProvider, listAIProviders } = deps;

  const cache: Record<string, ModelCache> = {};

  async function fetchModelsForProvider(
    providerName: string,
  ): Promise<AIModelInfo[]> {
    // Check cache
    const cached = cache[providerName];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    const provider = getAIProvider(providerName) as
      | {
          listModels?: () => Promise<AIModelInfo[]> | AIModelInfo[];
        }
      | undefined;

    if (!provider?.listModels) {
      return [];
    }

    try {
      const models = await provider.listModels();
      const modelsWithProvider = models.map((m) => ({
        ...m,
        provider: providerName,
      }));

      cache[providerName] = {
        data: modelsWithProvider,
        timestamp: Date.now(),
      };

      return modelsWithProvider;
    } catch {
      return [];
    }
  }

  return (
    new Elysia()
      // ── GET /models — List all models from all providers ──────────────
      .get("/models", async () => {
        const providers = listAIProviders();
        const allModels: AIModelInfo[] = [];

        for (const p of providers) {
          const models = await fetchModelsForProvider(p.pluginName);
          allModels.push(...models);
        }

        return {
          models: allModels,
          providers: providers.map((p) => p.pluginName),
        };
      })

      // ── GET /models/:provider — List models for a specific provider ──
      .get(
        "/models/:provider",
        async ({ params, set }) => {
          const providers = listAIProviders();
          const found = providers.find((p) => p.pluginName === params.provider);

          if (!found) {
            set.status = 404;
            return {
              error: `Provider '${params.provider}' not found`,
              availableProviders: providers.map((p) => p.pluginName),
            };
          }

          const models = await fetchModelsForProvider(params.provider);
          return { models, provider: params.provider };
        },
        { params: t.Object({ provider: t.String() }) },
      )
  );
}
