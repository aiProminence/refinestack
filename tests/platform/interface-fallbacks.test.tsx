import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GlobalError from "@/app/global-error";
import { BidiText } from "@/components/product-ui";

describe("shared interface fallbacks", () => {
  it("renders an accessible, branded root error document", () => {
    const html = renderToStaticMarkup(<GlobalError error={new Error("private detail")} reset={vi.fn()} />);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<main");
    expect(html).toContain("Application error · RefineStack");
    expect(html).toContain("mailto:hello@refinestack.com");
    expect(html).not.toContain("private detail");
  });

  it("isolates customer-authored bidirectional text", () => {
    const html = renderToStaticMarkup(<BidiText>علامة RefineStack</BidiText>);
    expect(html).toBe('<bdi dir="auto">علامة RefineStack</bdi>');
  });
});
