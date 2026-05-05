const BASE_URL = "https://descriptapi.com/v1";

export const DEFAULT_CLIP_PROMPT = [
  "Create a short-form clip from this long-form video.",
  "Pick a single standout moment — an insight, a reaction, or a key explanation.",
  "The clip should start on a natural beat and end on a punctuating thought.",
  "Aim for 30–60 seconds.",
].join(" ");

const DEFAULT_LAYOUT_PACK_NAME = "ReelsLayout";

/**
 * Name of the Descript layout pack the Underlord agent should apply to new
 * clip compositions (handles 9:16 framing, hook-text track, captions slot).
 *
 * Defaults to "ReelsLayout" — created manually in the team's Descript
 * workspace and verified against the API on 2026-05-05. Override via
 * `DESCRIPT_LAYOUT_PACK_NAME` env var; explicit empty string disables the
 * feature so the prompt falls back to the manual "9:16 aspect ratio"
 * instruction.
 */
export function getDescriptLayoutPackName(): string | null {
  const v = process.env.DESCRIPT_LAYOUT_PACK_NAME;
  if (v === undefined) return DEFAULT_LAYOUT_PACK_NAME;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a layout-pack-only Underlord prompt for re-applying a layout pack to
 * a composition that already exists (no new composition created). Used by
 * the precise-cut path: after ffmpeg trims locally and the trimmed bytes
 * import into Descript, this prompt asks Underlord to apply the layout pack
 * and ignore filler words on the just-imported composition.
 */
export function buildLayoutPackPrompt(args: {
  compositionId: string;
  layoutPackName: string;
}): string {
  const safeName = args.layoutPackName.replace(/"/g, '\\"');
  return [
    `Apply the layout pack named "${safeName}" to the composition with compositionId="${args.compositionId}". This pack handles vertical 9:16 framing, the hook-text track, and the captions slot.`,
    "",
    `Inside the composition, mark filler words ("um", "uh", "like" when used as filler, "you know", "I mean", false starts, repeated words, and long silences > 400ms) as IGNORED — use Descript's ignore / strike-through feature so the words remain visible in the script crossed out but are skipped during playback. DO NOT DELETE these words.`,
    "",
    `Do not add transitions, effects, music, or title cards. Do not re-order anything. Do not rewrite the transcript. Do not change the time range.`,
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
