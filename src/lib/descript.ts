const BASE_URL = "https://descriptapi.com/v1";

function authHeader(): string {
  const token = process.env.DESCRIPT_API_TOKEN;
  if (!token) throw new Error("DESCRIPT_API_TOKEN not set");
  return `Bearer ${token}`;
}

interface ImportProjectUrlArgs {
  projectName: string;
  mediaUrl: string;
}

interface ImportProjectUploadArgs {
  projectName: string;
  fileName: string;
  contentType: string;
  fileSize: number;
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

export async function createDescriptProjectForUpload(
  args: ImportProjectUploadArgs
): Promise<{
  projectId: string;
  projectUrl: string;
  jobId: string;
  uploadUrl: string;
  mediaKey: string;
}> {
  const mediaKey = args.fileName;
  const result = await postImportProjectMedia({
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
  const uploadUrl = result.upload_urls?.[mediaKey]?.upload_url;
  if (!uploadUrl) {
    throw new Error("Descript did not return an upload URL");
  }
  return {
    projectId: result.project_id,
    projectUrl: result.project_url,
    jobId: result.job_id,
    uploadUrl,
    mediaKey,
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
