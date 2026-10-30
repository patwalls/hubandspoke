/**
 * Read model behind `/api/v1/content/**` and the matching MCP tools. Both
 * surfaces call these functions, so a filter or field added here shows up in
 * REST and MCP at once. Everything is read-only; nothing here writes.
 */
import { and, desc, eq, gte, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  accounts,
  clipIdeas,
  productionItemMedia,
  productionItems,
  transcripts,
  users,
} from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import { z } from "zod";
import { ApiError, decodeCursor, encodeCursor, zBool, zIsoDate, zLimit } from "./http";
import {
  serializeClipIdea,
  serializeContentItem,
  type ApiClipIdea,
  type ApiContentItem,
  type ContentJoin,
} from "./serialize";
import {
  contentTypeFor,
  toPlainText,
  toSrt,
  toVtt,
  type TranscriptFormat,
} from "./transcript-format";

import { CONTENT_SORTS, SOURCE_TYPES, type ContentSort } from "./constants";
export { CONTENT_SORTS, SOURCE_TYPES, type ContentSort };

/** Query-string schema for GET /content; the MCP search tool reuses the same filters. */
export const ContentListQuery = z.object({
  brand: z.string().max(60).optional(),
  account_id: z.uuid().optional(),
  post_type: z.string().max(40).optional(),
  status: z.string().max(60).optional(),
  format: z.string().max(120).optional(),
  source_type: z.enum(SOURCE_TYPES).optional(),
  hub_id: z.uuid().optional(),
  editor_id: z.uuid().optional(),
  q: z.string().max(200).optional(),
  published_after: zIsoDate.optional(),
  published_before: zIsoDate.optional(),
  updated_after: zIsoDate.optional(),
  has_transcript: zBool.optional(),
  sort: z.enum(CONTENT_SORTS).optional(),
  limit: zLimit(100, 25),
  cursor: z.string().max(400).optional(),
});

export interface ListContentParams {
  brand?: string;
  account_id?: string;
  post_type?: string;
  status?: string;
  format?: string;
  source_type?: string;
  hub_id?: string;
  editor_id?: string;
  q?: string;
  published_after?: Date;
  published_before?: Date;
  updated_after?: Date;
  has_transcript?: boolean;
  sort?: ContentSort;
  limit?: number;
  cursor?: string | null;
}

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

// The moment an item counts as published: precise timestamp when known, else
// the calendar day, else when the row was created (drafts, ideas).
const publishedSort = sql<Date>`coalesce(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz, ${productionItems.createdAt})`;

const hasTranscriptSql = sql<boolean>`(${transcripts.id} is not null)`;
const hasMediaSql = sql<boolean>`(${productionItems.mediaS3Key} is not null or exists (select 1 from ${productionItemMedia} m where m.production_item_id = ${productionItems.id}))`;

const editorUser = alias(users, "editor_user");

