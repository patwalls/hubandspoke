/**
 * Mutations for /api/v1 (and the MCP write tools). Every function runs the
 * app's own route handler as the principal via `callInternal`, so the API
 * never has a second copy of the rules: brand permissions, the
 * Published-needs-a-link invariant, kill reasons, activity events, Notion
 * pushes and notifications all happen exactly as they do from the UI.
 * The caller must already have checked `requireScope(principal, "write")`.
 */
import { getAccountsForBrand } from "@/lib/db/accounts";
import { inferAccountFromUrl } from "@/lib/infer-post-type";
import { fetchPostMetadataFromUrl } from "@/lib/services/post-metadata";
import { recordScUsage } from "@/lib/services/sc-usage-log";
import { PUT as itemPut, POST as itemPost } from "@/app/api/production-items/route";
import { POST as publishPost } from "@/app/api/production-items/[id]/publish/route";
import { POST as commentPost } from "@/app/api/production-items/[id]/comments/route";
import { POST as triagePost } from "@/app/api/clip-ideas/[id]/triage/route";
import type { ApiPrincipal } from "./auth";
import { getContent, listClipIdeas, listComments, type ApiComment } from "./content";
import { ApiError } from "./http";
import { callInternal } from "./impersonate";
import type { ApiClipIdea, ApiContentItem } from "./serialize";

export interface UpdateContentInput {
  status?: string;
  editor_id?: string | null;
  title?: string;
  format?: string | null;
  hub_id?: string | null;
  kill_reason?: string;
  /** Required when status becomes Published. */
  url?: string;
  published_at?: string;
}

/**
 * Change an item. Status moves to Published go through the publish handler
 * (which needs `url`); every other field goes through the generic update.
 */
export async function updateContent(
  principal: ApiPrincipal,
  id: string,
  input: UpdateContentInput,
  baseUrl: string,
): Promise<ApiContentItem> {
  const wantsPublish = input.status?.toLowerCase() === "published";
  const generic: Record<string, unknown> = { id };
  if (input.title !== undefined) generic.title = input.title;
  if (input.format !== undefined) generic.format = input.format;
  if (input.editor_id !== undefined) generic.editorUserId = input.editor_id ?? null;
  if (input.hub_id !== undefined) generic.pillarContentItemId = input.hub_id ?? null;
  if (input.status !== undefined && !wantsPublish) {
    generic.status = input.status;
    if (input.kill_reason !== undefined) generic.killReason = input.kill_reason;
  }
  if (Object.keys(generic).length > 1) {
    await callInternal(principal, itemPut as never, { method: "PUT", path: "/api/production-items", body: generic });
  }
  if (wantsPublish) {
    if (!input.url) {
      throw new ApiError("invalid_request", "Moving to Published needs `url`: the live link of the post.");
    }
    await callInternal(principal, publishPost as never, {
      method: "POST",
      path: `/api/production-items/${id}/publish`,
      params: { id },
      body: {
        mode: "publish",
        link: input.url,
        ...(input.published_at ? { publishedDate: input.published_at.slice(0, 10) } : {}),
      },
    });
  }
  if (Object.keys(generic).length === 1 && !wantsPublish) {
    throw new ApiError("invalid_request", "Nothing to change. Send at least one of status, editor_id, title, format, hub_id.");
  }
  return getContent(id, baseUrl);
}

export async function addComment(
  principal: ApiPrincipal,
  id: string,
  input: { body: string; at_sec?: number | null },
): Promise<ApiComment> {
  const body = input.body?.trim();
  if (!body) throw new ApiError("invalid_request", "body is required.");
  // Plain text in, HTML in the app: escape and keep line breaks.
  const html = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const res = await callInternal<{ comment: { id: string } }>(principal, commentPost as never, {
    method: "POST",
    path: `/api/production-items/${id}/comments`,
    params: { id },
    body: { body: html, atSeconds: input.at_sec ?? null },
  });
  const all = await listComments(id);
  const mine = all.data.find((c) => c.id === res.comment.id);
  if (!mine) throw new ApiError("internal_error", "Comment was saved but could not be read back.");
  return mine;
}

