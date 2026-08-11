import { eq, gte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { descriptAgentCalls } from "@/lib/db/schema";
import { extractDescriptSection } from "@/lib/format-skill";

const BASE_URL = "https://descriptapi.com/v1";

/** Hard ceiling on Underlord calls per rolling 10-minute window across the
 *  whole app. Override via `UNDERLORD_RATE_LIMIT_PER_10MIN` env. Default 10
 *  caps worst-case burn around $35 (matches the spike that triggered this
 *  instrumentation); raise it deliberately when you genuinely need bursty
 *  workflows.
 *
 *  Why a global window rather than per-caller: the burn pattern we care
 *  about is "everything fires at once" (cross-post loop, threshold-sweep
 *  cascade). A per-caller limit lets a single misbehaving caller stay
 *  under its own ceiling while collectively the system blows out. */
const UNDERLORD_RATE_LIMIT_PER_10MIN = Number(
  process.env.UNDERLORD_RATE_LIMIT_PER_10MIN ?? "10",
);

export const DEFAULT_CLIP_PROMPT = [
  "Create a short-form clip from this long-form video.",
  "Pick a single standout moment — an insight, a reaction, or a key explanation.",
  "The clip should start on a natural beat and end on a punctuating thought.",
  "Aim for 30–60 seconds.",
].join(" ");

/**
 * Format `seconds` as HH:MM:SS for embedding in Underlord prompts. Mirrors
 * the format the agent path uses for its time-range step ("between 00:02:29
 * and 00:03:08"); used here so format-author placeholder substitution
 * matches.
 */
function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Substitute `{{...}}` placeholders inside a format-author-defined Underlord
 * prompt template. Unknown placeholders pass through (so a typo is visible
 * in the rendered prompt, not silently swallowed). All values are escaped
 * for the surrounding prompt context — quotes inside the hook get
 * backslash-escaped so the resulting prompt remains parseable.
 *
 * Supported placeholders:
 *   {{hook}}              — clip-idea hook text
 *   {{startTimestamp}}    — start time formatted HH:MM:SS
 *   {{endTimestamp}}      — end time formatted HH:MM:SS
 *   {{startSec}}          — start time as raw seconds
 *   {{endSec}}            — end time as raw seconds
 *   {{durationSec}}       — duration in seconds (rounded)
 *   {{compositionId}}     — composition UUID (precise-cut path; empty for
 *                           the agent path where the composition doesn't
 *                           exist yet)
 *   {{aspectRatio}}       — "9:16" or "16:9". Resolved from the format's
 *                           clip_aspect_ratio column with a post_type-based
 *                           fallback by `resolveClipAspectRatio`.
 *   {{quotables}}         — newline-separated quotables array from
 *                           clip_ideas.extras.quotables (X Quotables
 *                           format). Empty when the clip has no quotables.
 */
export function substituteFormatPrompt(
  template: string,
  vars: {
    hook: string;
    startSec?: number;
    endSec?: number;
    compositionId?: string;
    aspectRatio?: string;
    quotables?: string[];
  },
): string {
  const safeHook = vars.hook.replace(/"/g, '\\"');
  const start = vars.startSec ?? null;
  const end = vars.endSec ?? null;
  const duration =
    start !== null && end !== null ? Math.max(0, Math.round(end - start)) : null;
  const quotablesBlock =
    vars.quotables && vars.quotables.length > 0
      ? vars.quotables.map((q) => `- ${q}`).join("\n")
      : "";
  const replacements: Record<string, string> = {
    hook: safeHook,
    startTimestamp: start !== null ? formatTimestamp(start) : "",
    endTimestamp: end !== null ? formatTimestamp(end) : "",
    startSec: start !== null ? String(start) : "",
    endSec: end !== null ? String(end) : "",
    durationSec: duration !== null ? String(duration) : "",
    compositionId: vars.compositionId ?? "",
    aspectRatio: vars.aspectRatio ?? "",
    quotables: quotablesBlock,
  };
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(replacements, key)
      ? replacements[key]
      : match;
  });
}

