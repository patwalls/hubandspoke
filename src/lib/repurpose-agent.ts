import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

/**
 * The capabilities this app can execute when the user clicks Repurpose on a
 * target format. Claude picks one of these tools based on the format's skill.
 *
 * - descript_clip: fires a Descript clip job and creates a Notion task.
 * - manual_task: creates a Notion task only; an editor does the work by hand
 *   in Canva / Figma / ChatGPT / wherever. Used for anything that isn't a
 *   short-form video clip, and for empty/placeholder skills (the editor brief
 *   tells Pat to write a real skill).
 */
export type RepurposeAction =
  | {
      kind: "descript_clip";
      descriptPrompt: string;
      compositionName: string;
    }
  | {
      kind: "manual_task";
      taskName: string;
      guidance: string;
    };

const tools: Anthropic.Tool[] = [
  {
    name: "create_descript_clip",
    description:
      "Create a short clip as a new composition inside the source video's existing Descript project. Use when the format's skill describes any short-form clip, highlight, reel, short, cut, or excerpt of the pillar video.",
    input_schema: {
      type: "object" as const,
      properties: {
        descriptPrompt: {
          type: "string",
          description:
            "Natural-language directive that will be sent verbatim to Descript's agent. It must: (1) start with \"Create a new composition named '<name>' containing a clip from the main composition.\", (2) describe WHAT moment to clip — the emotional beat, topic, quote character, or criteria drawn from the format's skill; (3) state a target length range (e.g. \"Target length 30–60 seconds.\"); (4) if the skill has an Avoid section, include a matching \"Avoid …\" clause. Do NOT pick timestamps — Descript has transcript access and will pick the moment itself.",
        },
        compositionName: {
          type: "string",
          description:
            "Name for the new Descript composition. Use the target format's name verbatim unless the format's skill says otherwise.",
        },
      },
      required: ["descriptPrompt", "compositionName"],
    },
  },
  {
    name: "create_manual_task",
    description:
      "Create a Notion task for an editor to do this format by hand. Use when the format's skill describes work done in another tool (Canva design, Figma, image editor, written post, playbook slides, etc.), when the skill is too ambiguous to automate, or when the skill is blank/placeholder. No tool is invoked — the `guidance` you provide is shown to the editor in the Notion task body.",
    input_schema: {
      type: "object" as const,
      properties: {
        taskName: {
          type: "string",
          description:
            "Name for the task / derivative. Use the target format's name verbatim unless the skill says otherwise.",
        },
        guidance: {
          type: "string",
          description:
            "Short editor brief (a few sentences to a short paragraph). Distill the skill into concrete, actionable guidance the editor can follow. If the skill is empty or placeholder, say so explicitly and tell the editor to ask Pat for a proper skill or to work from the format name and brand conventions.",
        },
      },
      required: ["taskName", "guidance"],
    },
  },
];

const SYSTEM_PROMPT = `You are the repurpose dispatcher for a content production dashboard.

A user has a long-form pillar video. Each target format has a prompt we call its "skill" — a small markdown recipe describing how to make great content in that format. Skills typically use these headings:
  ## What this format is
  ## Why it works
  ## Clip guidance
  ## Avoid
…but the skill can describe anything: a Canva slideshow, a playbook carousel, a written X post, a Figma design. Read it and decide what to do.

You have exactly two tools. You MUST call one of them — never respond with plain text.

1. create_descript_clip — short-form clip from the pillar video (reel, highlight, cut, excerpt, TikTok/Shorts). Pick this when the skill describes clipping a moment from the video.
   - descriptPrompt: single natural-language directive starting with "Create a new composition named 'X' containing a clip from the main composition." Then describe the moment to pick (criteria from Clip guidance), the target length, and — if the skill has an Avoid section — a matching "Avoid …" clause. Do NOT put timestamps (minutes, seconds, start/end) in descriptPrompt; Descript picks from its transcript.
   - compositionName: the target format's name verbatim.

2. create_manual_task — everything else: Canva designs, Figma, image carousels, written posts, playbook slides, anything where a human does the work in a different tool. Also use this when the skill is ambiguous, empty, or placeholder.
   - taskName: the target format's name verbatim.
   - guidance: short editor brief (a few sentences to a short paragraph). Distill the skill into concrete steps. If the skill is blank/placeholder, say so and tell the editor to ask Pat for a proper skill or to work from the format name and brand conventions.

Default to create_manual_task when in doubt. Only pick create_descript_clip if the skill clearly describes a short-form video clip.`;

export async function dispatchRepurpose(params: {
  itemTitle: string;
  targetFormatName: string;
  targetPrompt: string;
}): Promise<RepurposeAction> {
  const client = new Anthropic();

  const userMessage = [
    `Source pillar: "${params.itemTitle}"`,
    `Target format: ${params.targetFormatName}`,
    `Target format skill:`,
    `"""`,
    params.targetPrompt || "(no prompt configured on this format)",
    `"""`,
    ``,
    `Decide what to do. Call exactly one tool.`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: userMessage }],
  });

  for (const block of response.content) {
    if (block.type !== "tool_use") continue;

    if (block.name === "create_descript_clip") {
      const input = block.input as {
        descriptPrompt?: string;
        compositionName?: string;
      };
      if (
        typeof input.descriptPrompt === "string" &&
        input.descriptPrompt.trim().length > 0 &&
        typeof input.compositionName === "string" &&
        input.compositionName.trim().length > 0
      ) {
        return {
          kind: "descript_clip",
          descriptPrompt: input.descriptPrompt.trim(),
          compositionName: input.compositionName.trim(),
        };
      }
    }

    if (block.name === "create_manual_task") {
      const input = block.input as {
        taskName?: string;
        guidance?: string;
      };
      if (
        typeof input.taskName === "string" &&
        input.taskName.trim().length > 0 &&
        typeof input.guidance === "string" &&
        input.guidance.trim().length > 0
      ) {
        return {
          kind: "manual_task",
          taskName: input.taskName.trim(),
          guidance: input.guidance.trim(),
        };
      }
    }
  }

  // Defensive fallback: Claude ignored tool_choice or returned malformed args.
  // Never leave the caller without an action — a manual task with the format
  // name and any text Claude emitted is better than a dead end.
  const textBlock = response.content.find((b) => b.type === "text");
  const fallbackGuidance =
    textBlock && textBlock.type === "text" && textBlock.text.trim().length > 0
      ? textBlock.text.trim()
      : "The dispatcher couldn't read the format's skill. Ask Pat to rewrite it, or work from the format name and brand conventions.";
  return {
    kind: "manual_task",
    taskName: params.targetFormatName,
    guidance: fallbackGuidance,
  };
}
