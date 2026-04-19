/**
 * Notion task creation service for Starter Story repurpose automation.
 *
 * Creates task pages in the SS Production Items Notion database
 * when content crosses view thresholds.
 *
 * Editor/Creator comes from the target format's owner.
 * Producer is always Evgeny (QC triage). Status starts as "Idea".
 */

import { Client } from "@notionhq/client";

const DATABASE_ID = "8cb6cee4163d4282a5c87991ea689bde";

// Evgeny Timofeev — always the producer (QC triage) on auto-created tasks
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
  /** If set, the Descript project URL is appended to the page body so
   *  freelancers can find the clip the auto-repurpose flow produced. */
  descriptProjectUrl?: string;
  /** If set, Claude's editor brief is appended as a block in the page body
   *  so the editor knows what to make. Used for manual-task repurposes
   *  (Canva, Figma, written posts — anything that isn't a Descript clip). */
  guidanceMarkdown?: string;
  /** Override the default title. Defaults to "{formatName} ({pillarTitle})". */
  title?: string;
}

export interface CreateRepurposeTaskResult {
  success: boolean;
  notionPageId?: string;
  notionPageUrl?: string;
  error?: string;
}

export async function createNotionRepurposeTask(
  opts: CreateRepurposeTaskOpts
): Promise<CreateRepurposeTaskResult> {
  const notion = getNotionClient();

  // Title pattern: "{formatName} ({pillarContentTitle})"
  const taskTitle =
    opts.title || `${opts.targetFormatName} (${opts.pillarContentTitle})`;

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

    // Producer (people) — always Evgeny for QC triage
    properties["Producer"] = {
      people: [{ id: EVGENY_NOTION_USER_ID }],
    };

    // Editor/Creator (people) — format's editor/owner
    if (opts.editorNotionUserId) {
      properties["Editor/Creator"] = {
        people: [{ id: opts.editorNotionUserId }],
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const children: any[] = [];
    if (opts.guidanceMarkdown) {
      children.push(
        {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: "Editor brief" } }],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: opts.guidanceMarkdown } },
            ],
          },
        }
      );
    }
    if (opts.descriptProjectUrl) {
      children.push(
        {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: "Descript clip" } }],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "Open in Descript: ",
                },
              },
              {
                type: "text",
                text: {
                  content: opts.descriptProjectUrl,
                  link: { url: opts.descriptProjectUrl },
                },
              },
            ],
          },
        }
      );
    }

    const page = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties,
      ...(children.length ? { children } : {}),
    });

    const notionPageUrl =
      "url" in page && typeof page.url === "string" ? page.url : undefined;

    return {
      success: true,
      notionPageId: page.id,
      notionPageUrl,
    };
  } catch (err) {
    console.error("Failed to create Notion repurpose task:", err);
    return {
      success: false,
      error: String(err),
    };
  }
}