export async function decideClipIdea(
  principal: ApiPrincipal,
  clipIdeaId: string,
  decision: { action: "accept"; editor_id?: string | null } | { action: "kill"; reason?: string | null },
): Promise<{ clip_idea: ApiClipIdea; new_content_id: string | null }> {
  let newContentId: string | null = null;
  if (decision.action === "accept") {
    const res = await callInternal<{ newProductionItemId: string }>(principal, triagePost as never, {
      method: "POST",
      path: `/api/clip-ideas/${clipIdeaId}/triage`,
      params: { id: clipIdeaId },
      body: { action: "assign", editorUserId: decision.editor_id ?? principal.user.id },
    });
    newContentId = res.newProductionItemId ?? null;
  } else {
    await callInternal(principal, triagePost as never, {
      method: "POST",
      path: `/api/clip-ideas/${clipIdeaId}/triage`,
      params: { id: clipIdeaId },
      body: { action: "kill", killReason: decision.reason ?? null },
    });
  }
  const idea = await findClipIdea(clipIdeaId);
  return { clip_idea: idea, new_content_id: newContentId };
}

async function findClipIdea(clipIdeaId: string): Promise<ApiClipIdea> {
  const { db } = await import("@/lib/db");
  const { clipIdeas } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select({ src: clipIdeas.sourceProductionItemId }).from(clipIdeas).where(eq(clipIdeas.id, clipIdeaId)).limit(1);
  if (!row) throw new ApiError("not_found", `No clip idea with id ${clipIdeaId}.`);
  const all = await listClipIdeas(row.src);
  const idea = all.data.find((c) => c.id === clipIdeaId);
  if (!idea) throw new ApiError("not_found", `No clip idea with id ${clipIdeaId}.`);
  return idea;
}

export interface CreateContentInput {
  url: string;
  brand: string;
  title?: string;
  format?: string;
  editor_id?: string;
}

/**
 * Add a live post by URL — the API twin of "Add from link". Looks the post up
 * on its platform (title, date, metrics, thumbnail), matches the account
 * under the brand, then creates the item exactly as the dialog would.
 */
export async function createContentFromLink(
  principal: ApiPrincipal,
  input: CreateContentInput,
  baseUrl: string,
): Promise<ApiContentItem> {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new ApiError("invalid_request", "url must be a full URL, e.g. https://www.youtube.com/watch?v=…");
  }
  if (!input.brand) throw new ApiError("invalid_request", "brand is required (a slug from GET /brands).");
  const accounts = await getAccountsForBrand(input.brand);
  const account = inferAccountFromUrl(url.toString(), accounts);
  const started = Date.now();
  const meta = await fetchPostMetadataFromUrl(url.toString());
  void recordScUsage({
    caller: "api-v1-create",
    accountId: account?.id ?? null,
    platform: meta.platform ?? null,
    credits: 1,
    ok: !meta.warning,
    notes: url.toString().slice(0, 500),
    durationMs: Date.now() - started,
  });
  const title = input.title?.trim() || meta.title;
  if (!title) {
    throw new ApiError(
      "invalid_request",
      meta.warning ? `Could not read that post (${meta.warning}). Pass a title.` : "Could not read a title from that post. Pass a title.",
    );
  }
  if (!meta.platform) throw new ApiError("invalid_request", "That URL is not a post on a platform we track.");
  const created = await callInternal<{ id: string }>(principal, itemPost as never, {
    method: "POST",
    path: "/api/production-items",
    body: {
      title,
      platform: [meta.platform],
      accountId: account?.id ?? null,
      postType: meta.postType,
      format: input.format,
      publishedLink: meta.normalizedUrl ?? url.toString(),
      publishedDate: meta.publishedDate ?? new Date().toISOString().slice(0, 10),
      publishedAt: meta.publishedAt ?? undefined,
      brand: input.brand,
      views: meta.views,
      likes: meta.likes,
      comments: meta.comments,
      thumbnail: meta.thumbnail,
      authorHandle: meta.authorHandle,
      editorUserId: input.editor_id,
    },
  });
  return getContent(created.id, baseUrl);
}
