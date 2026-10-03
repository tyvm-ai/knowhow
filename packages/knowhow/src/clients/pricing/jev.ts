import { decisions, ModelCatalogEntry, ModelPricing } from "./types";

/** TypeSafe System One model identifiers. */
export const JevModels = {
  Latest: "jev-latest",
  Jev1_13: "jev-1.13.0",
} as const;

/**
 * TypeSafe pricing in USD per million tokens. Jev charges for input tokens;
 * output tokens are free. Source: https://docs.typesafe.ai/models
 */
export const JevDecisionPricing: Record<string, ModelPricing> = {
  [JevModels.Latest]: { input: 0.042, output: 0 },
  [JevModels.Jev1_13]: { input: 0.042, output: 0 },
};

export const JEV_MODEL_CATALOG: ModelCatalogEntry[] = decisions(
  [JevModels.Latest],
  "jev",
  JevDecisionPricing
);
