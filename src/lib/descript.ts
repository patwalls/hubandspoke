const BASE_URL = "https://descriptapi.com/v1";

function authHeader(): string {
  const token = process.env.DESCRIPT_API_TOKEN;
  if (!token) throw new Error("DESCRIPT_API_TOKEN not set");
  return `Bearer ${token}`;
}

interface ImportProjectArgs {
  projectName: string;
  mediaUrl: string;
}

interface ImportProjectResponse {
  job_id: string;
  drive_id: string;
  project_id: string;
  project_url: string;
}

export async function createDescriptProjectFromUrl(
  args: ImportProjectArgs
): Promise<ImportProjectResponse> {
  const mediaKey = "main";
  const res = await fetch(`${BASE_URL}/jobs/import/project_media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify({
      project_name: args.projectName,
      add_media: {
        [mediaKey]: { url: args.mediaUrl },
      },
      add_compositions: [
        {
          name: args.projectName,
          clips: [{ media: mediaKey }],
        },
      ],
    }),
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
