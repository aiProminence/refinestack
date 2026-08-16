import type { MetadataRoute } from "next";
import { brand } from "@/lib/brand";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = `https://${brand.domain}`;
  return ["", "/api-docs", "/privacy", "/security", "/terms"].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" || path === "/api-docs" ? "weekly" : "yearly",
    priority: path === "" ? 1 : path === "/api-docs" ? 0.6 : 0.3,
  }));
}
