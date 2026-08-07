import type { Metadata } from "next";
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
