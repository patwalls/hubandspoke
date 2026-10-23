import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { NewsletterDrafterPage } from "@/components/dashboard/newsletter-drafter-page";

interface NewslettersPageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({ params }: NewslettersPageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return { title: brandConfig ? `Newsletters · ${brandConfig.label}` : "Newsletters" };
}

/** Newsletter drafter (feature flag `newsletterDrafter`) — 404 for everyone else. */
export default async function BrandNewslettersPage({ params }: NewslettersPageProps) {
  const session = await auth();
  if (!isFeatureEnabled("newsletterDrafter", session?.user)) notFound();
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();
  // Suspense: the board reads `?open=<draft id>` (the nav's New → Newsletter lands here with the editor open).
  return (
    <Suspense>
      <NewsletterDrafterPage brand={brand} />
    </Suspense>
  );
}
