import { redirect } from "next/navigation";

interface LegacyCrossPostRulesPageProps {
  params: Promise<{ brand: string }>;
}

// Cross-post rules moved under /[brand]/accounts/cross-posting alongside the
// other brand-scoped config. Bookmarks and stale links land here first.
export default async function LegacyCrossPostRulesPage({
  params,
}: LegacyCrossPostRulesPageProps) {
  const { brand } = await params;
  redirect(`/${brand}/accounts/cross-posting`);
}
