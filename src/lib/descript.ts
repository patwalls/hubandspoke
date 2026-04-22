const BASE_URL = "https://descriptapi.com/v1";

export const DEFAULT_CLIP_PROMPT = [
  "Create a short-form clip from this long-form video.",
  "Pick a single standout moment — an insight, a reaction, or a key explanation.",
  "The clip should start on a natural beat and end on a punctuating thought.",
  "Aim for 30–60 seconds.",
].join(" ");

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
  upload_urls?: Record<string, { upload_url: string; asset_id?: string }>;
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

interface ImportProjectUploadArgs {
  projectName: string;
  contentType: string;
  fileSize: number;
}

/**
 * Request a signed upload URL from Descript for a file we'll PUT ourselves.
 * Returns the upload URL alongside the job id + project url; the job won't
 * finish until we complete the PUT, so the caller is responsible for both
 * the PUT and then polling /jobs/{jobId}. Used by the precise-cut flow where
 * we trim the source video with ffmpeg locally before handing bytes to
 * Descript.
 */
export async function createDescriptProjectWithUpload(
  args: ImportProjectUploadArgs
): Promise<{
  jobId: string;
  projectId: string;
  projectUrl: string;
  uploadUrl: string;
}> {
  const mediaKey = "main";
  const res = await postImportProjectMedia({
    project_name: args.projectName,
    add_media: {
      [mediaKey]: {
        content_type: args.contentType,
        file_size: args.fileSize,
      },
    },
    add_compositions: [
      { name: args.projectName, clips: [{ media: mediaKey }] },
    ],
  });
  const uploadUrl = res.upload_urls?.[mediaKey]?.upload_url;
  if (!uploadUrl) {
    throw new Error(
      `Descript import did not return an upload_url for key "${mediaKey}"`
    );
  }
  return {
    jobId: res.job_id,
    projectId: res.project_id,
    projectUrl: res.project_url,
    uploadUrl,
  };
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
    project_changed?: boolean;
    agent_response?: string;
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

export interface PublishCompositionArgs {
  projectId: string;
  compositionId: string;
  mediaType?: "Video" | "Audio";
  resolution?: string;
}

interface PublishJobResponse {
  job_id: string;
  drive_id?: string;
  project_id: string;
  project_url: string;
}

export async function publishComposition(
  args: PublishCompositionArgs
): Promise<{ jobId: string; projectUrl: string; projectId: string }> {
  const res = await fetch(`${BASE_URL}/jobs/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify({
      project_id: args.projectId,
      composition_id: args.compositionId,
      media_type: args.mediaType ?? "Video",
      resolution: args.resolution ?? "1080p",
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Descript publish failed: ${msg}`);
  }
  const body = json as PublishJobResponse;
  return {
    jobId: body.job_id,
    projectUrl: body.project_url,
    projectId: body.project_id,
  };
}

export interface PublishedProject {
  project_id: string;
  publish_type: string;
  privacy: string;
  download_url?: string;
  download_url_expires_at?: string;
  metadata?: {
    title?: string;
    published_at?: string;
    published_by?: string;
  };
  subtitles?: string;
}

export async function fetchPublishedProject(
  slug: string
): Promise<PublishedProject> {
  const res = await fetch(`${BASE_URL}/published_projects/${slug}`, {
    headers: { Authorization: authHeader() },
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Descript published_projects fetch failed: ${msg}`);
  }
  return json as PublishedProject;
}

// Descript publish jobs return a share_url like
// https://share.descript.com/view/85F9VPWTO8X — the last path segment is the
// slug we pass to /published_projects/{slug}.
export function extractShareSlug(shareUrl: string | undefined): string | null {
  if (!shareUrl) return null;
  const m = shareUrl.match(/\/view\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
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
