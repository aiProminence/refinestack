import { describe, expect, it } from "vitest";
import { hashSecret, redactSecrets, secretsMatch, signWebhook, verifyWebhookDelivery, verifyWebhookSignature } from "@/lib/security/secrets";
import { isPublicIp, resolveSafeExternalUrl } from "@/lib/security/external-url";

describe("secret utilities", () => {
  it("hashes and compares secrets without accepting malformed hashes", () => {
    const first = hashSecret("token", "pepper");
    const second = hashSecret("token", "pepper");
    expect(secretsMatch(first, second)).toBe(true);
    expect(secretsMatch(first, "not-a-hash")).toBe(false);
  });

  it("verifies signed webhook bodies inside the tolerance only", () => {
    const timestamp = "2000000000000";
    const signature = signWebhook(timestamp, '{"ok":true}', "secret");
    expect(verifyWebhookSignature({ timestamp, rawBody: '{"ok":true}', secret: "secret", signature, now: 2_000_000_100_000 })).toBe(true);
    expect(verifyWebhookSignature({ timestamp, rawBody: '{"ok":false}', secret: "secret", signature, now: 2_000_000_100_000 })).toBe(false);
    expect(verifyWebhookSignature({ timestamp, rawBody: '{"ok":true}', secret: "secret", signature, now: 2_000_001_000_000 })).toBe(false);
  });

  it("atomically rejects a replayed webhook delivery", async () => {
    const consumed = new Set<string>();
    const consumeReplayKey = async (key: string) => !consumed.has(key) && Boolean(consumed.add(key));
    const timestamp = "2000000000000";
    const rawBody = '{"id":"delivery_12345678"}';
    const signature = signWebhook(timestamp, rawBody, "secret");
    const input = { timestamp, rawBody, signature, secret: "secret", deliveryId: "delivery_12345678", now: 2_000_000_100_000, consumeReplayKey };
    expect(await verifyWebhookDelivery(input)).toBe(true);
    expect(await verifyWebhookDelivery(input)).toBe(false);
    expect(await verifyWebhookDelivery({ ...input, deliveryId: "delivery_87654321" })).toBe(false);
  });

  it("deeply redacts credentials in fields, bearer values, and URLs", () => {
    const redacted = redactSecrets({ x_api_key: "top-secret", message: "Bearer abc.def", url: "https://example.test/?api_key=secret&q=safe" });
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).not.toContain("abc.def");
    expect(JSON.stringify(redacted)).not.toContain("api_key=secret");
  });
});

describe("external URL boundaries", () => {
  it.each(["127.0.0.1", "10.1.2.3", "100.100.100.200", "100.64.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"])("blocks private address %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it("rejects non-HTTPS, credentialed, nonstandard-port, and mixed-DNS destinations", async () => {
    const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
    await expect(resolveSafeExternalUrl("http://example.test", publicResolver)).rejects.toThrow(/HTTPS/);
    await expect(resolveSafeExternalUrl("https://user:pass@example.test", publicResolver)).rejects.toThrow(/credentials/);
    await expect(resolveSafeExternalUrl("https://example.test:8443", publicResolver)).rejects.toThrow(/standard HTTPS port/);
    await expect(resolveSafeExternalUrl("https://[::1]", publicResolver)).rejects.toThrow(/Private/);
    await expect(resolveSafeExternalUrl("https://example.test", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])).rejects.toThrow(/Private/);
  });
});
