import { describe, expect, it, vi } from "vitest";
import {
  buildEvidenceStoragePath,
  canonicalizeEvidenceUrl,
  MAX_EVIDENCE_FILE_BYTES,
  parseEvidenceFile,
  retrieveEvidenceUrl,
  sanitizeEvidenceFilename,
  uploadEvidenceFile,
} from "@/lib/evidence/ingest";

describe("retrieveEvidenceUrl", () => {
  it("stores readable text and hashes the retrieved content", async () => {
    const fetcher = vi.fn(async () => new Response(
      "<html><style>hidden</style><h1>Buyer evidence</h1><p>Verified claim &amp; source.</p></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ));
    const result = await retrieveEvidenceUrl("https://example.com/research", {
      fetcher: fetcher as never,
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(result.contentText).toBe("Buyer evidence\nVerified claim & source.");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.mimeType).toBe("text/html");
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com/research",
      expect.objectContaining({ method: "GET" }),
      expect.objectContaining({ maxRedirects: 3, maxBytes: 1_000_000 }),
    );
  });

  it("rejects failed, binary and empty retrievals", async () => {
    await expect(retrieveEvidenceUrl("https://example.com", {
      fetcher: (async () => new Response("no", { status: 404 })) as never,
    })).rejects.toThrow("HTTP 404");
    await expect(retrieveEvidenceUrl("https://example.com", {
      fetcher: (async () => new Response("bytes", { headers: { "content-type": "application/octet-stream" } })) as never,
    })).rejects.toThrow("not supported");
    await expect(retrieveEvidenceUrl("https://example.com", {
      fetcher: (async () => new Response("   ", { headers: { "content-type": "text/plain" } })) as never,
    })).rejects.toThrow("no readable text");
  });

  it("retains the original URL while canonicalizing a validated redirect and tracking parameters", async () => {
    const fetcher = vi.fn(async () => new Response("Evidence", {
      headers: {
        "content-type": "text/plain",
        "x-refinestack-final-url": "https://Example.com/final?utm_source=email&b=2&a=1#claim",
      },
    }));
    const result = await retrieveEvidenceUrl("https://example.com/start?fbclid=tracking", { fetcher: fetcher as never });
    expect(result.originalUrl).toBe("https://example.com/start?fbclid=tracking");
    expect(result.canonicalUrl).toBe("https://example.com/final?a=1&b=2");
    expect(canonicalizeEvidenceUrl("https://example.com/path?utm_campaign=x&keep=yes#g")).toBe("https://example.com/path?keep=yes");
  });
});

describe("private evidence files", () => {
  it("accepts the bounded safe formats, decodes UTF-8 and hashes the original bytes", async () => {
    const cases = [
      ["notes.txt", "text/plain", "Research notes"],
      ["README.md", "text/markdown", "# Research"],
      ["claims.csv", "text/csv", "claim,source\nOne,Desk"],
      ["facts.json", "application/json", "{\"verified\":true}"],
      ["page.html", "text/html", "<h1>Visible</h1><script>secret()</script><p>Claim</p>"],
    ] as const;
    for (const [name, type, body] of cases) {
      const result = await parseEvidenceFile(new File([body], name, { type }));
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.size).toBe(Buffer.byteLength(body));
      expect(result.safeFilename).toBe(name);
      if (name.endsWith(".html")) {
        expect(result.contentText).toBe("Visible\nClaim");
        expect(result.contentText).not.toContain("secret");
      }
    }
  });

  it("sanitizes names and creates tenant-scoped non-overwriting paths", () => {
    expect(sanitizeEvidenceFilename("../Q3 buyer: research.MD")).toBe("Q3-buyer-research.md");
    expect(buildEvidenceStoragePath({
      workspaceId: "WORK-123",
      projectId: "PROJECT-456",
      sourceId: "SOURCE-789",
      objectId: "OBJECT-000",
      safeFilename: "../Q3 buyer: research.MD",
    })).toBe("work-123/project-456/source-789/object-000-Q3-buyer-research.md");
  });

  it("rejects unsupported, oversized, invalid UTF-8, binary, mismatched and malformed files", async () => {
    await expect(parseEvidenceFile(new File(["x"], "payload.svg", { type: "image/svg+xml" }))).rejects.toThrow(".txt, .md, .csv, .json, or .html");
    await expect(parseEvidenceFile(new File([new Uint8Array(MAX_EVIDENCE_FILE_BYTES + 1)], "large.txt", { type: "text/plain" }))).rejects.toThrow("1,000,000 bytes or smaller");
    await expect(parseEvidenceFile(new File([new Uint8Array([0xc3, 0x28])], "broken.txt", { type: "text/plain" }))).rejects.toThrow("valid UTF-8");
    await expect(parseEvidenceFile(new File(["safe\0binary"], "binary.txt", { type: "text/plain" }))).rejects.toThrow("control characters");
    await expect(parseEvidenceFile(new File(["plain"], "notes.txt", { type: "text/html" }))).rejects.toThrow("does not match");
    await expect(parseEvidenceFile(new File(["{broken"], "facts.json", { type: "application/json" }))).rejects.toThrow("not valid JSON");
  });

  it("uploads to the private bucket without overwrite", async () => {
    const upload = vi.fn(async () => ({ data: { path: "workspace/project/source/object-notes.txt" }, error: null }));
    const from = vi.fn(() => ({ upload }));
    const parsed = await parseEvidenceFile(new File(["Private claim"], "notes.txt", { type: "text/plain" }));
    const path = await uploadEvidenceFile({ storage: { from } } as never, {
      workspaceId: "workspace",
      projectId: "project",
      sourceId: "source",
      file: parsed,
    });
    expect(path).toBe("workspace/project/source/object-notes.txt");
    expect(from).toHaveBeenCalledWith("evidence-private");
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^workspace\/project\/source\/[a-f0-9-]+-notes\.txt$/u), expect.any(ArrayBuffer), {
      cacheControl: "0",
      contentType: "text/plain",
      upsert: false,
    });
  });
});
