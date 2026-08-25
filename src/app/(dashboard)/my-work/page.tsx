import Link from "next/link";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { contentComments, productionItems, users } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { statusClassWithPalette } from "@/lib/badge-colors";
import { getAllStatusPalettes } from "@/lib/db/brand-statuses";

export const dynamic = "force-dynamic";

// Active editorial statuses — anything that needs an editor's attention.
const MY_TURN = ["Assigned", "Ready To Publish", "Review"];
const TERMINAL = ["Published", "Killed"];

export default async function MyWorkPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // All items assigned to the user (editor) and not in a terminal state.
  const mineRows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      status: productionItems.status,
      format: productionItems.format,
      platform: productionItems.platform,
      publishedDate: productionItems.publishedDate,
      thumbnail: productionItems.thumbnail,
      editorUserId: productionItems.editorUserId,
      updatedAt: productionItems.updatedAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.editorUserId, userId),
        sql`${productionItems.status} IS NULL OR ${productionItems.status} NOT IN (${sql.raw(TERMINAL.map((s) => `'${s}'`).join(","))})`,
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(desc(productionItems.updatedAt))
    .limit(200);

  const yourTurn = mineRows.filter(
    (r) => r.status !== null && MY_TURN.includes(r.status),
  );
  const yourTurnIds = new Set(yourTurn.map((r) => r.id));
  const waitingOnOthers = mineRows.filter((r) => !yourTurnIds.has(r.id));

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

  // Per-brand color palettes; resolved server-side and threaded into the
  // Section client so each row's chip uses the brand's configured color.
  const palettes = await getAllStatusPalettes();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">My Work</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Everything you&apos;re on the hook for, across every brand.
        </p>
      </div>

      <Section
        title="Your turn"
        subtitle="Content waiting on you right now."
        rows={yourTurn}
        emptyText="Nothing in your queue. Nice."
        userId={userId}
        palettes={palettes}
      />

      <Section
        title="Waiting on others"
        subtitle="Assigned to you, but the current stage is owned elsewhere (triage, ideation)."
        rows={waitingOnOthers}
        emptyText="Nothing here yet."
        userId={userId}
        palettes={palettes}
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
                    {c.body}
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
  emptyText,
  userId,
  palettes,
}: {
  title: string;
  subtitle: string;
  rows: Row[];
  emptyText: string;
  userId: string;
  palettes: ReadonlyMap<string, ReadonlyMap<string, string>>;
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
                <th className="px-3 py-2 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/${r.brand}/content/${r.id}`}
                      className="text-foreground hover:text-primary hover:underline transition-colors"
                    >
                      {r.title || "(Untitled)"}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.brand}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.format || "—"}
                  </td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
