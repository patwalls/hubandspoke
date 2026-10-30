import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { isAdminNow } from "@/lib/brand-access";
import { DevelopersPage } from "@/components/developers/developers-page";

export const metadata: Metadata = { title: "API & MCP · Hub & Spoke" };

/**
 * /developers — the API hub. Create keys, read the reference, try endpoints
 * with your session, connect an AI assistant over MCP, see recent requests.
 * Every signed-in user can use it (the API is read-only and creators can read
 * every brand); admins also see everyone's keys and activity.
 */
export default async function DevelopersRoute() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return (
    <DevelopersPage
      baseUrl={`${proto}://${host}`}
      isAdmin={await isAdminNow(session)}
      userEmail={session.user.email ?? ""}
    />
  );
}
