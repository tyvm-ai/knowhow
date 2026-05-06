/**
 * Assembles ALL_MODEL_CATALOG from per-provider catalogs.
 * Each provider file is the single source of truth for its models.
 */
import { ModelPricing, ModelType, ModelCatalogEntry } from "./types";
import { OPENAI_MODEL_CATALOG } from "./openai";
import { ANTHROPIC_MODEL_CATALOG } from "./anthropic";
import { GOOGLE_MODEL_CATALOG } from "./google";
import { XAI_MODEL_CATALOG } from "./xai";

export { ModelPricing, ModelType, ModelCatalogEntry };

/** 2.5% platform markup applied on top of all provider base rates */
export const USAGE_MARKUP_PERCENT = 2.5 / 100;

export { OPENAI_MODEL_CATALOG, ANTHROPIC_MODEL_CATALOG, GOOGLE_MODEL_CATALOG, XAI_MODEL_CATALOG };

export const ALL_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...OPENAI_MODEL_CATALOG,
  ...ANTHROPIC_MODEL_CATALOG,
  ...GOOGLE_MODEL_CATALOG,
  ...XAI_MODEL_CATALOG,
];
