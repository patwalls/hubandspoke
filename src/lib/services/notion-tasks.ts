/**
 * Notion task creation service for Starter Story repurpose automation.
 *
 * Creates task pages in the SS Production Items Notion database
 * when content crosses view thresholds.
 *
 * All tasks are initially assigned to Evgeny (QC triage) with status "Idea".
 * Evgeny reviews the idea and reassigns to the correct editor.
 */

import { Client } from "@notionhq/client";

const DATABASE_ID = "8cb6cee4163d4282a5c87991ea689bde";

// Evgeny Timofeev — all SS tasks go to him first for QC triage
const EVGENY_NOTION_USER_ID = "19ed872b-594c-8153-b3dd-000224b2adfb";

function getNotionClient() {
  return new Client({ auth: process.env.NOTION_API_SECRET });
}

export interface CreateRepurposeTaskOpts {
  /** Title of the source content (pillar content) */
  pillarContentTitle: string;
  /** Name of the target format (e.g. "TMZ", "Reel → X") */
  targetFormatName: string;
  /** Channel name from the target format */
  channel?: string;
  /** Notion page ID of the source production item */
  pillarContentNotionId?: string;
  /** Notion page ID of the target format */
  targetFormatNotionPageId?: string;
  /** Notion user ID of the format's editor/creator (assigned to do the work) */
  editorNotionUserId?: string;
  /** Notion user ID of the format's producer (reviewer) */
  producerNotionUserId?: string;
}

export interface CreateRepurposeTaskResult {
  success: boolean;
  notionPageId?: string;
  error?: string;
}

export async function createNotionRepurposeTask(
  opts: CreateRepurposeTaskOpts
): Promise<CreateRepurposeTaskResult> {
  const notion = getNotionClient();

  // Title pattern: "{formatName} ({pillarContentTitle})"
  const taskTitle = `${opts.targetFormatName} (${opts.pillarContentTitle})`;

  try {
    // Build properties object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const properties: Record<string, any> = {
      // Title (Content property)
      Content: {
        title: [{ text: { content: taskTitle } }],
      },
      // Status — "Idea" for QC triage before assignment
      Status: {
        select: { name: "Idea" },
      },
      // Platform Repurpose — 0 initial value
      "Platform Repurpose": {
        number: 0,
      },
    };

    // Channel (multi_select) — from target format's channels
    if (opts.channel) {
      properties["Channel"] = {
        multi_select: [{ name: opts.channel }],
      };
    }

    // Pillar Content (relation) — link to source content page
    if (opts.pillarContentNotionId) {
      properties["Pillar Content"] = {
        relation: [{ id: opts.pillarContentNotionId }],
      };
    }

    // Format (relation) — link to format page
    if (opts.targetFormatNotionPageId) {
      properties["Format"] = {
        relation: [{ id: opts.targetFormatNotionPageId }],
      };
    }

    // Producer (people) — reviewer from the target format
    if (opts.producerNotionUserId) {
      properties["Producer"] = {
        people: [{ id: opts.producerNotionUserId }],
      };
    }

    // Editor/Creator (people) — always Evgeny for QC triage
    properties["Editor/Creator"] = {
      people: [{ id: EVGENY_NOTION_USER_ID }],
    };

    const page = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties,
    });

    return {
      success: true,
      notionPageId: page.id,
    };
  } catch (err) {
    console.error("Failed to create Notion repurpose task:", err);
    return {
      success: false,
      error: String(err),
    };
  }
}
