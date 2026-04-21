import { redirect } from "next/navigation";

interface LegacyBrandSettingsPageProps {
  params: Promise<{ brand: string }>;
}

// Brand settings moved under /settings/brands/[brand] so the global Settings
// sidebar stays visible. Bookmarks and stale links land here first.
export default async function LegacyBrandSettingsPage({
  params,
}: LegacyBrandSettingsPageProps) {
  const { brand } = await params;
  redirect(`/settings/brands/${brand}`);
}
