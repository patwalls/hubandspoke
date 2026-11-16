import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => {}) }));

import { enqueue } from "@/jobs/enqueue";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { createTestProductionItem, createTestUser } from "@/test/factories";
import {
  ASSIGNMENT_FOLD_WINDOW_MS,
  enqueueNotification,
} from "./notifications";

const enqueueMock = vi.mocked(enqueue);

async function setup() {
  const editor = await createTestUser({ passwordHash: "x" });
  const curator = await createTestUser({ passwordHash: "x" });
  const item = await createTestProductionItem({});
  return { editor, curator, item };
}

function mention(userId: string, itemId: string, actorId: string, fold: boolean) {
  return enqueueNotification({
    userId,
    kind: "mention",
    contentItemId: itemId,
    actorUserId: actorId,
    foldIntoRecentAssignment: fold,
    payload: { kind: "mention", title: "t", excerpt: "@Editor", authorName: "C" },
  });
}

function assign(userId: string, itemId: string, actorId: string) {
  return enqueueNotification({
    userId,
    kind: "assigned",
    contentItemId: itemId,
    actorUserId: actorId,
    payload: { kind: "assigned", title: "t" },
  });
}

describe("enqueueNotification — one email per assignment", () => {
  beforeEach(() => enqueueMock.mockClear());

  it("a bare @mention right after assigning lands in the bell but sends no second email", async () => {
    const { editor, curator, item } = await setup();
    await assign(editor.id, item.id, curator.id);
    await mention(editor.id, item.id, curator.id, true);

    expect(enqueueMock).toHaveBeenCalledTimes(1); // the assignment email only
    const rows = await db
      .select({ kind: notifications.kind })
      .from(notifications)
      .where(and(eq(notifications.userId, editor.id), eq(notifications.contentItemId, item.id)));
    expect(rows.map((r) => r.kind).sort()).toEqual(["assigned", "mention"]);
  });

  it("a mention that says something still emails", async () => {
    const { editor, curator, item } = await setup();
    await assign(editor.id, item.id, curator.id);
    await mention(editor.id, item.id, curator.id, false);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });

  it("a bare @mention with no recent assignment still emails", async () => {
    const { editor, curator, item } = await setup();
    await mention(editor.id, item.id, curator.id, true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("an assignment older than the window doesn't fold the ping", async () => {
    const { editor, curator, item } = await setup();
    await assign(editor.id, item.id, curator.id);
    await db
      .update(notifications)
      .set({ createdAt: new Date(Date.now() - ASSIGNMENT_FOLD_WINDOW_MS - 60_000) })
      .where(eq(notifications.userId, editor.id));
    await mention(editor.id, item.id, curator.id, true);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });

  it("an assignment on another post doesn't fold the ping", async () => {
    const { editor, curator, item } = await setup();
    const other = await createTestProductionItem({});
    await assign(editor.id, other.id, curator.id);
    await mention(editor.id, item.id, curator.id, true);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });
});

// The post page tells the assigner how the new editor heard (assigned-notice.ts),
// so the return value has to match what actually happened.
describe("enqueueNotification — reports how the person was told", () => {
  beforeEach(() => enqueueMock.mockClear());

  it("email when the person can sign in", async () => {
    const { editor, curator, item } = await setup();
    expect(await assign(editor.id, item.id, curator.id)).toBe("email");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("bell only when the person has no login yet", async () => {
    const { curator, item } = await setup();
    const contractor = await createTestUser({});
    expect(await assign(contractor.id, item.id, curator.id)).toBe("bell");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("none when you assign yourself", async () => {
    const { curator, item } = await setup();
    expect(await assign(curator.id, item.id, curator.id)).toBe("none");
  });

  it("bell for a bare @mention folded into a fresh assignment", async () => {
    const { editor, curator, item } = await setup();
    await assign(editor.id, item.id, curator.id);
    expect(await mention(editor.id, item.id, curator.id, true)).toBe("bell");
  });
});
