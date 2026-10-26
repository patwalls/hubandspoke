import Link from "next/link";
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { contentComments, productionItems, users } from "@/lib/db/schema";
import { getMyWork, getRowNews, getStatusSinceMany } from "@/lib/my-work/queries";
import { sortByLongestWait, waitingFor } from "@/lib/my-work/waiting";
import { ago, previewText, type RowNews } from "@/lib/my-work/news";
import { htmlToPlainText } from "@/lib/comments/sanitize";
import { cn } from "@/lib/utils";
import { statusClassWithPalette } from "@/lib/badge-colors";
import { getAllStatusPalettes, getBrandStatuses } from "@/lib/db/brand-statuses";
import { rowActionsFor, withHandoff, type MyWorkSection } from "@/lib/my-work/actions";
import { pickHandoff, ASSIGNED, type Handoff, type HandoffPerson } from "@/lib/handoff/pick";
import { getBrandReviewers, getSentToReviewByMany } from "@/lib/handoff/queries";
import { RowActions } from "@/components/my-work/row-actions";
import { MyWorkKeys } from "@/components/my-work/my-work-keys";
import { MyWorkSelection, SelectAll, SelectRow } from "@/components/my-work/bulk-select";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function MyWorkPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // Your turn / to review / waiting on others — rules in src/lib/my-work/split.ts.
  const split = await getMyWork(userId);
  const { yourTurn, waitingOnOthers } = split;

  // How long each row has sat in its status (my-day M11): its latest
  // status_change, else its last edit. To review goes longest wait first.
  const statusSince = await getStatusSinceMany(
    [...yourTurn, ...split.toReview].map((r) => r.id),
  );
  for (const r of [...yourTurn, ...split.toReview]) {
    if (!statusSince.has(r.id) && r.updatedAt) statusSince.set(r.id, r.updatedAt);
  }
  const toReview = sortByLongestWait(split.toReview, statusSince);
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

  // Each brand's statuses in pipeline order, for the bulk "Move to" menu.
  const pageBrands = [...new Set([...mineRows, ...toReview].map((r) => r.brand))];
  const statusesByBrand = Object.fromEntries(
    await Promise.all(
      pageBrands.map(async (b) => [b, (await getBrandStatuses(b)).map((s) => s.name)] as const),
    ),
  );

  // Who each row's action hands it to (same rules as the content page's
  // handoff button): your Assigned rows → the brand's reviewer; To review
  // rows → back to whoever sent them.
  const actionRows = [...yourTurn.filter((r) => r.status === ASSIGNED), ...toReview];
  const reviewBrands = [...new Set(yourTurn.filter((r) => r.status === ASSIGNED).map((r) => r.brand))];
  const [reviewersByBrand, sentBy] = await Promise.all([
    Promise.all(reviewBrands.map(async (b) => [b, await getBrandReviewers(b)] as const)).then(
      (pairs) => new Map<string, HandoffPerson[]>(pairs),
    ),
    getSentToReviewByMany(toReview.map((r) => r.id)),
  ]);
  const handoffs = new Map<string, Handoff | null>(
    actionRows.map((r) => [
      r.id,
      pickHandoff({
        me: userId,
        status: r.status,
        editorUserId: r.editorUserId,
        brandStatuses: new Set(palettes.get(r.brand)?.keys() ?? []),
        reviewers: reviewersByBrand.get(r.brand) ?? [],
        sentToReviewBy: sentBy.get(r.id) ?? null,
      }),
    ]),
  );

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

      <MyWorkSelection statusesByBrand={statusesByBrand}>
      <Section
        title="Your turn"
        subtitle="Assigned to you to edit, or ready for you to post."
        rows={yourTurn}
        section="your-turn"
        emptyText="Nothing in your queue. Nice."
        userId={userId}
        palettes={palettes}
        news={news}
        handoffs={handoffs}
        waitingSince={statusSince}
      />

      {toReview.length > 0 && (
        <Section
          title="To review"
          subtitle="In Review on brands you've approved posts for this month. Longest wait first."
          rows={toReview}
          section="to-review"
          emptyText="Nothing to review."
          userId={userId}
          palettes={palettes}
          news={news}
          handoffs={handoffs}
          editorNames={editorNames}
          waitingSince={statusSince}
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
        handoffs={handoffs}
      />
      </MyWorkSelection>

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
  handoffs,
  editorNames,
  waitingSince,
}: {
  title: string;
  subtitle: string;
  rows: Row[];
  section: MyWorkSection;
  emptyText: string;
  userId: string;
  palettes: ReadonlyMap<string, ReadonlyMap<string, string>>;
  news: ReadonlyMap<string, RowNews>;
  handoffs: ReadonlyMap<string, Handoff | null>;
  /** Set on To review: adds an Editor column. */
  editorNames?: ReadonlyMap<string, string>;
  /** Set on Your turn / To review: adds a Waiting column (time in this status). */
  waitingSince?: ReadonlyMap<string, Date>;
}) {
  const now = new Date();
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
                <th className="w-9 pl-3 py-2">
                  <SelectAll rows={rows.map((r) => ({ id: r.id, brand: r.brand }))} label={title} />
                </th>
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
                {waitingSince && (
                  <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                    Waiting
                  </th>
                )}
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
                  <td className="w-9 pl-3 py-2">
                    <SelectRow id={r.id} brand={r.brand} title={r.title || "(Untitled)"} />
                  </td>
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
                  {waitingSince && (
                    <td className="px-3 py-2">
                      <WaitingCell since={waitingSince.get(r.id)} now={now} />
                    </td>
                  )}
                  {section !== "waiting" && (
                    <td className="px-3 py-2 text-right">
                      <RowActions
                        id={r.id}
                        brand={r.brand}
                        title={r.title || "(Untitled)"}
                        actions={withHandoff(
                          rowActionsFor(section, r.status, palettes.get(r.brand)),
                          handoffs.get(r.id) ?? null,
                        )}
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

/** "5h" / "3d" in this status; amber from 6 h, red from a day (rules in `waiting.ts`). */
function WaitingCell({ since, now }: { since: Date | undefined; now: Date }) {
  const w = waitingFor(since ?? null, now);
  if (!w) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      data-testid="my-work-waiting"
      data-tone={w.tone}
      title={`In this status since ${since!.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`}
      className={cn(
        "tabular-nums text-xs",
        w.tone === "fresh" && "text-muted-foreground",
        w.tone === "due" && "text-amber-600 dark:text-amber-400 font-medium",
        w.tone === "late" && "text-red-600 dark:text-red-400 font-medium",
      )}
    >
      {w.label}
    </span>
  );
}

/** Under the row's title: sent back or handed over by whom, and the latest comment from someone else. */
function RowNewsLine({ news }: { news: RowNews }) {
  const { comment, sentBack, handedBy, isNew } = news;
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
      {handedBy && (
        <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1 py-px text-[10px] font-medium text-primary">
          From {handedBy.by} · {ago(handedBy.at)}
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
