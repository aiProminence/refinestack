import { describe, expect, it } from "vitest";
import {
  canonicalizeProjectDomain,
  diagnoseProjectDomain,
  diagnoseProjectDomainForSave,
} from "@/lib/security/domain-diagnostics";

describe("project domain diagnostics", () => {
  it("retains a canonical internationalized redirect and reports sparse readable content", async () => {
    const fetcher = async () => new Response("Short page", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "x-refinestack-final-url": "https://münich.example/final?utm_source=setup&b=2&a=1",
      },
    });
    await expect(diagnoseProjectDomain("https://example.com/start", fetcher as never)).resolves.toEqual({
      canonicalUrl: "https://xn--mnich-kva.example/final?a=1&b=2",
      status: 200,
      redirected: true,
      readableCharacters: 10,
      sparse: true,
    });
  });

  it("distinguishes blocked, rate-limited, unsupported, invalid and private destinations", async () => {
    await expect(diagnoseProjectDomain("not a URL", (async () => new Response()) as never)).rejects.toThrow("absolute HTTPS");
    await expect(diagnoseProjectDomain("https://example.com", (async () => new Response("", { status: 403 })) as never)).rejects.toThrow("blocks automated retrieval");
    await expect(diagnoseProjectDomain("https://example.com", (async () => new Response("", { status: 429 })) as never)).rejects.toThrow("rate-limited");
    await expect(diagnoseProjectDomain("https://example.com", (async () => new Response("x", { headers: { "content-type": "image/png" } })) as never)).rejects.toThrow("unsupported content type");
    await expect(diagnoseProjectDomain("https://example.com", (async () => { throw new Error("Private or unresolved destinations are not supported."); }) as never)).rejects.toThrow("private, reserved, or unsupported");
  });

  it("keeps valid project details saveable when HTTPS verification is temporarily unavailable", async () => {
    const result = await diagnoseProjectDomainForSave(
      "https://example.com/?utm_source=setup&b=2&a=1#overview",
      (async () => { throw new Error("External request timed out."); }) as never,
    );

    expect(result).toEqual({
      canonicalUrl: "https://example.com/?a=1&b=2",
      diagnostic: null,
      deferred: true,
      deferredReason: "Primary domain did not respond within 15 seconds.",
    });
  });

  it("uses the verified canonical destination when the setup retrieval succeeds", async () => {
    const fetcher = async () => new Response("A sufficiently descriptive primary-domain page with enough readable words for setup verification to complete successfully.", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "x-refinestack-final-url": "https://www.example.com/final?utm_campaign=setup&b=2&a=1",
      },
    });

    await expect(diagnoseProjectDomainForSave("https://example.com", fetcher as never)).resolves.toMatchObject({
      canonicalUrl: "https://www.example.com/final?a=1&b=2",
      deferred: false,
      deferredReason: null,
      diagnostic: { status: 200, redirected: true },
    });
  });

  it("still rejects unsafe or malformed project domain values before deferring retrieval", async () => {
    expect(() => canonicalizeProjectDomain("http://example.com")).toThrow("absolute HTTPS");
    expect(() => canonicalizeProjectDomain("https://user:password@example.com")).toThrow("embedded credentials");
    expect(() => canonicalizeProjectDomain("https://example.com:8443")).toThrow("standard HTTPS port");
    expect(() => canonicalizeProjectDomain("https://127.0.0.1")).toThrow("public HTTPS hostname");
    await expect(diagnoseProjectDomainForSave("not a URL", (async () => new Response()) as never)).rejects.toThrow("absolute HTTPS");
  });
});