function baseSelect() {
  return db
    .select({
      item: productionItems,
      account: {
        id: accounts.id,
        platform: accounts.platform,
        handle: accounts.handle,
        displayName: accounts.displayName,
        url: accounts.url,
      },
      editor: { id: editorUser.id, name: editorUser.name, email: editorUser.email },
      hasTranscript: hasTranscriptSql,
      hasMedia: hasMediaSql,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .leftJoin(editorUser, eq(editorUser.id, productionItems.editorUserId))
    .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id));
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseSelect>["execute"]>>[number];

function toJoin(r: BaseRow): ContentJoin {
  return {
    item: r.item,
    account: r.account?.id ? r.account : null,
    editor: r.editor?.id ? r.editor : null,
    hasTranscript: Boolean(r.hasTranscript),
    hasMedia: Boolean(r.hasMedia),
  };
}

export async function listContent(
  params: ListContentParams,
  baseUrl: string,
): Promise<Page<ApiContentItem>> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const sort: ContentSort = params.sort ?? "published_at";
  const where: SQL[] = [isNull(productionItems.deletedAt)];

  if (params.brand && params.brand !== "all") where.push(eq(productionItems.brand, params.brand));
  if (params.account_id) where.push(eq(productionItems.accountId, params.account_id));
  if (params.post_type) where.push(eq(productionItems.postType, params.post_type));
  if (params.status) where.push(sql`lower(${productionItems.status}) = lower(${params.status})`);
  if (params.format) where.push(sql`lower(${productionItems.format}) = lower(${params.format})`);
  if (params.source_type) where.push(eq(productionItems.sourceType, params.source_type));
  if (params.hub_id) where.push(eq(productionItems.pillarContentItemId, params.hub_id));
  if (params.editor_id) where.push(eq(productionItems.editorUserId, params.editor_id));
  if (params.q) {
    const needle = `%${params.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      or(
        ilike(productionItems.title, needle),
        ilike(productionItems.hook, needle),
        ilike(productionItems.contentBody, needle),
      )!,
    );
  }
  // publishedSort is a raw expression, so Drizzle can't map a Date for it — bind ISO strings.
  if (params.published_after) {
    where.push(sql`${publishedSort} >= ${params.published_after.toISOString()}::timestamptz`);
  }
  if (params.published_before) {
    where.push(sql`${publishedSort} <= ${params.published_before.toISOString()}::timestamptz`);
  }
  if (params.updated_after) where.push(gte(productionItems.updatedAt, params.updated_after));
  if (params.has_transcript === true) where.push(sql`${transcripts.id} is not null`);
  if (params.has_transcript === false) where.push(sql`${transcripts.id} is null`);

  const sortExpr =
    sort === "updated_at"
      ? productionItems.updatedAt
      : sort === "views"
        ? sql<Date>`coalesce(${productionItems.views}, -1)`
        : publishedSort;

  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    if (sort === "views") {
      // For the views sort the cursor's `t` carries the view count as a string.
      where.push(
        sql`(coalesce(${productionItems.views}, -1), ${productionItems.id}) < (${Number(cursor.t)}::int, ${cursor.id}::uuid)`,
      );
    } else {
      where.push(sql`(${sortExpr}, ${productionItems.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`);
    }
  }

  const rows = await baseSelect()
    .where(and(...where))
    .orderBy(desc(sortExpr), desc(productionItems.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  let nextCursor: string | null = null;
  if (hasMore && last) {
    const item = last.item;
    const t =
      sort === "views"
        ? String(item.views ?? -1)
        : sort === "updated_at"
          ? item.updatedAt.toISOString()
          : (
              item.publishedAt ??
              (item.publishedDate ? new Date(`${item.publishedDate}T00:00:00Z`) : item.createdAt)
            ).toISOString();
    nextCursor = encodeCursor({ t, id: item.id });
  }

  return {
    data: page.map((r) => serializeContentItem(toJoin(r), baseUrl)),
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

async function loadItem(id: string): Promise<ContentJoin> {
  const [row] = await baseSelect()
    .where(and(eq(productionItems.id, id), isNull(productionItems.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No content item with id ${id}.`);
  return toJoin(row);
}

export async function getContent(id: string, baseUrl: string): Promise<ApiContentItem> {
  return serializeContentItem(await loadItem(id), baseUrl);
}

export interface ApiTranscript {
  content_id: string;
  source: string;
  language: string | null;
  duration_sec: number | null;
  word_count: number | null;
  text: string;
  segments: Array<{ start_sec: number; end_sec: number; text: string; speaker: string | null }>;
  speakers: Array<{ id: string; name: string | null }> | null;
  words: Array<{ word: string; start_sec: number; end_sec: number }> | null;
  fetched_at: string;
}

export async function getTranscript(
  id: string,
  opts: { includeWords?: boolean } = {},
): Promise<ApiTranscript> {
  await loadItem(id);
  const [row] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.productionItemId, id))
    .limit(1);
  if (!row) {
    throw new ApiError(
      "not_found",
      "This item has no transcript yet. Transcripts exist for video and audio posts once Whisper has run.",
    );
  }
  const speakerName = new Map<string, string | null>();
  for (const s of row.speakers ?? []) {
    const sp = s as { id?: string; name?: string | null; label?: string | null };
    if (sp.id) speakerName.set(sp.id, sp.name ?? sp.label ?? null);
  }
  return {
    content_id: id,
    source: row.source,
    language: row.language,
    duration_sec: row.durationSec === null ? null : Number(row.durationSec),
    word_count: row.wordCount,
    text: row.fullText,
    segments: row.segments.map((s) => ({
      start_sec: s.startSec,
      end_sec: s.endSec,
      text: s.text,
      speaker: s.speaker ?? (s.speakerId ? (speakerName.get(s.speakerId) ?? s.speakerId) : null),
    })),
    speakers: row.speakers
      ? (row.speakers as Array<{ id?: string; name?: string | null; label?: string | null }>).map((s) => ({
          id: s.id ?? "",
          name: s.name ?? s.label ?? null,
        }))
      : null,
    words: opts.includeWords
      ? (row.words ?? []).map((w) => ({ word: w.word, start_sec: w.startSec, end_sec: w.endSec }))
      : null,
    fetched_at: row.fetchedAt.toISOString(),
  };
}

