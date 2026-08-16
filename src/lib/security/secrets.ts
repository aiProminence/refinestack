import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_KEY = /(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|page[-_]?token|secret|credential|password|cookie|private[-_]?key)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ASSIGNED_SECRET = /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|credential)=([^&\s]+)/gi;

function redactString(value: string) {
  let redacted = value.replace(BEARER_VALUE, "Bearer [redacted]").replace(ASSIGNED_SECRET, "$1=[redacted]");
  try {
    const url = new URL(redacted);
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    redacted = url.toString();
  } catch {
    // Most provider messages are not URLs.
  }
  return redacted;
}

/** Removes credential-shaped fields and values before errors or raw metadata leave a server boundary. */
export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(item, seen),
  ]));
}

export function generateOpaqueToken(prefix = "rfs") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashSecret(secret: string, pepper = "") {
  return createHash("sha256").update(`${pepper}:${secret}`, "utf8").digest("hex");
}

export function secretsMatch(leftHex: string, rightHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(leftHex) || !/^[a-f0-9]{64}$/i.test(rightHex)) return false;
  return timingSafeEqual(Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex"));
}

export function signWebhook(timestamp: string, rawBody: string, secret: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export function verifyWebhookSignature(input: {
  timestamp: string;
  rawBody: string;
  secret: string;
  signature: string;
  now?: number;
  toleranceSeconds?: number;
}) {
  const issuedAt = Number(input.timestamp);
  const now = input.now ?? Date.now();
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > tolerance) return false;
  const expected = signWebhook(input.timestamp, input.rawBody, input.secret);
  return secretsMatch(expected, input.signature);
}

export async function verifyWebhookDelivery(input: {
  timestamp: string;
  rawBody: string;
  secret: string;
  signature: string;
  deliveryId: string;
  now?: number;
  toleranceSeconds?: number;
  /** Must atomically return false when the key was already consumed. */
  consumeReplayKey: (key: string, expiresAt: number) => Promise<boolean>;
}) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(input.deliveryId)) return false;
  if (!verifyWebhookSignature(input)) return false;
  try {
    const envelope = JSON.parse(input.rawBody) as { id?: unknown; deliveryId?: unknown; delivery_id?: unknown };
    const signedDeliveryId = envelope.deliveryId ?? envelope.delivery_id ?? envelope.id;
    if (signedDeliveryId !== input.deliveryId) return false;
  } catch { return false; }
  const now = input.now ?? Date.now();
  const expiresAt = now + (input.toleranceSeconds ?? 300) * 1000;
  return input.consumeReplayKey(hashSecret(`webhook-delivery:${input.deliveryId}`), expiresAt);
}
