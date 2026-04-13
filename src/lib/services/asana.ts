/**
 * Asana integration service for MATG repurpose task creation.
 *
 * When a pillar format (e.g. Business Interview) crosses its view threshold,
 * this service looks up its repurpose targets and creates one Asana task
 * per derivative format inside the MATG Content Tracker project.
 */

const ASANA_BASE = "https://app.asana.com/api/1.0";
const MATG_PROJECT_GID = "1214030213173859"; // MATG Content Tracker

function headers() {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error("ASANA_ACCESS_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/* ------------------------------------------------------------------ */
/*  Low-level helpers                                                  */
/* ------------------------------------------------------------------ */

export async function createAsanaTask(opts: {
  name: string;
  notes?: string;
  assigneeGid?: string | null;
  projectGid?: string;
}) {
  const taskData: Record<string, unknown> = {
    name: opts.name,
    notes: opts.notes || "",
    projects: [opts.projectGid || MATG_PROJECT_GID],
  };

  if (opts.assigneeGid) {
    taskData.assignee = opts.assigneeGid;
  }

  const res = await fetch(`${ASANA_BASE}/tasks`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ data: taskData }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana createTask failed (${res.status}): ${err}`);
  }

  const json = await res.json();
  return json.data; // { gid, name, ... }
}

/* ------------------------------------------------------------------ */
/*  High-level: trigger repurpose tasks for a format                   */
/* ------------------------------------------------------------------ */

import { db } from "@/lib/db";
import { formats, formatRepurposeMappings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface TriggerResult {
  sourceFormat: string;
  tasksCreated: { formatName: string; asanaGid: string; assignee?: string }[];
}

/**
 * Given a source format ID, look up its repurpose targets and create
 * one Asana task per target.  Returns a summary of what was created.
 */
export async function triggerRepurposeTasks(
  sourceFormatId: string,
  meta?: { videoTitle?: string; views?: number }
): Promise<TriggerResult> {
  // 1. Fetch the source format
  const [source] = await db
    .select()
    .from(formats)
    .where(eq(formats.id, sourceFormatId));

  if (!source) throw new Error(`Format ${sourceFormatId} not found`);

  // 2. Fetch repurpose mappings for this source
  const mappings = await db
    .select()
    .from(formatRepurposeMappings)
    .where(eq(formatRepurposeMappings.sourceFormatId, sourceFormatId));

  if (mappings.length === 0) {
    return { sourceFormat: source.name, tasksCreated: [] };
  }

  // 3. Fetch all target formats in one query
  const allFormats = await db.select().from(formats);
  const targetFormats = mappings
    .map((m) => allFormats.find((f) => f.id === m.targetFormatId))
    .filter(Boolean);

  // 4. Create one Asana task per target format
  const tasksCreated: TriggerResult["tasksCreated"] = [];

  for (const target of targetFormats) {
    if (!target) continue;

    const taskName = meta?.videoTitle
      ? `[Repurpose] ${target.name}: ${meta.videoTitle}`
      : `[Repurpose] ${target.name} from ${source.name}`;

    const notesSections = [
      `Source format: ${source.name}`,
      `Target format: ${target.name}`,
      target.channels?.length
        ? `Channel(s): ${(target.channels as string[]).join(", ")}`
        : null,
      target.contentOwner ? `Assigned to: ${target.contentOwner}` : null,
      meta?.videoTitle ? `Video: ${meta.videoTitle}` : null,
      meta?.views ? `Views at trigger: ${meta.views.toLocaleString()}` : null,
      source.viewThreshold
        ? `Threshold: ${source.viewThreshold.toLocaleString()}`
        : null,
    ].filter(Boolean);

    // Include format instructions if the target has them
    if (target.instructions) {
      notesSections.push("", "--- Format Instructions ---", target.instructions);
    }

    notesSections.push("", "Created automatically by Hub & Spoke");

    const notes = notesSections.join("\n");

    const task = await createAsanaTask({
      name: taskName,
      notes,
      assigneeGid: target.contentOwnerAsanaGid,
    });

    tasksCreated.push({
      formatName: target.name,
      asanaGid: task.gid,
      assignee: target.contentOwner || undefined,
    });
  }

  return { sourceFormat: source.name, tasksCreated };
}
