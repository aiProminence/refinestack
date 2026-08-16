import { describe, expect, it } from "vitest";
import { diagnoseProjectDomain } from "@/lib/security/domain-diagnostics";

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
});