/** The transcript rendered in a non-JSON format, with its content type. */
export function renderTranscript(
  t: ApiTranscript,
  format: Exclude<TranscriptFormat, "json">,
): { body: string; contentType: string } {
  const segs = t.segments.map((s) => ({
    startSec: s.start_sec,
    endSec: s.end_sec,
    text: s.text,
    speaker: s.speaker ?? undefined,
  }));
  const body = format === "vtt" ? toVtt(segs) : format === "srt" ? toSrt(segs) : toPlainText(segs);
  return { body, contentType: contentTypeFor(format) };
}

/** Everything made FROM this item: repurposed spokes, cross-posts and reposts. */
export async function listDerivatives(
  id: string,
  baseUrl: string,
  limit = 100,
): Promise<{ data: ApiContentItem[] }> {
  await loadItem(id);
  const rows = await baseSelect()
    .where(
      and(
        isNull(productionItems.deletedAt),
        or(eq(productionItems.pillarContentItemId, id), eq(productionItems.repostedFromItemId, id)),
      ),
    )
    .orderBy(desc(publishedSort), desc(productionItems.id))
    .limit(Math.min(limit, 500));
  return { data: rows.map((r) => serializeContentItem(toJoin(r), baseUrl)) };
}

export async function listClipIdeas(
  id: string,
  opts: { status?: string } = {},
): Promise<{ data: ApiClipIdea[] }> {
  await loadItem(id);
  const where: SQL[] = [eq(clipIdeas.sourceProductionItemId, id)];
  if (opts.status) where.push(eq(clipIdeas.status, opts.status));
  const rows = await db
    .select()
    .from(clipIdeas)
    .where(and(...where))
    .orderBy(desc(clipIdeas.createdAt))
    .limit(500);
  return { data: rows.map(serializeClipIdea) };
}

export interface ApiMediaFile {
  kind: string;
  content_type: string | null;
  size_bytes: number | null;
  /** Time-limited download URL (15 minutes) for files we store; permanent for external links. */
  url: string | null;
  expires_at: string | null;
  error?: string;
}

const MEDIA_TTL_SEC = 900;

async function presign(key: string, bucket: string | null): Promise<Pick<ApiMediaFile, "url" | "expires_at" | "error">> {
  try {
    const url = await getPresignedGetUrl(key, MEDIA_TTL_SEC, bucket ? { bucket } : undefined);
    return { url, expires_at: new Date(Date.now() + MEDIA_TTL_SEC * 1000).toISOString() };
  } catch (err) {
    return { url: null, expires_at: null, error: err instanceof Error ? err.message : "presign failed" };
  }
}

/** Downloadable files for an item: the archived video/image, its poster, carousel slides, external media. */
export async function listMedia(id: string): Promise<{ data: ApiMediaFile[] }> {
  const { item } = await loadItem(id);
  const out: ApiMediaFile[] = [];
  if (item.mediaS3Key) {
    out.push({
      kind: "primary",
      content_type: item.mediaContentType,
      size_bytes: item.mediaSizeBytes,
      ...(await presign(item.mediaS3Key, item.mediaS3Bucket)),
    });
  }
  if (item.posterS3Key) {
    out.push({
      kind: "poster",
      content_type: "image/jpeg",
      size_bytes: null,
      ...(await presign(item.posterS3Key, item.mediaS3Bucket)),
    });
  }
  const rows = await db
    .select()
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, id))
    .orderBy(productionItemMedia.index);
  for (const m of rows) {
    out.push({
      kind: m.kind,
      content_type: m.contentType,
      size_bytes: m.sizeBytes,
      ...(await presign(m.s3Key, m.s3Bucket)),
    });
  }
  if (item.contentMediaUrl) {
    out.push({ kind: "external", content_type: null, size_bytes: null, url: item.contentMediaUrl, expires_at: null });
  }
  if (item.thumbnail) {
    out.push({ kind: "thumbnail", content_type: null, size_bytes: null, url: item.thumbnail, expires_at: null });
  }
  return { data: out };
}
