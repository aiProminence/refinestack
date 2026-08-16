import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { runWorkerCycle, workerRequestAuthorized } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const manualSchema = z.object({
  limit: z.number().finite().int().min(1).max(10).optional(),
}).strict();

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function defaultLimit() {
  const configured = Number(process.env.WORKER_BATCH_LIMIT ?? 2);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 10 ? configured : 2;
}

async function execute(limit: number) {
  const result = await runWorkerCycle({
    client: createAdminClient(),
    workerId: `worker:${randomUUID()}`,
    limit,
    leaseSeconds: 300,
  });
  return response({ ok: true, result });
}

export async function GET(request: Request) {
  if (!workerRequestAuthorized(request)) return response({ error: "Unauthorized" }, 401);
  const value = new URL(request.url).searchParams.get("limit");
  const limit = value === null ? defaultLimit() : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) return response({ error: "Invalid request" }, 400);
  try {
    return await execute(limit);
  } catch {
    return response({ error: "Worker execution failed", requestId: randomUUID() }, 500);
  }
}

export async function POST(request: Request) {
  if (!workerRequestAuthorized(request)) return response({ error: "Unauthorized" }, 401);
  let parsed: z.infer<typeof manualSchema>;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isFinite(contentLength) || contentLength > 1_024) return response({ error: "Invalid request" }, 400);
    const rawBody = await request.text();
    if (rawBody.length > 1_024) return response({ error: "Invalid request" }, 400);
    const body = rawBody.trim() ? JSON.parse(rawBody) : {};
    const result = manualSchema.safeParse(body);
    if (!result.success) return response({ error: "Invalid request" }, 400);
    parsed = result.data;
  } catch {
    return response({ error: "Invalid request" }, 400);
  }
  try {
    return await execute(parsed.limit ?? defaultLimit());
  } catch {
    return response({ error: "Worker execution failed", requestId: randomUUID() }, 500);
  }
}
