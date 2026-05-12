const BASE_URL = "https://descriptapi.com/v1";

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
 */
export function substituteFormatPrompt(
  template: string,
  vars: {
    hook: string;
    startSec?: number;
    endSec?: number;
    compositionId?: string;
  },
): string {
  const safeHook = vars.hook.replace(/"/g, '\\"');
  const start = vars.startSec ?? null;
  const end = vars.endSec ?? null;
  const duration =
    start !== null && end !== null ? Math.max(0, Math.round(end - start)) : null;
  const replacements: Record<string, string> = {
    hook: safeHook,
    startTimestamp: start !== null ? formatTimestamp(start) : "",
    endTimestamp: end !== null ? formatTimestamp(end) : "",
    startSec: start !== null ? String(start) : "",
    endSec: end !== null ? String(end) : "",
    durationSec: duration !== null ? String(duration) : "",
    compositionId: vars.compositionId ?? "",
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
 * treatment in place. The skill text (`formats.instructions`) is
 * author-defined per-format and substituted via
 * {@link substituteFormatPrompt} before being wrapped with the
 * path-specific scaffolding.
 */
export function buildLayoutPackPrompt(args: {
  skill: string;
  compositionId: string;
  hookText: string;
}): string {
  const inner = substituteFormatPrompt(args.skill, {
    hook: args.hookText,
    compositionId: args.compositionId,
  });
  return [
    `Apply the following format-specific instructions to the composition with compositionId="${args.compositionId}":`,
    "",
    inner,
    "",
    `Reply with the compositionId in the form compositionId="${args.compositionId}".`,
  ].join("\n");
}

function authHeader(): string {
  const token = process.env.DESCRIPT_API_TOKEN;
  if (!token) throw new Error("DESCRIPT_API_TOKEN not set");
  return `Bearer ${token}`;
}

interface ImportProjectUrlArgs {
  projectName: string;
  mediaUrl: string;
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
  return postImportProjectMedia({
    project_name: args.projectName,
    add_media: { [mediaKey]: { url: args.mediaUrl } },
    add_compositions: [
      { name: args.projectName, clips: [{ media: mediaKey }] },
    ],
  });
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
  args: PublishCompositionArgs,
): Promise<{ jobId: string }> {
  const res = await fetch(`${BASE_URL}/jobs/publish`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
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
  jobId: string
): Promise<DescriptJobResponse> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    headers: { Authorization: authHeader() },
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
export async function duplicateDescriptComposition(args: {
  projectId: string;
  sourceCompositionId: string;
  newCompositionName: string;
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
  const result = await invokeDescriptAgent({ projectId: args.projectId, prompt });
  return { ...result, prompt };
}

export async function invokeDescriptAgent(args: {
  projectId: string;
  prompt: string;
}): Promise<{ jobId: string; projectUrl: string; projectId: string }> {
  const res = await fetch(`${BASE_URL}/jobs/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
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
  return {
    jobId: body.job_id,
    projectUrl: body.project_url,
    projectId: body.project_id,
  };
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
  body: Record<string, unknown>
): Promise<ImportProjectResponse> {
  const res = await fetch(`${BASE_URL}/jobs/import/project_media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
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
