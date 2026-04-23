import { redirect } from "next/navigation";

interface LegacyBrandSettingsPageProps {
  params: Promise<{ brand: string }>;
}

// Brand settings moved under /[brand]/accounts alongside the brand's social
// accounts. Bookmarks and stale links land here first.
export default async function LegacyBrandSettingsPage({
  params,
}: LegacyBrandSettingsPageProps) {
  const { brand } = await params;
  redirect(`/${brand}/accounts`);
}
