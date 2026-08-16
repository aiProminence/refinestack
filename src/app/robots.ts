import type { MetadataRoute } from "next";
import { brand } from "@/lib/brand";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/privacy", "/terms"], disallow: ["/dashboard", "/api", "/auth"] },
    ],
    sitemap: `https://${brand.domain}/sitemap.xml`,
  };
}
