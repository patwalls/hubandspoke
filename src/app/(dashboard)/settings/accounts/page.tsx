import { redirect } from "next/navigation";
import { getDefaultBrandSlug } from "@/lib/db/brands";

// Accounts moved under the brand tab bar at /[brand]/accounts. Bookmarks and
// stale links land here and get redirected to the default brand's accounts.
export default async function LegacyAccountsSettingsPage() {
  const brand = await getDefaultBrandSlug();
  redirect(`/${brand}/accounts`);
}
