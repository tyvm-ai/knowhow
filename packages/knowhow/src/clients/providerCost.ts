/**
 * Some providers report the exact amount they billed for a request inside the
 * response `usage` object. When present, that number is the source of truth and
 * should be preferred over our local price-table estimate (which can drift when
 * prices change, models are rerouted, or token categories such as reasoning
 * tokens are reported differently).
 *
 * Supported shapes:
 *  - xAI:        usage.cost_in_usd_ticks  (integer, 1 USD = 1e10 ticks)
 *  - OpenRouter: usage.cost               (credits, 1 credit = 1 USD). For BYOK
 *                requests `cost` is only OpenRouter's fee and the upstream
 *                provider charge is in usage.cost_details.upstream_inference_cost.
 *
 * Returns undefined when the provider did not report a cost.
 */
export const USD_TICKS_PER_DOLLAR = 1e10;

export function providerReportedCost(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;

  if (typeof usage.cost_in_usd_ticks === "number") {
    return usage.cost_in_usd_ticks / USD_TICKS_PER_DOLLAR;
  }

  if (typeof usage.cost === "number") {
    const upstream = usage.cost_details?.upstream_inference_cost;
    if (usage.is_byok && typeof upstream === "number") {
      return usage.cost + upstream;
    }
    return usage.cost;
  }

  return undefined;
}
