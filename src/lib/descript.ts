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