/**
 * Build a layout-apply Underlord prompt for the precise-cut path: the
 * composition already exists (we just ffmpeg-trimmed bytes and Descript
 * imported them), and we want Underlord to apply the format's skill-defined
 * treatment in place. Underlord only sees the operational Descript section
 * of the Skill — the editorial sections (Hook / Clip guidance / Avoid)
 * are stripped via {@link extractDescriptSection} so the agent doesn't
 * get confused by guidance meant for Claude. Falls back to the whole
 * Skill when no `### Descript Clip & Pack Info` heading exists. Placeholder
 * substitution via {@link substituteFormatPrompt} runs after extraction.
 */
export function buildLayoutPackPrompt(args: {
  skill: string;
  compositionId: string;
  hookText: string;
  aspectRatio?: "9:16" | "16:9";
  quotables?: string[];
  /** Set when the composition was assembled by the precise-cut worker from an
   *  editor-chosen intro PLUS the body (clipIdeas.hookSegments). In that case
   *  the footage selection is already final, and the format Skill's "only clip
   *  out the section…" instruction would make Underlord re-clip and DELETE the
   *  prepended intro. This flag injects a hard no-trim override so Underlord
   *  only styles the composition (pack + hook + filler marking) and keeps all
   *  footage. */
  preserveAllFootage?: boolean;
}): string {
  const descriptOnly = extractDescriptSection(args.skill);
  const inner = substituteFormatPrompt(descriptOnly, {
    hook: args.hookText,
    compositionId: args.compositionId,
    aspectRatio: args.aspectRatio,
    quotables: args.quotables,
  });
  const orientationLine =
    args.aspectRatio === "16:9"
      ? `Apply the following format-specific instructions to the horizontal 16:9 composition with compositionId="${args.compositionId}":`
      : `Apply the following format-specific instructions to the composition with compositionId="${args.compositionId}":`;

  if (args.preserveAllFootage) {
    // The format Skill below still contains its "only clip out the section…"
    // selection instruction; we can't surgically strip it from free-form
    // Skill text, so we override it explicitly — first AND last, where models
    // weight instructions most.
    return [
      `CRITICAL — READ FIRST, THIS OVERRIDES ANYTHING BELOW THAT CONFLICTS:`,
      `This composition is ALREADY the exact, final clip the editor assembled — a prepended intro followed by the target section, precisely cut. The footage selection is DONE.`,
      `Do NOT clip, trim, shorten, re-clip, cut down, remove, or re-select ANY footage. Keep every second from the first frame to the last.`,
      `IGNORE any instruction below that says to "only clip out", "clip out the section", or otherwise select/extract a portion — re-clipping would DELETE the intro the editor added.`,
      `Your ONLY job: apply the layout pack (9:16 framing, hook-text track, captions) and mark filler words as ignored (strike-through, never delete). Do not shorten the clip.`,
      ``,
      orientationLine,
      "",
      inner,
      "",
      `Reminder: keep ALL footage — do NOT trim or re-clip. Only apply the layout pack, set the hook text, and mark fillers as ignored.`,
      ``,
      `Reply with the compositionId in the form compositionId="${args.compositionId}".`,
    ].join("\n");
  }

  return [
    orientationLine,
    "",
    inner,
    "",
    `Reply with the compositionId in the form compositionId="${args.compositionId}".`,
  ].join("\n");
}

function authHeader(account?: string | null): string {
  const token =
    account === "hubspot"
      ? process.env.DESCRIPT_API_TOKEN_HUBSPOT
      : process.env.DESCRIPT_API_TOKEN;
  if (!token)
    throw new Error(
      account === "hubspot" ? "DESCRIPT_API_TOKEN_HUBSPOT not set" : "DESCRIPT_API_TOKEN not set",
    );
  return `Bearer ${token}`;
}

interface ImportProjectUrlArgs {
  projectName: string;
  mediaUrl: string;
  account?: string | null;
}

interface ImportProjectResponse {
  job_id: string;
  drive_id?: string;
  project_id: string;
  project_url: string;
}

export async function createDescriptProjectFromUrl(
  args: ImportProjectUrlArgs
): Promise<ImportProjectResponse> {
  const mediaKey = "main";
  return postImportProjectMedia(
    {
      project_name: args.projectName,
      add_media: { [mediaKey]: { url: args.mediaUrl } },
      add_compositions: [
        { name: args.projectName, clips: [{ media: mediaKey }] },
      ],
    },
    args.account,
  );
}

