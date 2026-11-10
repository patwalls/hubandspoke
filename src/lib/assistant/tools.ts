import type Anthropic from "@anthropic-ai/sdk";
import { listAccounts, listBrands, listFormats, listStatuses, listUsers } from "@/lib/api/catalog";
import { getContent, getTranscript, listComments, listContent, listDerivatives, renderTranscript, SOURCE_TYPES } from "@/lib/api/content";
import { searchTranscripts } from "@/lib/api/transcript-search";
import { ApiError } from "@/lib/api/http";
import { compact } from "@/lib/mcp/server";
import { getMyWork } from "@/lib/my-work/queries";
import { flattenVideos, getAcademyLibrary } from "@/lib/academy/queries";
import { rankPassages, searchFeatureDocs } from "@/lib/assistant/help-search";
import { getContentReportCached } from "@/lib/db/queries-cached";
import { getContentReport } from "@/lib/db/queries";
import { todayInclusiveOfUtc } from "@/lib/dates";
import type { CardBlock, ContentCard } from "@/lib/assistant/cards";
import { resolvePostTypes } from "@/lib/assistant/post-type-groups";

/**
 * The assistant's tools. READ-ONLY by design: help search (docs + Academy)
 * plus the same read functions behind /api/v1 and the MCP server
 * (src/lib/api/*), so answers match what the API returns. No write tools —
 * the assistant explains and looks things up; people make changes in the app.
 */

export interface AssistantToolContext {
  userId: string;
  baseUrl: string;
  /** Receives result cards to show under the answer (see cards.ts). */
  onCards?: (block: CardBlock) => void;
  /** Receives every search_content result, so the agent can show cards if the model doesn't. */
  onSearch?: (search: { sort: string; items: { id: string; views: number | null }[] }) => void;
}

/** Keep tool results small: a model reads them and they cost tokens. */
const MAX_RESULT_CHARS = 12_000;

