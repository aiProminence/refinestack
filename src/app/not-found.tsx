import Link from "next/link";
import { brand } from "@/lib/brand";

export default function NotFound() {
  return <main className="system-page">
    <span className="eyebrow">404</span>
    <h1>This page is outside the map.</h1>
    <p>The requested RefineStack page does not exist or is no longer available.</p>
    <Link className="button" href="/">Return to {brand.name}</Link>
  </main>;
}
