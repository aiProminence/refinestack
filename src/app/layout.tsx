import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Prominence — AI recommendation intelligence", template: "%s · Prominence" },
  description: "Measure when AI recommends your brand, why it wins, and what will improve its recommendation share.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
