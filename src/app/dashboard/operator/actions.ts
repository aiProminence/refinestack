"use server";

import { runOperatorQuery, operatorIntents, type OperatorIntent, type OperatorResult } from "@/lib/db/operator";
import type { MetricValue } from "@/types/contracts";
import { getDashboardContext } from "../_context";

export type OperatorActionState = { result: OperatorResult | null; error: string | null };

const metricKeys: MetricValue["key"][] = [
  "capture_coverage", "mention_rate", "mention_share", "recommendation_rate",
  "recommendation_share", "first_choice_rate", "owned_citation_rate", "evidence_support_rate",
];

export async function runOperatorAction(_previous: OperatorActionState, formData: FormData): Promise<OperatorActionState> {
  try {
    const projectId = formData.get("projectId");
    const intent = formData.get("intent");
    const metricKey = formData.get("metricKey");
    if (typeof projectId !== "string" || !projectId) throw new Error("A project is required.");
    if (typeof intent !== "string" || !operatorIntents.includes(intent as OperatorIntent)) throw new Error("Choose a supported operator question.");
    if (typeof metricKey !== "string" || !metricKeys.includes(metricKey as MetricValue["key"])) throw new Error("Choose a supported metric.");
    const ctx = await getDashboardContext();
    const result = await runOperatorQuery(ctx, { projectId, intent: intent as OperatorIntent, metricKey: metricKey as MetricValue["key"] });
    return { result, error: null };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message.slice(0, 240) : "The operator query failed." };
  }
}