interface AgentResponse {
  job_id: string;
  drive_id?: string;
  project_id: string;
  project_url: string;
}

interface DescriptJobResponse {
  job_id: string;
  job_state: string;
  result?: {
    status?: string;
    /** Present when `status === "error"` — e.g. "Import failed". */
    error_message?: string;
    project_changed?: boolean;
    agent_response?: string;
    // Populated on import/project_media jobs — one entry per composition
    // created by the import (precise-cut creates exactly one).
    created_compositions?: Array<{ id: string; name: string }>;
    // Populated on publish jobs.
    composition_id?: string;
    share_url?: string;
    download_url?: string;
    download_url_expires_at?: string;
  };
  project_url?: string;
  project_id?: string;
  stopped_at?: string;
}

/**
 * Render and "publish" a composition. Despite the name, this is Descript's
 * export endpoint — the response carries a `share_url` (a public viewer
 * link) and a 24h-signed `download_url` pointing at the rendered MP4 in
 * Descript's GCS export bucket. We download from there and archive to our
 * own S3 in the `descript-publish-and-archive` worker task.
 *
 * Asynchronous: returns a job id; callers poll via `fetchDescriptJob`.
 * Confirmed live: ~2 min per render for a typical short clip at 1080p.
 */
interface PublishCompositionArgs {
  projectId: string;
  compositionId: string;
  /** "Video" or "Audio". Defaults to Video. */
  mediaType?: "Video" | "Audio";
  /** Resolution string per Descript docs. Defaults to 1080p. */
  resolution?: "480p" | "720p" | "1080p" | "1440p" | "4K";
  /** "public" | "unlisted" | "drive" | "private". Defaults to unlisted. */
  accessLevel?: "public" | "unlisted" | "drive" | "private";
}

