import { describe, expect, it } from "vitest";
import { safeRelativePath } from "@/lib/security/safe-next";

describe("safeRelativePath", () => {
  it("preserves local paths, query strings and fragments", () => {
    expect(safeRelativePath("/dashboard/runs?state=failed#results"))
      .toBe("/dashboard/runs?state=failed#results");
  });

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/dashboard\nevil",
  ])("rejects an external or ambiguous target: %s", (target) => {
    expect(safeRelativePath(target)).toBe("/dashboard");
  });
});
