import Link from "next/link";
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { contentComments, productionItems, users } from "@/lib/db/schema";
import { getMyWork, getRowNews } from "@/lib/my-work/queries";
import { ago, previewText, type RowNews } from "@/lib/my-work/news";
import { htmlToPlainText } from "@/lib/comments/sanitize";
import { cn } from "@/lib/utils";
import { statusClassWithPalette } from "@/lib/badge-colors";
import { getAllStatusPalettes } from "@/lib/db/brand-statuses";
import { rowActionsFor, type MyWorkSection } from "@/lib/my-work/actions";
import { RowActions } from "@/components/my-work/row-actions";
import { MyWorkKeys } from "@/components/my-work/my-work-keys";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function MyWorkPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // Your turn / to review / waiting on others — rules in src/lib/my-work/split.ts.
  const { yourTurn, toReview, waitingOnOthers } = await getMyWork(userId);
  const mineRows = [
    ...yourTurn,
    ...waitingOnOthers,
    ...toReview.filter((r) => r.editorUserId === userId),
  ];

  // Recent comments on my items, from someone other than me.
  const itemIds = mineRows.map((r) => r.id);
  const recentComments = itemIds.length
    ? await db
        .select({
          id: contentComments.id,
          contentItemId: contentComments.contentItemId,
          body: contentComments.body,
          createdAt: contentComments.createdAt,
          authorName: users.name,
          authorEmail: users.email,
          itemTitle: productionItems.title,
          itemBrand: productionItems.brand,
        })
        .from(contentComments)
        .leftJoin(users, eq(users.id, contentComments.userId))
        .leftJoin(
          productionItems,
          eq(productionItems.id, contentComments.contentItemId),
        )
        .where(
          and(
            inArray(contentComments.contentItemId, itemIds),
            or(
              ne(contentComments.userId, userId),
              sql`${contentComments.userId} IS NULL`,
            ),
            gt(
              contentComments.createdAt,
              new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            ),
          ),
        )
        .orderBy(desc(contentComments.createdAt))
        .limit(10)
    : [];

  // Whose post each review row is (first names only).
  const editorIds = [...new Set(toReview.map((r) => r.editorUserId).filter((x): x is string => !!x))];
  const editorNames = new Map(
    editorIds.length
      ? (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, editorIds))
        ).map((u) => [u.id, (u.name ?? "").split(" ")[0] || "—"])
      : [],
  );

  // What changed on each row since you last touched it (my-day M3).
  const news = await getRowNews(userId, [
    ...new Set([...mineRows, ...toReview].map((r) => r.id)),
  ]);

  // Per-brand color palettes; resolved server-side and threaded into the
  // Section client so each row's chip uses the brand's configured color.
  const palettes = await getAllStatusPalettes();

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold text-foreground">My Work</h1>
          {isFeatureEnabled("myWorkDigest", session.user) && (
            <Link href="/my-work/email" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              Morning email
            </Link>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Everything you&apos;re on the hook for, across every brand.
        </p>
        <MyWorkKeys />
      </div>

      <Section
        title="Your turn"
        subtitle="Assigned to you to edit, or ready for you to post."
        rows={yourTurn}
        section="your-turn"
        emptyText="Nothing in your queue. Nice."
        userId={userId}
        palettes={palettes}
        news={news}
      />

      {toReview.length > 0 && (
        <Section
          title="To review"
          subtitle="In Review on brands you've approved posts for this month. Oldest first."
          rows={toReview}
          section="to-review"
          emptyText="Nothing to review."
          userId={userId}
          palettes={palettes}
          news={news}
          editorNames={editorNames}
        />
      )}

      <Section
        title="Waiting on others"
        subtitle="Assigned to you, but the next step is someone else's (review, on hold, scheduled)."
        rows={waitingOnOthers}
        section="waiting"
        emptyText="Nothing here yet."
        userId={userId}
        palettes={palettes}
        news={news}
      />

      <div className="rounded-lg border border-border bg-card">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            Recent comments
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Last 30 days on items assigned to you.
          </p>
        </div>
        {recentComments.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No recent comments.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {recentComments.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/${c.itemBrand}/content/${c.contentItemId}`}
                  className="block px-4 py-2.5 hover:bg-accent/40 transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-muted-foreground truncate">
                      {c.authorName || c.authorEmail || "Someone"} on{" "}
                      <span className="text-foreground font-medium">
                        {c.itemTitle || "(Untitled)"}
                      </span>
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {c.createdAt.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-foreground line-clamp-2 mt-0.5">
                    {previewText(htmlToPlainText(c.body))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type Row = {
  id: string;
  title: string | null;
  brand: string;
  status: string | null;
  format: string | null;
  platform: string[] | null;
  publishedDate: string | null;
  thumbnail: string | null;
  editorUserId: string | null;
};

function Section({
  title,
  subtitle,
  rows,
  section,
  emptyText,
  userId,
  palettes,
  news,
  editorNames,
}: {
  title: string;
  subtitle: string;
  rows: Row[];
  section: MyWorkSection;
  emptyText: string;
  userId: string;
  palettes: ReadonlyMap<string, ReadonlyMap<string, string>>;
  news: ReadonlyMap<string, RowNews>;
  /** Set on To review: adds an Editor column. */
  editorNames?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {title}
            <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
              {rows.length}
            </span>
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-accent/40">
                <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Title
                </th>
                <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Brand
                </th>
                <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Format
                </th>
                {editorNames && (
                  <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                    Editor
                  </th>
                )}
                <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Status
                </th>
                {section !== "waiting" && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  data-my-work-row
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors data-[focused]:bg-accent/50 data-[focused]:outline data-[focused]:outline-1 data-[focused]:outline-primary/40"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/${r.brand}/content/${r.id}`}
                      className="text-foreground hover:text-primary hover:underline transition-colors"
                    >
                      {r.title || "(Untitled)"}
                    </Link>
                    {news.get(r.id) && <RowNewsLine news={news.get(r.id)!} />}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.brand}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.format || "—"}
                  </td>
                  {editorNames && (
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.editorUserId === userId
                        ? "You"
                        : (r.editorUserId && editorNames.get(r.editorUserId)) || "—"}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    {r.status ? (
                      <span
                        className={cn(
                          "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border",
                          statusClassWithPalette(r.status, palettes.get(r.brand))
                        )}
                      >
                        {r.status}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  {section !== "waiting" && (
                    <td className="px-3 py-2 text-right">
                      <RowActions
                        id={r.id}
                        brand={r.brand}
                        title={r.title || "(Untitled)"}
                        actions={rowActionsFor(section, r.status, palettes.get(r.brand))}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Under the row's title: sent back by whom, and the latest comment from someone else. */
function RowNewsLine({ news }: { news: RowNews }) {
  const { comment, sentBack, isNew } = news;
  return (
    <div data-my-work-news className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
      {isNew && (
        <span
          title="New since your last change"
          aria-label="New since your last change"
          className="size-1.5 rounded-full bg-primary shrink-0"
        />
      )}
      {sentBack && (
        <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400">
          Sent back by {sentBack.by} · {ago(sentBack.at)}
        </span>
      )}
      {comment && (
        <span className={cn("truncate max-w-[36rem]", isNew && "text-foreground")}>
          <span className="font-medium">{comment.author}:</span> {comment.text}
          <span className="text-muted-foreground"> · {ago(comment.at)}</span>
        </span>
      )}
    </div>
  );
}
