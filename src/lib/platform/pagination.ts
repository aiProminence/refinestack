import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiProblem } from "./api";

export type PageCursor = { v: 1; sort: string; id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function encodeCursor(cursor: PageCursor, secret: string) {
  const canonical = { ...cursor, sort: new Date(cursor.sort).toISOString() };
  const payload = Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function decodeCursor(value: string | null, secret: string): PageCursor | null {
  if (!value) return null;
  const [payload, received, extra] = value.split(".");
  if (!payload || !received || extra || received.length > 100) throw invalidCursor();
  const expected = signature(payload, secret);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw invalidCursor();
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<PageCursor>;
    if (parsed.v !== 1 || typeof parsed.sort !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed.sort) ||
      typeof parsed.id !== "string" || !UUID.test(parsed.id)) throw invalidCursor();
    return { v: 1, sort: parsed.sort, id: parsed.id };
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw invalidCursor();
  }
}

export function pageLimit(value: string | null, maximum = 100, fallback = 25) {
  if (value == null) return fallback;
  if (!/^\d{1,3}$/u.test(value)) throw new ApiProblem(400, "invalid_limit", `Limit must be an integer from 1 to ${maximum}.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum) throw new ApiProblem(400, "invalid_limit", `Limit must be an integer from 1 to ${maximum}.`);
  return parsed;
}

export function cursorSecret() {
  const value = process.env.API_CURSOR_SECRET ?? process.env.WORKER_SECRET ??
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value || value.length < 24) throw new ApiProblem(503, "service_not_configured", "API pagination is not configured.");
  return value;
}

function invalidCursor() {
  return new ApiProblem(400, "invalid_cursor", "The pagination cursor is invalid or expired.");
}
