import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { brand } from "@/lib/brand";

export const metadata = { title: "Workspace access required" };

export default function AccessRevokedPage() {
  return <main className="system-page">
    <Link className="wordmark" href="/">{brand.name}<span>.</span></Link>
    <span className="eyebrow">Access required</span>
    <h1>No active workspace membership.</h1>
    <p>This session is valid, but it has no active invitation or workspace membership. Ask a workspace admin for a new mailbox-bound invitation.</p>
    <form action={signOut}><button className="button" type="submit">Sign out securely</button></form>
  </main>;
}
