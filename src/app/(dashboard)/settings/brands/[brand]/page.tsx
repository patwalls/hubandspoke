import { redirect } from "next/navigation";

interface LegacyBrandGoalsPageProps {
  params: Promise<{ brand: string }>;
}

// Per-brand production settings moved under /[brand]/accounts alongside the
// brand's social accounts. Bookmarks land here and redirect through.
export default async function LegacyBrandGoalsPage({
  params,
}: LegacyBrandGoalsPageProps) {
  const { brand } = await params;
  redirect(`/${brand}/accounts`);
}
