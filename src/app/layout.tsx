import type { Metadata } from "next";
import { connection } from "next/server";
import { brand } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${brand.domain}`),
  title: { default: `${brand.name} — ${brand.descriptor}`, template: `%s · ${brand.name}` },
  description: brand.description,
  applicationName: brand.name,
  openGraph: {
    type: "website",
    title: `${brand.name} — ${brand.descriptor}`,
    description: brand.description,
    siteName: brand.name,
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // A per-request render lets Proxy attach one unpredictable CSP nonce to every framework script.
  await connection();
  return <html lang="en"><body>{children}</body></html>;
}
