import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAcademyEditor } from "@/lib/academy/editors";
import { getAcademyLibrary, getAcademyProgress } from "@/lib/academy/queries";
import { AcademyHome } from "@/components/academy/academy-home";

export const metadata: Metadata = { title: "Academy · Hub & Spoke" };
export const dynamic = "force-dynamic";

/**
 * /academy — Hub & Spoke Academy: the internal training-video library.
 * Everyone signed in can watch; Academy editors (src/lib/academy/editors.ts) add, edit and reorder videos here.
 */
export default async function AcademyRoute() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const [library, progress, canEdit] = await Promise.all([
    getAcademyLibrary(),
    getAcademyProgress(session.user.id),
    Promise.resolve(isAcademyEditor(session)),
  ]);
  return <AcademyHome library={library} progress={progress} canEdit={canEdit} />;
}
