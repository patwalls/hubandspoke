import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  notifications,
  productionItems,
  users,
  type NotificationPayload,
} from "@/lib/db/schema";
import { MarkAllReadButton } from "./mark-all-read-button";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      payload: notifications.payload,
      contentItemId: notifications.contentItemId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      itemTitle: productionItems.title,
      itemBrand: productionItems.brand,
      actorUserId: notifications.actorUserId,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(notifications)
    .leftJoin(
      productionItems,
      eq(productionItems.id, notifications.contentItemId),
    )
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(200);

  const unread = rows.filter((r) => !r.readAt).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Notifications
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Assignments, comments, and other activity on content you&apos;re on.
          </p>
        </div>
        {unread > 0 && <MarkAllReadButton />}
      </div>

      <div className="rounded-lg border border-border bg-card">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <NotificationFullRow
                key={r.id}
                id={r.id}
                kind={r.kind}
                payload={r.payload as NotificationPayload}
                contentItemId={r.contentItemId}
                itemTitle={r.itemTitle}
                itemBrand={r.itemBrand}
                actorName={r.actorName}
                actorEmail={r.actorEmail}
                readAt={r.readAt}
                createdAt={r.createdAt}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NotificationFullRow(props: {
  id: string;
  kind: string;
  payload: NotificationPayload;
  contentItemId: string | null;
  itemTitle: string | null;
  itemBrand: string | null;
  actorName: string | null;
  actorEmail: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  const href =
    props.contentItemId && props.itemBrand
      ? `/${props.itemBrand}/content/${props.contentItemId}`
      : "#";
  const actor = props.actorName || props.actorEmail || "A teammate";
  const title = props.itemTitle || "(Untitled)";

  let headline: string;
  if (props.payload.kind === "assigned") {
    headline = `${actor} assigned you as ${props.payload.role}`;
  } else if (props.payload.kind === "comment") {
    headline = `${actor} commented`;
  } else if (props.payload.kind === "mention") {
    headline = `${actor} mentioned you`;
  } else {
    headline = "Update";
  }

  const excerpt =
    props.payload.kind === "comment" || props.payload.kind === "mention"
      ? props.payload.excerpt
      : null;

  return (
    <li
      className={
        props.readAt ? "bg-card" : "bg-primary/5 border-l-2 border-l-primary"
      }
    >
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3 hover:bg-accent/40 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground">{headline}</p>
          <p className="text-sm font-medium text-foreground mt-0.5">
            {title}
          </p>
          {excerpt && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-3">
              {excerpt}
            </p>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
          {props.createdAt.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </Link>
    </li>
  );
}
