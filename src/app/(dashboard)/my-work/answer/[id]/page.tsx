import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getBrandStatuses } from "@/lib/db/brand-statuses";
import { getSentToReviewBy } from "@/lib/handoff/queries";
import { getStatusSinceMany } from "@/lib/my-work/queries";
import { answersFor, parseAnswer, waited } from "@/lib/my-work/answer";
import { PostTypeTag } from "@/components/my-work/up-next";
import { AnswerCard } from "@/components/my-work/answer-card";

export const dynamic = "force-dynamic";

/**
 * Where the morning email's Approve / Already posted / Not this one links
 * land (rules in src/lib/my-work/answer.ts): the post, with the answer the
 * reviewer tapped already picked. Opening it changes nothing; the tap on
 * the page does.
 */
export default async function AnswerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ a?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id } = await params;
  const { a } = await searchParams;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      status: productionItems.status,
      postType: productionItems.postType,
      thumbnail: productionItems.thumbnail,
      updatedAt: productionItems.updatedAt,
    })
    .from(productionItems)
    .where(and(eq(productionItems.id, id), isNull(productionItems.deletedAt)))
    .limit(1);
  if (!item) notFound();

  const [statuses, sentToReviewBy, since] = await Promise.all([
    getBrandStatuses(item.brand),
    getSentToReviewBy(item.id),
    getStatusSinceMany([item.id]),
  ]);
  const answers = answersFor(item.status, new Set(statuses.map((s) => s.name)));
  const wait = waited(since.get(item.id) ?? item.updatedAt);
  const postUrl = `/${item.brand}/content/${item.id}`;

  return (
    <div className="max-w-md mx-auto space-y-4">
      <Link href="/my-work" className="text-xs text-muted-foreground hover:text-foreground">
        ← My Work
      </Link>
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex gap-3">
          {item.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.thumbnail} alt="" className="w-16 h-16 rounded object-cover shrink-0" />
          )}
          <div className="min-w-0">
            <Link href={postUrl} className="text-sm font-semibold text-foreground hover:underline">
              {item.title || "(Untitled)"}
            </Link>
            <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-1">
              <PostTypeTag postType={item.postType} />
              <span>{item.brand}</span>
              {item.status === "Review" && wait && <span>· waiting {wait}</span>}
            </div>
          </div>
        </div>

        {answers.length > 0 ? (
          <AnswerCard
            id={item.id}
            brand={item.brand}
            me={session.user.id}
            answers={answers}
            picked={parseAnswer(a)}
            sentToReviewBy={sentToReviewBy}
            postUrl={postUrl}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-answer-closed>
            Already answered: this post is {item.status ? <strong>{item.status}</strong> : "out of Review"} now.{" "}
            <Link href="/my-work" className="underline">
              See what else is waiting
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
