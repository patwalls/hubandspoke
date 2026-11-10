import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAcademyEditor } from "@/lib/academy/editors";
import { flattenVideos, getAcademyLibrary, getAcademyProgress } from "@/lib/academy/queries";
import { AcademyVideoPage } from "@/components/academy/academy-video-page";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const video = flattenVideos(await getAcademyLibrary()).find((v) => v.slug === slug);
  return { title: `${video?.title ?? "Learning Center"} · Hub & Spoke Learning Center` };
}

/** /learning-center/[slug] — one training video, with the library sidebar and prev/next. */
export default async function AcademyVideoRoute({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { slug } = await params;

  const [library, progress, canEdit] = await Promise.all([
    getAcademyLibrary(),
    getAcademyProgress(session.user.id),
    Promise.resolve(isAcademyEditor(session)),
  ]);
  const all = flattenVideos(library);
  const index = all.findIndex((v) => v.slug === slug);
  if (index === -1) notFound();
  const video = all[index];
  const pick = (i: number) => (all[i] ? { slug: all[i].slug, title: all[i].title } : null);

  return (
    <AcademyVideoPage
      library={library}
      video={video}
      categoryName={library.find((c) => c.id === video.categoryId)?.name ?? ""}
      prev={pick(index - 1)}
      next={pick(index + 1)}
      progress={progress}
      canEdit={canEdit}
    />
  );
}
