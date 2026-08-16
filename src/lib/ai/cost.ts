import type { ProviderKey } from "@/types/contracts";

export type ProviderPreflight = {
  provider: ProviderKey;
  available: boolean;
  requestsPerQuestion?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  fixedCostPerRequestUsd?: number;
  /** Defaults to false only for Google AI Overview. */
  tokenMetered?: boolean;
};
export type CostPreflight = {
  questionCount: number;
  callCount: number;
  estimatedCostUsd: number | null;
  perProvider: Array<{ provider: ProviderKey; callCount: number; estimatedCostUsd: number | null }>;
  unavailableProviders: ProviderKey[];
  blocked: boolean;
  reasons: string[];
  budgetShortfallUsd?: number;
};

export function preflightCost(questionCount: number, providers: ProviderPreflight[], budgetUsd?: number): CostPreflight {
  if (!Number.isSafeInteger(questionCount) || questionCount < 0) throw new RangeError("Question count must be a nonnegative safe integer.");
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) throw new RangeError("Budget must be a nonnegative finite number.");
  if (!providers.length) throw new RangeError("At least one provider must be selected.");
  if (new Set(providers.map(({ provider }) => provider)).size !== providers.length) throw new RangeError("A provider may be selected only once.");
  const count = questionCount;
  const unavailableProviders = providers.filter(({ available }) => !available).map(({ provider }) => provider);
  const perProvider = providers.map((item) => {
    const numeric = [item.requestsPerQuestion, item.estimatedInputTokens, item.estimatedOutputTokens, item.inputPerMillionUsd, item.outputPerMillionUsd, item.fixedCostPerRequestUsd].filter((value): value is number => value !== undefined);
    if (numeric.some((value) => !Number.isFinite(value) || value < 0)) throw new RangeError(`Cost assumptions for ${item.provider} must be finite and nonnegative.`);
    if (item.requestsPerQuestion !== undefined && (!Number.isSafeInteger(item.requestsPerQuestion) || item.requestsPerQuestion < 1)) throw new RangeError(`Requests per question for ${item.provider} must be a positive safe integer.`);
    const requestsPerQuestion = item.requestsPerQuestion ?? 1;
    const callCount = count * requestsPerQuestion;
    if (!Number.isSafeInteger(callCount)) throw new RangeError(`Call count for ${item.provider} exceeds the safe integer limit.`);
    const tokenMetered = item.tokenMetered ?? item.provider !== "google_ai_overview";
    const tokenPricingComplete = item.estimatedInputTokens !== undefined && item.estimatedOutputTokens !== undefined && item.inputPerMillionUsd !== undefined && item.outputPerMillionUsd !== undefined;
    const tokenCost = tokenPricingComplete ? callCount * ((item.estimatedInputTokens! * item.inputPerMillionUsd! + item.estimatedOutputTokens! * item.outputPerMillionUsd!) / 1_000_000) : undefined;
    const fixedCost = item.fixedCostPerRequestUsd === undefined ? undefined : callCount * item.fixedCostPerRequestUsd;
    const complete = tokenMetered ? tokenPricingComplete : fixedCost !== undefined;
    return { provider: item.provider, callCount, estimatedCostUsd: complete ? (tokenCost ?? 0) + (fixedCost ?? 0) : null };
  });
  const complete = perProvider.every(({ estimatedCostUsd }) => estimatedCostUsd !== null);
  const estimatedCostUsd = complete ? perProvider.reduce((sum, item) => sum + item.estimatedCostUsd!, 0) : null;
  const reasons: string[] = [];
  if (count === 0) reasons.push("No questions selected.");
  if (unavailableProviders.length) reasons.push(`Unavailable providers: ${unavailableProviders.join(", ")}.`);
  if (!complete) reasons.push("Pricing or token assumptions are missing for at least one provider.");
  const budgetShortfallUsd = budgetUsd !== undefined && estimatedCostUsd !== null && estimatedCostUsd > budgetUsd ? estimatedCostUsd - budgetUsd : undefined;
  if (budgetShortfallUsd !== undefined) reasons.push(`Estimated cost exceeds the ${budgetUsd!.toFixed(2)} USD budget by ${budgetShortfallUsd.toFixed(2)} USD.`);
  return { questionCount: count, callCount: perProvider.reduce((sum, item) => sum + item.callCount, 0), estimatedCostUsd, perProvider, unavailableProviders, blocked: count === 0 || unavailableProviders.length > 0 || !complete || budgetShortfallUsd !== undefined, reasons, budgetShortfallUsd };
}
