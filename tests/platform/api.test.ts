import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiProblem } from "@/lib/platform/api";
import { reserveGlobalRateSlot, withApiRequest, writeRequestAudit } from "@/lib/platform/api-handler";
import { csvCell, toCsv } from "@/lib/platform/csv";
import { decodeCursor, encodeCursor, pageLimit } from "@/lib/platform/pagination";
import { MAX_JSON_BODY_BYTES, parseJsonBody, requireIdempotencyKey, runRequestSchema, withIdempotencyLock } from "@/lib/platform/routes";
import { hashApiToken, parseBearerToken, roleAllowsScope } from "@/lib/platform/tokens";
import type { Database } from "@/types/database";

const principal = {
  tokenId: "018f47d2-83c3-7b80-a855-69b9298ab2a8",
  tokenName: "CI",
  workspaceId: "018f47d2-83c3-7b80-a855-69b9298ab2a9",
  userId: "018f47d2-83c3-7b80-a855-69b9298ab2aa",
  role: "owner" as const,
  scopes: ["read" as const],
};

describe("external API primitives", () => {
  it("rejects a missing bearer token before requiring admin configuration", async () => {
    const response = await withApiRequest(
      new Request("https://refinestack.test/api/v1"),
      "read",
      vi.fn(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="RefineStack API"');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_access_token", message: "A valid bearer token is required." },
    });
  });

  it("rejects a resolved Supabase audit insertion error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "42501" } });
    const admin = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient<Database>;
    await expect(writeRequestAudit(
      admin,
      principal,
      new Request("https://refinestack.test/api/v1/projects"),
      "read",
      "request-1234",
      200,
    )).rejects.toThrow("audit insertion failed");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: principal.workspaceId,
      actor_token_id: principal.tokenId,
      request_id: "request-1234",
      event_type: "api.request.read",
    }));
  });

  it("hashes bearer tokens with SHA-256 and parses only strict bearer credentials", () => {
    const token = `rfs_${"a".repeat(43)}`;
    expect(hashApiToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashApiToken(token)).not.toContain(token);
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
    expect(parseBearerToken(`Basic ${token}`)).toBeNull();
    expect(parseBearerToken("Bearer too-short")).toBeNull();
    expect(parseBearerToken(`bearer ${token}`)).toBeNull();
  });

  it("requires both scope and a sufficiently privileged current role", () => {
    expect(roleAllowsScope("viewer", "read")).toBe(true);
    expect(roleAllowsScope("viewer", "run")).toBe(false);
    expect(roleAllowsScope("analyst", "run")).toBe(true);
    expect(roleAllowsScope("admin", "export")).toBe(false);
    expect(roleAllowsScope("owner", "export")).toBe(true);
  });

  it("uses the atomic database admission result and rejects malformed responses", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, used: 2, remaining: 58, resetAt: "2026-08-16T12:01:00.000+00:00" }, error: null,
    });
    const admin = { rpc } as unknown as SupabaseClient<Database>;
    await expect(reserveGlobalRateSlot(admin, principal, "read", 60)).resolves.toEqual({
      allowed: true, used: 2, remaining: 58, resetAt: "2026-08-16T12:01:00.000+00:00",
    });
    expect(rpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_token_id: principal.tokenId, p_scope: "read", p_limit: 60, p_window_seconds: 60,
    });
    rpc.mockResolvedValueOnce({ data: { allowed: "yes" }, error: null });
    await expect(reserveGlobalRateSlot(admin, principal, "read", 60)).rejects.toMatchObject({ status: 503, code: "rate_limit_unavailable" });
  });

  it("treats a token revoked during atomic admission as invalid", async () => {
    const admin = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) } as unknown as SupabaseClient<Database>;
    await expect(reserveGlobalRateSlot(admin, principal, "read", 60)).rejects.toMatchObject({ status: 401, code: "invalid_access_token" });
  });

  it("round-trips signed keyset cursors and rejects tampering", () => {
    const secret = "cursor-secret-that-is-long-enough";
    const cursor = encodeCursor({ v: 1, sort: "2026-08-16T12:00:00.000Z", id: "018f47d2-83c3-7b80-a855-69b9298ab2a8" }, secret);
    expect(decodeCursor(cursor, secret)).toEqual({ v: 1, sort: "2026-08-16T12:00:00.000Z", id: "018f47d2-83c3-7b80-a855-69b9298ab2a8" });
    expect(() => decodeCursor(`${cursor.slice(0, -1)}x`, secret)).toThrow(ApiProblem);
    expect(() => decodeCursor(cursor, `${secret}-wrong`)).toThrow(ApiProblem);
  });

  it("bounds page sizes", () => {
    expect(pageLimit(null)).toBe(25);
    expect(pageLimit("100")).toBe(100);
    expect(() => pageLimit("0")).toThrow(/1 to 100/u);
    expect(() => pageLimit("101")).toThrow(/1 to 100/u);
    expect(() => pageLimit("2.5")).toThrow(/1 to 100/u);
  });

  it("quotes CSV and neutralizes spreadsheet formulas", () => {
    expect(csvCell('hello,"world"')).toBe('"hello,""world"""');
    expect(csvCell("=HYPERLINK(\"https://bad.test\")")).toBe('"\'=HYPERLINK(""https://bad.test"")"');
    const csv = toCsv(["answer", "count"], [{ answer: "+cmd", count: 2 }]);
    expect(csv).toBe("answer,count\r\n'+cmd,2");
  });

  it("requires a bounded idempotency key", () => {
    expect(requireIdempotencyKey(new Request("https://example.test", { headers: { "Idempotency-Key": "run:2026-08-16" } }))).toBe("run:2026-08-16");
    expect(() => requireIdempotencyKey(new Request("https://example.test"))).toThrow(ApiProblem);
    expect(() => requireIdempotencyKey(new Request("https://example.test", { headers: { "Idempotency-Key": "bad key" } }))).toThrow(ApiProblem);
  });

  it("accepts only run cohorts while the database owns the maximum-cost estimate", () => {
    const request = {
      questionVersionIds: ["018f47d2-83c3-7b80-a855-69b9298ab2a8"],
      providers: ["openai"],
    };
    expect(runRequestSchema.parse(request)).toEqual(request);
    expect(runRequestSchema.safeParse({ ...request, estimatedMaxCostUsd: 0 }).success).toBe(false);
  });

  it("parses valid JSON without requiring Content-Length", async () => {
    const body = JSON.stringify({ name: "bounded" });
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await expect(parseJsonBody(request, z.object({ name: z.string() }))).resolves.toEqual({ name: "bounded" });
  });

  it("rejects oversized JSON with missing, chunked, understated, or excessive Content-Length", async () => {
    const oversized = JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) });
    const requests = [
      new Request("https://example.test", {
        method: "POST", headers: { "content-type": "application/json" }, body: oversized,
      }),
      new Request("https://example.test", {
        method: "POST", headers: { "content-type": "application/json", "content-length": "12" }, body: oversized,
      }),
      new Request("https://example.test", {
        method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_JSON_BODY_BYTES + 1) }, body: "{}",
      }),
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(oversized.slice(0, 40_000)));
            controller.enqueue(new TextEncoder().encode(oversized.slice(40_000)));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
    ];

    for (const request of requests) {
      await expect(parseJsonBody(request, z.unknown())).rejects.toMatchObject({ status: 413, code: "request_too_large" });
    }
  });

  it("retains stable errors for media type, malformed UTF-8, malformed JSON, and schema failures", async () => {
    await expect(parseJsonBody(new Request("https://example.test", { method: "POST", body: "{}" }), z.unknown()))
      .rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
    await expect(parseJsonBody(new Request("https://example.test", {
      method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]),
    }), z.unknown())).rejects.toMatchObject({ status: 400, code: "invalid_json" });
    await expect(parseJsonBody(new Request("https://example.test", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }), z.unknown())).rejects.toMatchObject({ status: 400, code: "invalid_json" });
    await expect(parseJsonBody(new Request("https://example.test", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), z.object({ name: z.string() }))).rejects.toMatchObject({ status: 422, code: "validation_failed" });
  });

  it("serializes concurrent work for the same idempotency key", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withIdempotencyLock("workspace:key", async () => { order.push("first:start"); await firstWait; order.push("first:end"); });
    const second = withIdempotencyLock("workspace:key", async () => { order.push("second"); });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
