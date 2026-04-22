export type ModelType =
  | "completion"
  | "embedding"
  | "image"
  | "audio"
  | "video"
  | "transaction";

export interface ModelPricing {
  input?: number;
  output?: number;
  cached_input?: number;
  cache_write?: number;
  cache_hit?: number;
  input_audio?: number;
  output_audio?: number;
  input_gt_200k?: number;
  output_gt_200k?: number;
  image_generation?: number;
  video_generation?: number;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  type: ModelType;
  displayName: string;
  pricing: ModelPricing;
}