const str = (description: string) => ({ type: "string" as const, description });
const uuid = str("Content item id (UUID) from search_content or my_work");

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_help",
    description:
      "Search Hub & Spoke's own help: Learning Center training videos (with their learn points, action items and guides) and the product's feature documentation. Use this FIRST for any 'how does X work' / 'how do I' / 'what does Y mean' question. Search again with different words if the first results don't answer it.",
    input_schema: { type: "object", properties: { query: str("Keywords, e.g. 'cross post queue' or 'ready to publish status'") }, required: ["query"] },
  },
  {
    name: "my_work",
    description: "What's on the signed-in person's plate right now: items where it's their turn, items waiting for their review, and items waiting on others.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_content",
    description:
      "Find content items (hub videos and the clips/posts made from them). Returns compact rows newest first. Filter by brand slug, post_type, status, format, source_type, text, or publish dates. One call covers several platforms: pass a group (short_form) or a comma list in post_type.",
    input_schema: {
      type: "object",
      properties: {
        brand: str("Brand slug from list_brands; omit for all brands"),
        post_type: str(
          "A post type (youtube_long, youtube_shorts, instagram_reel, instagram_post, x, tiktok, linkedin, threads, newsletter), a comma list of them, or a group: short_form = youtube_shorts + instagram_reel + tiktok; long_form = youtube_long; text = x + linkedin + threads",
        ),
        status: str("Workflow status, e.g. Published, Review, Ready to Publish, Scheduled"),
        format: str("Format name from list_formats"),
        source_type: { type: "string", enum: [...SOURCE_TYPES], description: "original = hub piece; repurposed = clip; cross_post / repost" },
        q: str("Search titles, hooks and post bodies"),
        published_after: str("ISO date, inclusive"),
        published_before: str("ISO date, inclusive"),
        sort: { type: "string", enum: ["published_at", "updated_at", "views"], description: "Always descending; default published_at" },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Default 10" },
      },
    },
  },
  {
    name: "content_totals",
    description:
      "Totals for a period — the SAME numbers as the dashboard: number of posts published, and the views / clicks / leads of content published in that date range (latest synced counts), broken down by account and by format. Use this for ANY 'how many views/posts did X get in <period>' question instead of adding up search_content rows.",
    input_schema: {
      type: "object",
      properties: {
        brand: str("Brand slug from list_brands, or 'all' for every brand"),
        start_date: str("YYYY-MM-DD, inclusive (e.g. 30 days ago for 'last 30 days')"),
        end_date: str("YYYY-MM-DD, inclusive; default today"),
        platform: str("Optional: youtube, instagram, x, tiktok, linkedin, threads, facebook, newsletter"),
        post_type: str("Optional post_type, e.g. youtube_shorts or instagram_reel"),
      },
      required: ["brand", "start_date"],
    },
  },
  {
    name: "show_content_cards",
    description:
      "Show content items as cards under your answer (thumbnail, linked title, platform, views, likes, date — straight from the database). Use this WHENEVER your answer lists posts (top posts, what's waiting, what we published): pass the ids in the order to show. Then write only a 1-2 sentence takeaway — don't repeat the list in text.",
    input_schema: {
      type: "object",
      properties: {
        heading: str("Short heading for the cards, e.g. 'Top short-form posts · Oct 7 – Nov 6'"),
        ids: { type: "array", items: { type: "string" }, maxItems: 10, description: "Content item ids, in display order (max 10)" },
      },
      required: ["ids"],
    },
  },
  { name: "get_content", description: "Full detail for one content item.", input_schema: { type: "object", properties: { id: uuid }, required: ["id"] } },
  {
    name: "get_transcript",
    description: "What was said in a video (plain text, may be truncated for long videos).",
    input_schema: { type: "object", properties: { id: uuid }, required: ["id"] },
  },
  { name: "list_derivatives", description: "The clips/posts made from a hub item.", input_schema: { type: "object", properties: { id: uuid }, required: ["id"] } },
  { name: "list_comments", description: "Comments on a content item.", input_schema: { type: "object", properties: { id: uuid }, required: ["id"] } },
  {
    name: "search_transcripts",
    description: "Find where something was said across video transcripts. Quotes force a phrase; -word excludes.",
    input_schema: { type: "object", properties: { q: str("Words or a quoted phrase"), brand: str("Brand slug; optional") }, required: ["q"] },
  },
  { name: "list_brands", description: "Brands (slug, name).", input_schema: { type: "object", properties: {} } },
  {
    name: "list_accounts",
    description: "Social accounts per brand.",
    input_schema: { type: "object", properties: { brand: str("Brand slug; optional"), platform: str("youtube, instagram, x, tiktok, linkedin, threads, newsletter; optional") } },
  },
  { name: "list_formats", description: "Content formats per brand.", input_schema: { type: "object", properties: { brand: str("Brand slug; optional") } } },
  { name: "list_statuses", description: "Workflow statuses (in order) per brand.", input_schema: { type: "object", properties: { brand: str("Brand slug; optional") } } },
  { name: "list_users", description: "People on the team (name, role).", input_schema: { type: "object", properties: {} } },
];

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const date = (v: unknown) => {
  const raw = s(v);
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new ApiError("invalid_request", `"${raw}" is not an ISO date.`);
  return d;
};
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function searchHelp(query: string, baseUrl: string) {
  const videos = flattenVideos(await getAcademyLibrary()).filter((v) => !v.comingSoon);
  const academy = rankPassages(
    videos.map((v) => ({
      v,
      title: v.title,
      text: [v.summary, ...v.learnPoints.map((p) => p.text), ...v.actionItems, v.notes ? strip(v.notes) : ""].join(" "),
    })),
    query,
    3,
  ).map(({ v }) => ({
    title: v.title,
    url: `${baseUrl}/learning-center/${v.slug}`,
    summary: v.summary,
    you_will_learn: v.learnPoints.map((p) => (p.time ? `${p.time} ${p.text}` : p.text)),
    action_items: v.actionItems,
    guide: v.notes ? strip(v.notes).slice(0, 2500) : null,
  }));
  return { academy_videos: academy, feature_docs: searchFeatureDocs(query, 5) };
}