export async function publishDescriptComposition(
  args: PublishCompositionArgs & { account?: string | null },
): Promise<{ jobId: string }> {
  const res = await fetch(`${BASE_URL}/jobs/publish`, {
    method: "POST",
    headers: {
      Authorization: authHeader(args.account),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project_id: args.projectId,
      composition_id: args.compositionId,
      media_type: args.mediaType ?? "Video",
      resolution: args.resolution ?? "1080p",
      access_level: args.accessLevel ?? "unlisted",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    job_id?: string;
    message?: string;
    error?: string;
  };
  if (!res.ok || !json.job_id) {
    const msg = json.message || json.error || `HTTP ${res.status}`;
    throw new Error(`Descript publish failed: ${msg}`);
  }
  return { jobId: json.job_id };
}

/**
 * Detect download URLs that originated from Descript's publish endpoint.
 * Used by the publish-and-archive task to know which `production_item_media`
 * rows to delete on a re-sync (manually-uploaded media has a different
 * `source_url` and must be preserved).
 */
export const DESCRIPT_EXPORT_URL_PREFIX =
  "https://production-273614-media-export.storage.googleapis.com/";

export async function fetchDescriptJob(
  jobId: string,
  account?: string | null,
): Promise<DescriptJobResponse> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    headers: { Authorization: authHeader(account) },
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Descript job fetch failed: ${msg}`);
  }
  return json as DescriptJobResponse;
}

export function extractCompositionIdFromAgentResponse(
  agentResponse: string | undefined
): string | null {
  if (!agentResponse) return null;
  const m = agentResponse.match(/compositionId="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Duplicate an existing composition inside a Descript project. Implemented
 * as an agent prompt because Descript's REST API doesn't expose a direct
 * /compositions/duplicate endpoint — the agent path can do it. Returns the
 * standard {jobId, projectId, projectUrl} so callers can reuse the existing
 * `descript-clip-resolve` poller (it polls until job_state=stopped and
 * extracts the new compositionId from `agent_response`).
 *
 * Used by the "Full video in Descript" promote path: the pillar is uploaded
 * to Descript exactly once and cached on the pillar's descriptProjectId;
 * every subsequent clip from that pillar duplicates the source composition
 * so editors get a fresh canvas to trim manually without re-uploading.
 */
/**
 * Build an Underlord prompt that cuts a NEW composition from the project's
 * existing media at a specific time range, then applies cross-post-rules
 * (target aspect, caption shape, etc.). Used by the cross-post / repost
 * derivative-create task when the source has a transcript-anchored
 * segment in the pillar's project — we compute the [startSec, endSec]
 * locally via `findAnchorInWords` and tell Underlord "create a composition
 * between MM:SS and MM:SS, the time range is non-negotiable."
 *
 * Mirrors the timestamp-pinned pattern from
 * `buildDescriptPrompt` in `src/lib/services/promote-clip-idea.ts` (the
 * AI-clip path) but adds the Cross Post Rules block so Underlord knows
 * to re-aspect / re-frame for the target platform.
 *
 * When `crossPostRules` is null, the prompt is simply a pinned-range
 * composition create (same shape as the AI-clip path).
 */
export async function cutSegmentWithRules(args: {
  projectId: string;
  newCompositionName: string;
  startSec: number;
  endSec: number;
  crossPostRules: string | null;
  targetPostType: string;
  caller: string;
  productionItemId?: string | null;
  account?: string | null;
}): Promise<{
  jobId: string;
  projectUrl: string;
  projectId: string;
  prompt: string;
}> {
  const safeName = args.newCompositionName.replace(/"/g, '\\"');
  const start = formatTimestamp(args.startSec);
  const end = formatTimestamp(args.endSec);
  const duration = Math.max(0, Math.round(args.endSec - args.startSec));
  const promptParts: string[] = [
    "You are producing a clip from this project. Follow these instructions exactly and do not deviate.",
    "",
    `1. In the main composition, locate the transcript segment between ${start} and ${end} (duration ≈ ${duration}s). The time range is non-negotiable.`,
    `2. Create a NEW composition named "${safeName}" containing only that segment. Do not include footage outside this range. The start must land on the first spoken word inside the range; the end must land on the last spoken word inside the range. Do not modify the source composition.`,
  ];
  if (args.crossPostRules) {
    promptParts.push(
      "",
      `3. This new composition is a CROSS-POST. Target platform / postType: ${args.targetPostType}. Apply the cross-post rules below to the NEW composition only — adjust aspect ratio, framing, or layout as the rules require. Bullets about caption shape are for a separate pipeline and you can ignore them.`,
      "",
      "### Cross Post Rules",
      args.crossPostRules,
    );
  }
  promptParts.push(
    "",
    'If any instruction conflicts with another, prioritize #1 (exact time range). In the agent response, report what you did, including the new compositionId in the form compositionId="<uuid>".',
  );
  const prompt = promptParts.join("\n");
  const result = await invokeDescriptAgent({
    projectId: args.projectId,
    prompt,
    caller: args.caller,
    productionItemId: args.productionItemId ?? null,
    account: args.account,
  });
  return { ...result, prompt };
}

export async function duplicateDescriptComposition(args: {
  projectId: string;
  sourceCompositionId: string;
  newCompositionName: string;
  caller: string;
  productionItemId?: string | null;
  account?: string | null;
}): Promise<{ jobId: string; projectUrl: string; projectId: string; prompt: string }> {
  const safeName = args.newCompositionName.replace(/"/g, '\\"');
  const prompt = [
    "Duplicate the existing main composition in this project — the one with",
    `compositionId="${args.sourceCompositionId}".`,
    `Name the new composition "${safeName}".`,
    "Do not modify the source composition. Do not change any media, transcript,",
    "or timing. The duplicate should be byte-identical to the source except",
    "for the name. Reply with the new compositionId in the form",
    'compositionId="<uuid>".',
  ].join(" ");
  const result = await invokeDescriptAgent({
    projectId: args.projectId,
    prompt,
    caller: args.caller,
    productionItemId: args.productionItemId ?? null,
    account: args.account,
  });
  return { ...result, prompt };
}

/**
 * Hard global rate limit on Underlord calls. Reads `descript_agent_calls`
 * for the last 10 minutes and refuses if we're at the cap. Cheap query
 * (indexed on created_at), runs before every agent call.
 *
 * The check is best-effort consistency, not strict — two simultaneous
 * callers can race past the cap by 1. That's fine; the point is to stop
 * a runaway loop fast, not to enforce exact accounting.
 */
async function assertUnderlordBudget(caller: string): Promise<void> {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(descriptAgentCalls)
    .where(gte(descriptAgentCalls.createdAt, tenMinAgo));
  const recent = row?.count ?? 0;
  if (recent >= UNDERLORD_RATE_LIMIT_PER_10MIN) {
    throw new Error(
      `Underlord rate limit hit: ${recent} calls in the last 10 minutes (cap ${UNDERLORD_RATE_LIMIT_PER_10MIN}). Caller "${caller}" refused. Raise UNDERLORD_RATE_LIMIT_PER_10MIN if this is legitimate, or check descript_agent_calls for the runaway caller.`,
    );
  }
}

export async function invokeDescriptAgent(args: {
  projectId: string;
  prompt: string;
  /** Tag identifying the code path firing this call. Required so a future
   *  spike is one SQL query away from a culprit. Examples:
   *  "clip-idea-promote-agent", "clip-idea-promote-full-video",
   *  "legacy-descript-clip-out". */
  caller: string;
  /** Set when the call ties to a specific derivative production item. */
  productionItemId?: string | null;
  account?: string | null;
}): Promise<{ jobId: string; projectUrl: string; projectId: string }> {
  await assertUnderlordBudget(args.caller);

  // INSERT before the fetch so we have a row even if Descript times out
  // or the process crashes mid-call. The status flip below records the
  // outcome.
  const [logged] = await db
    .insert(descriptAgentCalls)
    .values({
      caller: args.caller,
      projectId: args.projectId,
      productionItemId: args.productionItemId ?? null,
      prompt: args.prompt,
      status: "started",
    })
    .returning({ id: descriptAgentCalls.id });

  try {
    const res = await fetch(`${BASE_URL}/jobs/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(args.account),
      },
      body: JSON.stringify({
        project_id: args.projectId,
        prompt: args.prompt,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      const msg =
        (json && (json.message || json.error)) || `HTTP ${res.status}`;
      throw new Error(`Descript agent failed: ${msg}`);
    }
    const body = json as AgentResponse;
    await db
      .update(descriptAgentCalls)
      .set({
        status: "ok",
        descriptJobId: body.job_id,
        completedAt: new Date(),
      })
      .where(eq(descriptAgentCalls.id, logged.id));
    return {
      jobId: body.job_id,
      projectUrl: body.project_url,
      projectId: body.project_id,
    };
  } catch (err) {
    await db
      .update(descriptAgentCalls)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(descriptAgentCalls.id, logged.id));
    throw err;
  }
}

