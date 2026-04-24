import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  listShortLinks,
  ShortLinksApiError,
  type ShortLink,
} from "@/lib/services/short-links";
import { ShortLinksSettings } from "@/components/settings/short-links-settings";

export const metadata: Metadata = { title: "Short links · Settings" };
export const dynamic = "force-dynamic";

export default async function ShortLinksSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  if (session.user.role !== "admin") {
    return (
      <div className="rounded-lg border border-border bg-card p-6 max-w-xl">
        <h2 className="text-base font-semibold text-foreground">Admins only</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Only admins can manage short links. Contact an admin if you need access.
        </p>
      </div>
    );
  }

  const baseUrl = process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

  let links: ShortLink[] = [];
  let loadError: string | null = null;
  try {
    links = await listShortLinks({ includeArchived: true });
  } catch (err) {
    loadError =
      err instanceof ShortLinksApiError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Failed to load short links";
  }

  return (
    <ShortLinksSettings
      initialLinks={links}
      baseUrl={baseUrl}
      initialError={loadError}
    />
  );
}