const ymd = (v: unknown, fallback?: string) => {
  const raw = s(v) ?? fallback;
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ApiError("invalid_request", `Dates must be YYYY-MM-DD (got "${raw ?? ""}").`);
  return raw;
};

/** Sum a MetricData table ({ row: { period: n } }) per row and overall. */
function sumMetric(data: Record<string, Record<string, number>>) {
  const rows: Record<string, number> = {};
  let total = 0;
  for (const [row, periods] of Object.entries(data)) {
    const n = Object.values(periods).reduce((a, b) => a + (b || 0), 0);
    rows[row] = n;
    total += n;
  }
  return { total, rows };
}

/** Dashboard numbers for a period, via the dashboard's own report query. */
async function contentTotals(a: Args, ctx: AssistantToolContext) {
  const brand = s(a.brand) ?? "all";
  const startDate = ymd(a.start_date);
  const endDate = ymd(a.end_date, todayInclusiveOfUtc());
  const params = {
    brand,
    startDate,
    endDate,
    viewType: "monthly" as const,
    platform: "all",
    platformKey: s(a.platform) ?? "all",
    accountId: "all",
    postType: s(a.post_type) ?? "all",
    channels: "all",
    format: "all",
    source: "all",
    provenOnly: false,
    origin: "all",
    includeItems: false,
  };
  // Same (cached) query as the dashboard; outside the Next runtime (scripts,
  // tests) the cache isn't available, so run it directly.
  const report = await getContentReportCached(params).catch((err: unknown) => {
    if (err instanceof Error && err.message.includes("incrementalCache missing")) return getContentReport(params);
    throw err;
  });
  const posts = sumMetric(report.byPlatform.production);
  const views = sumMetric(report.byPlatform.views);
  const clicks = sumMetric(report.byPlatform.clicks);
  const leads = sumMetric(report.byPlatform.leads);
  const formatViews = sumMetric(report.byFormat.views);
  const formatPosts = sumMetric(report.byFormat.production);
  const top = (rows: Record<string, number>, n: number) =>
    Object.entries(rows)
      .filter(([, v]) => v > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, n);
  const fromDate = report.clampedStartDate ?? startDate;
  const byAccount = top(views.rows, 15).map(([account, v]) => ({ account, posts: posts.rows[account] ?? 0, views: v }));
  ctx.onCards?.({
    kind: "stats",
    stats: {
      label: [brand === "all" ? "All brands" : brand, s(a.platform), s(a.post_type)].filter(Boolean).join(" · "),
      range: `${fromDate} – ${endDate}`,
      totals: { posts: posts.total, views: views.total, clicks: clicks.total, leads: leads.total },
      breakdown: byAccount.slice(0, 5).map((r) => ({ name: r.account, posts: r.posts, views: r.views })),
    },
  });
  return {
    shown_to_user_as_stats_card: true,
    brand,
    start_date: fromDate,
    end_date: endDate,
    meaning: "Posts = items published in the range. Views/clicks/leads = latest synced totals of the content published in the range (same as the dashboard), not views earned during the range by older content.",
    totals: { posts: posts.total, views: views.total, clicks: clicks.total, leads: leads.total },
    by_account: byAccount,
    by_format: top(formatViews.rows, 10).map(([format, v]) => ({ format, posts: formatPosts.rows[format] ?? 0, views: v })),
  };
}

/** Resolve ids to real rows and show them as cards; tell the model what was shown. */
async function showContentCards(a: Args, ctx: AssistantToolContext) {
  const ids = (Array.isArray(a.ids) ? a.ids : []).filter((x): x is string => typeof x === "string").slice(0, 10);
  const rows = await Promise.all(ids.map((id) => getContent(id, ctx.baseUrl).catch(() => null)));
  const items: ContentCard[] = rows
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({
      id: r.id,
      title: r.title,
      app_url: r.app_url,
      post_type: r.post_type,
      account: r.account ? `@${r.account.handle}` : null,
      thumbnail_url: r.thumbnail_url,
      published_at: r.published_at,
      views: r.metrics.views,
      likes: r.metrics.likes,
    }));
  if (items.length > 0) ctx.onCards?.({ kind: "content", heading: s(a.heading) ?? null, items });
  return {
    shown: items.length,
    not_found: ids.length - items.length,
    items: items.map((i) => ({ id: i.id, title: i.title, views: i.views })),
    note: "These are now visible to the person as cards. Write only a short takeaway; don't list them again.",
  };
}

