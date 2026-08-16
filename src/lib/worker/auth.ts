import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

const MIN_OPERATIONAL_SECRET_BYTES = 32;
const MIN_OPERATIONAL_SECRET_ENTROPY_BITS = 128;
const MAX_OPERATIONAL_SECRET_BYTES = 512;

function digest(value: string | undefined) {
  return createHash("sha256").update(value ?? "", "utf8").digest();
}

/** Rejects short, whitespace-bearing, or predictably repetitive operational credentials. */
export function isStrongOperationalSecret(value: string | undefined) {
  if (!value || /\s/u.test(value)) return false;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < MIN_OPERATIONAL_SECRET_BYTES || byteLength > MAX_OPERATIONAL_SECRET_BYTES) return false;

  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropyPerCharacter = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropyPerCharacter -= probability * Math.log2(probability);
  }
  return entropyPerCharacter * value.length >= MIN_OPERATIONAL_SECRET_ENTROPY_BITS;
}

export function operationalSecretState(env: NodeJS.ProcessEnv = process.env): "healthy" | "unconfigured" | "invalid" {
  const configured = [env.WORKER_SECRET, env.CRON_SECRET].filter((value): value is string => Boolean(value));
  if (configured.length === 0) return "unconfigured";
  return configured.every(isStrongOperationalSecret) ? "healthy" : "invalid";
}

export function workerRequestAuthorized(request: Request, env: NodeJS.ProcessEnv = process.env) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer ([^\s]+)$/u);
  const supplied = digest(match?.[1]);
  const workerSecret = env.WORKER_SECRET;
  const cronSecret = env.CRON_SECRET;
  const workerMatch = isStrongOperationalSecret(workerSecret) && timingSafeEqual(supplied, digest(workerSecret));
  const cronMatch = isStrongOperationalSecret(cronSecret) && timingSafeEqual(supplied, digest(cronSecret));
  return Boolean(match && (Number(workerMatch) | Number(cronMatch)));
}
