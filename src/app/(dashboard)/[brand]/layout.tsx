import { EyeIcon } from "lucide-react";
import { auth } from "@/lib/auth";
import { canEditBrand } from "@/lib/brand-access";

/**
 * Per-brand shell. Today it only adds the "view only" banner for creators who
 * aren't assigned this brand (src/lib/brand-access.ts) — the API 403s their
 * changes, so tell them up front instead of letting them find out on save.
 */
export default async function BrandLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ brand: string }>;
}) {
  const { brand } = await params;
  const session = await auth();
  const canEdit = await canEditBrand(session, brand);

  return (
    <>
      {!canEdit && (
        <div className="mb-3 sm:mb-4 flex items-start gap-3 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
          <EyeIcon className="size-4 mt-0.5 shrink-0 text-sky-600" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">You have view-only access to this brand.</div>
            <div className="mt-0.5 text-xs text-sky-800 dark:text-sky-200">
              You can browse everything here, but changes won&apos;t save. Ask an admin to add
              this brand to your account for edit access.
            </div>
          </div>
        </div>
      )}
      {children}
    </>
  );
}
