import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getBrands } from "@/lib/db/brands";
import { isAdminNow } from "@/lib/brand-access";
import { BrandsSettingsContent } from "@/components/settings/brands-settings";

export const metadata: Metadata = { title: "Brands · Settings" };
export const dynamic = "force-dynamic";

export default async function BrandsSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const [rows, canManageBrands] = await Promise.all([getBrands(), isAdminNow(session)]);
  return (
    <BrandsSettingsContent
      brands={rows.map((b) => ({
        id: b.id,
        slug: b.slug,
        label: b.label,
        avatarUrl: b.avatarUrl,
        color: b.color,
        disabled: b.disabled,
        sortOrder: b.sortOrder,
      }))}
      canManageBrands={canManageBrands}
    />
  );
}