async function run(name: string, a: Args, ctx: AssistantToolContext): Promise<unknown> {
  const id = s(a.id) ?? "";
  switch (name) {
    case "search_help":
      return searchHelp(s(a.query) ?? "", ctx.baseUrl);
    case "my_work": {
      const work = await getMyWork(ctx.userId);
      const row = (r: { id: string; title: string | null; brand: string; status: string | null; format: string | null; postType: string | null }) => ({
        id: r.id,
        title: r.title,
        brand: r.brand,
        status: r.status,
        format: r.format,
        post_type: r.postType,
        app_url: `${ctx.baseUrl}/${r.brand}/content/${r.id}`,
      });
      return { your_turn: work.yourTurn.map(row), to_review: work.toReview.map(row), waiting_on_others: work.waitingOnOthers.map(row) };
    }
    case "search_content": {
      const sort = (s(a.sort) as "published_at" | "updated_at" | "views" | undefined) ?? undefined;
      const page = await listContent(
        {
          brand: s(a.brand),
          post_types: resolvePostTypes(a.post_type),
          status: s(a.status),
          format: s(a.format),
          source_type: s(a.source_type),
          q: s(a.q),
          published_after: date(a.published_after),
          published_before: date(a.published_before),
          sort,
          limit: Math.min(Number(a.limit) || 10, 25),
        },
        ctx.baseUrl,
      );
      const items = page.data.map(compact);
      ctx.onSearch?.({ sort: sort ?? "published_at", items: items.map((i) => ({ id: i.id, views: i.views })) });
      return { items, has_more: page.has_more };
    }
    case "content_totals":
      return contentTotals(a, ctx);
    case "show_content_cards":
      return showContentCards(a, ctx);
    case "get_content":
      return getContent(id, ctx.baseUrl);
    case "get_transcript":
      return renderTranscript(await getTranscript(id), "text").body;
    case "list_derivatives":
      return (await listDerivatives(id, ctx.baseUrl)).data.map(compact);
    case "list_comments":
      return (await listComments(id)).data;
    case "search_transcripts":
      return (await searchTranscripts({ q: s(a.q) ?? "", brand: s(a.brand), limit: 10 }, ctx.baseUrl)).data;
    case "list_brands":
      return (await listBrands()).data;
    case "list_accounts":
      return (await listAccounts({ brand: s(a.brand), platform: s(a.platform) })).data;
    case "list_formats":
      return (await listFormats({ brand: s(a.brand) })).data;
    case "list_statuses":
      return (await listStatuses({ brand: s(a.brand) })).data;
    case "list_users":
      return (await listUsers()).data;
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/** Runs one tool call; always returns text for the model (errors included). */
export async function runAssistantTool(name: string, args: Args, ctx: AssistantToolContext): Promise<{ text: string; ok: boolean }> {
  try {
    const value = await run(name, args ?? {}, ctx);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]` : text, ok: true };
  } catch (err) {
    const message = err instanceof ApiError ? `${err.type}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { text: `Error: ${message}`, ok: false };
  }
}

/** Short status line shown in the chat while a tool runs. */
export function toolStatus(name: string): string {
  switch (name) {
    case "search_help":
      return "Searching the help…";
    case "my_work":
      return "Checking your work…";
    case "get_transcript":
    case "search_transcripts":
      return "Reading transcripts…";
    case "content_totals":
      return "Adding up the numbers…";
    case "show_content_cards":
      return "Pulling up the posts…";
    default:
      return "Looking up your content…";
  }
}
