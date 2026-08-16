import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhook } from "@/lib/security/secrets";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  parseWebhookSignature,
  verifyIncomingWebhook,
  webhookRetryDelayMs,
} from "@/lib/platform/webhooks";

describe("webhook delivery contracts", () => {
  it("encrypts secrets with authenticated encryption and refuses the wrong key", () => {
    const key = randomBytes(32);
    const encrypted = encryptWebhookSecret("a-production-webhook-secret", key);
    expect(encrypted).toMatch(/^\\x[0-9a-f]+$/u);
    expect(encrypted).not.toContain("a-production-webhook-secret");
    expect(decryptWebhookSecret(encrypted, key)).toBe("a-production-webhook-secret");
    expect(() => decryptWebhookSecret(encrypted, randomBytes(32))).toThrow();
  });

  it("uses a bounded exponential retry with constrained jitter", () => {
    expect(webhookRetryDelayMs(1, () => 0)).toBe(24_000);
    expect(webhookRetryDelayMs(1, () => 0.5)).toBe(30_000);
    expect(webhookRetryDelayMs(2, () => 1)).toBe(144_000);
    expect(webhookRetryDelayMs(20, () => 0.5)).toBe(21_600_000);
    expect(() => webhookRetryDelayMs(0)).toThrow(/positive/u);
  });

  it("parses only the documented signature header", () => {
    const signature = "a".repeat(64);
    expect(parseWebhookSignature(`sha256=${signature}`)).toBe(signature);
    expect(parseWebhookSignature(signature)).toBeNull();
    expect(parseWebhookSignature("sha256=short")).toBeNull();
  });

  it("verifies timestamp.raw-body HMAC and atomically rejects replay", async () => {
    const rawBody = '{"id":"event_12345678","deliveryId":"delivery_12345678","data":{"ok":true}}';
    const timestamp = "2000000000000";
    const secret = "a-production-webhook-secret";
    const signatureHeader = `sha256=${signWebhook(timestamp, rawBody, secret)}`;
    const consumed = new Set<string>();
    const replayStore = { consume: async (key: string) => !consumed.has(key) && Boolean(consumed.add(key)) };
    const input = { timestamp, rawBody, signatureHeader, secret, deliveryId: "delivery_12345678", replayStore, now: 2_000_000_100_000 };
    expect(await verifyIncomingWebhook(input)).toBe(true);
    expect(await verifyIncomingWebhook(input)).toBe(false);
    expect(await verifyIncomingWebhook({ ...input, deliveryId: "delivery_87654321", rawBody: `${rawBody} ` })).toBe(false);
    expect(await verifyIncomingWebhook({ ...input, deliveryId: "delivery_87654321", now: 2_000_001_000_000 })).toBe(false);
  });
});