// Descript's web editor routes a composition as
// https://web.descript.com/<projectId>/<5-char-prefix-of-compositionId>. The
// suffix is the first 5 hex chars of the composition UUID (hyphens stripped).
// Verified against live URLs: `f3854a2c-…` → `/f3854`, `78cba…` → `/78cba`.
export function buildDescriptCompositionUrl(
  projectId: string,
  compositionId: string,
): string {
  const slug = compositionId.replace(/-/g, "").slice(0, 5);
  return `https://web.descript.com/${projectId}/${slug}`;
}

async function postImportProjectMedia(
  body: Record<string, unknown>,
  account?: string | null,
): Promise<ImportProjectResponse> {
  const res = await fetch(`${BASE_URL}/jobs/import/project_media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(account),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
    console.error(
      `[descript] import failed status=${res.status} body=${JSON.stringify(json)} request_project_name=${typeof body.project_name === "string" ? body.project_name.length : "?"} chars`,
    );
    throw new Error(`Descript import failed: ${msg}`);
  }
  return json as ImportProjectResponse;
}

/**
 * Convert a Google Drive shared link into a direct-download URL.
 * Works for files shared "anyone with the link can view". Large files
 * (>100MB) may require OAuth-auth'd download and won't work this way.
 *
 * Supported input shapes:
 *   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
 *   https://drive.google.com/open?id=FILE_ID
 *   https://docs.google.com/uc?id=FILE_ID&export=download
 */
export function toGoogleDriveDirectUrl(input: string): string {
  const trimmed = input.trim();
  let id: string | null = null;

  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) id = fileMatch[1];
  if (!id) {
    const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) id = idMatch[1];
  }
  if (id) {
    return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return trimmed;
}
