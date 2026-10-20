// Server-only, read-only Asana client for the newsletter drafter's promo
// lookup (the "MEDIA | Starter Story Promo Calendar" project). Uses the
// personal access token in ASANA_ACCESS_TOKEN; never writes to Asana.

const BASE_URL = "https://app.asana.com/api/1.0";

export class AsanaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function token(): string {
  const t = process.env.ASANA_ACCESS_TOKEN;
  if (!t) throw new AsanaError(503, "ASANA_ACCESS_TOKEN not set");
  return t;
}

async function asanaGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AsanaError(res.status, `Asana GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return ((await res.json()) as { data: T }).data;
}

export interface AsanaTaskSummary {
  gid: string;
  name: string;
  due_on: string | null;
  memberships?: Array<{ section?: { name: string } | null }>;
}

export interface AsanaTaskDetail {
  gid: string;
  name: string;
  due_on: string | null;
  notes: string;
  permalink_url: string;
}

export interface AsanaSubtask {
  gid: string;
  name: string;
  notes: string;
}

/** Project tasks that are incomplete or completed after `completedSince` (ISO). */
export async function listProjectTasks(projectGid: string, completedSince: string): Promise<AsanaTaskSummary[]> {
  return asanaGet<AsanaTaskSummary[]>(`/projects/${projectGid}/tasks`, {
    completed_since: completedSince,
    limit: "100",
    opt_fields: "name,due_on,memberships.section.name",
  });
}

export async function getTask(taskGid: string): Promise<AsanaTaskDetail> {
  return asanaGet<AsanaTaskDetail>(`/tasks/${taskGid}`, { opt_fields: "name,due_on,notes,permalink_url" });
}

export async function getSubtasks(taskGid: string): Promise<AsanaSubtask[]> {
  return asanaGet<AsanaSubtask[]>(`/tasks/${taskGid}/subtasks`, { opt_fields: "name,notes" });
}

/**
 * Parse an Asana form submission's description into question → answer.
 * Form tasks render as "Question:\nAnswer\n\nQuestion:\nAnswer…" and end
 * with a "———" separator + "This task was submitted through…" footer.
 * Structural parsing of the form layout, not content analysis.
 */
export function parseAsanaFormNotes(notes: string): Record<string, string> {
  const body = notes.split(/\n[—-]{5,}\n/)[0] ?? notes;
  const out: Record<string, string> = {};
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const qIdx = lines.findIndex((l) => l.trim().endsWith(":"));
    if (qIdx === -1) continue;
    const question = lines[qIdx].trim().replace(/:$/, "").trim();
    const answer = lines.slice(qIdx + 1).join("\n").trim();
    if (question && answer) out[question] = answer;
  }
  return out;
}
