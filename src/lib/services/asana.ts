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
import { formats, productionItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface TriggerResult {
  sourceFormat: string;
  tasksCreated: { formatName: string; asanaGid: string; assignee?: string }[];
}

/**
 * Look up an Asana workspace member by name and return their GID.
 * Uses fuzzy matching: checks if the Asana name contains the search name
 * or shares a last name (e.g. "Sam Walls" matches "Samantha Walls").
 */
async function findAsanaMemberGid(name: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${ASANA_BASE}/workspaces/1200382537239879/users?opt_fields=name,email`,
      { headers: headers() }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const members = json.data as Array<{ name: string; gid: string }>;

    const searchLower = name.toLowerCase();
    const searchParts = searchLower.split(/\s+/);
    const searchLast = searchParts[searchParts.length - 1];

    // Try exact match first
    const exact = members.find((m) => m.name.toLowerCase() === searchLower);
    if (exact) return exact.gid;

    // Try last name + first initial match (e.g. "Sam Walls" → "Samantha Walls")
    const fuzzy = members.find((m) => {
      const memberLower = m.name.toLowerCase();
      const memberParts = memberLower.split(/\s+/);
      const memberLast = memberParts[memberParts.length - 1];
      return (
        memberLast === searchLast &&
        searchParts[0] &&
        memberParts[0]?.startsWith(searchParts[0].charAt(0))
      );
    });
    if (fuzzy) return fuzzy.gid;

    // Try partial match — name contains search or vice versa
    const partial = members.find(
      (m) =>
        m.name.toLowerCase().includes(searchLower) ||
        searchLower.includes(m.name.toLowerCase())
    );
    return partial?.gid || null;
  } catch {
    return null;
  }
}

/**
 * Resolve an assignee GID: use stored GID if available,
 * otherwise look up by owner name in Asana workspace.
 */
async function resolveAssigneeGid(
  storedGid: string | null,
  ownerName: string | null
): Promise<string | null> {
  if (storedGid) return storedGid;
  if (!ownerName) return null;
  return findAsanaMemberGid(ownerName);
}

/**
 * Given a source format ID and production item ID, look up its repurpose targets
 * and create one Asana task per target. Task names follow the pattern:
 * "{sourceFormat} → {targetFormat} ({pillarContentTitle})"
 *
 * Returns a summary of what was created.
 */
export async function triggerRepurposeTasks(
  sourceFormatId: string,
  meta?: {
    videoTitle?: string;
    views?: number;
    contentLink?: string;
    sourceProductionItemId?: string;
  }
): Promise<TriggerResult> {
  // 1. Fetch the source format
  const [source] = await db
    .select()
    .from(formats)
    .where(eq(formats.id, sourceFormatId));

  if (!source) throw new Error(`Format ${sourceFormatId} not found`);

  // 2. Direct children of this source format are the repurpose targets.
  const targetFormats = await db
    .select()
    .from(formats)
    .where(eq(formats.parentFormatId, sourceFormatId));

  if (targetFormats.length === 0) {
    return { sourceFormat: source.name, tasksCreated: [] };
  }

  // 3. Load the source production item to get pillar content title
  let pillarTitle: string | null = null;
  if (meta?.sourceProductionItemId) {
    const [sourceItem] = await db
      .select({
        title: productionItems.title,
        pillarContentItemId: productionItems.pillarContentItemId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, meta.sourceProductionItemId))
      .limit(1);

    if (sourceItem && sourceItem.pillarContentItemId) {
      const [pillarItem] = await db
        .select({ title: productionItems.title })
        .from(productionItems)
        .where(eq(productionItems.id, sourceItem.pillarContentItemId))
        .limit(1);
      pillarTitle = pillarItem?.title ?? null;
    } else if (sourceItem) {
      // If no pillar, use the source item's title
      pillarTitle = sourceItem.title;
    }
  }

  // 4. Create one Asana task per target format
  const tasksCreated: TriggerResult["tasksCreated"] = [];

  const hubContentName = meta?.videoTitle || source.name;
  const viewsFormatted = meta?.views ? meta.views.toLocaleString() : "N/A";
  const contentLink = meta?.contentLink || "";

  for (const target of targetFormats) {
    if (!target) continue;

    // Construct task name: "{sourceFormat} → {targetFormat} ({pillarTitle})"
    // Falls back to old format if pillarTitle not available
    let taskName: string;
    if (pillarTitle) {
      taskName = `${source.name} → ${target.name} (${pillarTitle})`;
    } else {
      taskName = meta?.videoTitle
        ? `[Repurpose] ${target.name}: ${meta.videoTitle}`
        : `[Repurpose] ${target.name} from ${source.name}`;
    }

    const channels = (target.channels as string[])?.join(", ") || "N/A";
    const editorName = target.editor || "Unassigned";
    const producerName = target.producer || "Unassigned";

    // Build description with the template
    const noteLines = [
      contentLink
        ? `${hubContentName} just hit ${viewsFormatted} views! ${contentLink}`
        : `${hubContentName} just hit ${viewsFormatted} views!`,
      "",
      `• Task: Create ${target.name}`,
      `• Channel: ${channels}`,
      `• Editor: ${editorName}`,
      `• Producer: ${producerName}`,
    ];

    // Add content instructions from the format if they exist
    if (target.instructions) {
      noteLines.push("", "Content Instructions:", "", target.instructions);
    }

    const notes = noteLines.join("\n");

    // Resolve assignee — assign to editor (content creator) by default
    const assigneeGid = await resolveAssigneeGid(
      target.editorAsanaGid,
      target.editor
    );

    const task = await createAsanaTask({
      name: taskName,
      notes,
      assigneeGid,
    });

    tasksCreated.push({
      formatName: target.name,
      asanaGid: task.gid,
      assignee: target.editor || undefined,
    });
  }

  return { sourceFormat: source.name, tasksCreated };
}
