import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

/**
 * The set of real capabilities this app can execute. Each entry is also
 * defined as a Claude tool below. When adding a capability (Asana task,
 * social post, etc.), define its tool here and handle its result in the
 * caller.
 */
export type RepurposeAction =
  | {
      kind: "descript_clip";
      startSec: number;
      endSec: number;
      compositionName: string;
    }
  | { kind: "no_action"; message: string };

const tools: Anthropic.Tool[] = [
  {
    name: "create_descript_clip",
    description:
      "Create a short clip as a new composition inside the source video's existing Descript project. Use this when the user's prompt describes clipping, a highlight, a reel, a short-form cut, a TikTok/IG Reel/YT Short edit, or otherwise asks to extract a short segment from a longer video.",
    input_schema: {
      type: "object" as const,
      properties: {
        startSec: {
          type: "number",
          description:
            "Clip start time in seconds from the beginning of the main composition.",
        },
        endSec: {
          type: "number",
          description:
            "Clip end time in seconds. Must be greater than startSec.",
        },
        compositionName: {
          type: "string",
          description:
            "Name for the new Descript composition. Use the target format's name verbatim.",
        },
      },
      required: ["startSec", "endSec", "compositionName"],
    },
  },
];

const SYSTEM_PROMPT = `You are the repurpose dispatcher for a content production dashboard.

A user has a long-form video (the "pillar") and an existing Descript project for it. Each target format has a prompt describing how its clip/derivative should be produced. Your job: read the target format's prompt and decide whether it matches a capability this app can execute right now.

Available capability:
- create_descript_clip: creates a new composition inside the pillar's existing Descript project with a short clip window. Pick this when the prompt asks for any kind of short-form clip, highlight, reel, short, or cut derived from the pillar video.

Rules:
1. If the prompt describes a Descript-clip-style action, call create_descript_clip exactly once. For this MVP, pick a random 30-second window between 30 and 120 seconds into the source: startSec = a random integer in [30, 90], endSec = startSec + 30. For compositionName, use the provided target format name verbatim.
2. If the prompt describes something we can't do yet (e.g. "schedule a LinkedIn post", "generate a thumbnail image", "write a tweet", "create an Asana task"), do NOT call any tool. Respond with a single short sentence explaining what automation would be needed.
3. If the prompt is empty, ambiguous, or says nothing useful, do NOT call any tool. Respond with a single short sentence asking the user to add a clearer prompt on the format.

Be terse. The user sees your text response verbatim in a UI modal.`;

export async function dispatchRepurpose(params: {
  itemTitle: string;
  targetFormatName: string;
  targetPrompt: string;
}): Promise<RepurposeAction> {
  const client = new Anthropic();

  const userMessage = [
    `Source pillar: "${params.itemTitle}"`,
    `Target format: ${params.targetFormatName}`,
    `Target prompt:`,
    `"""`,
    params.targetPrompt || "(no prompt configured on this format)",
    `"""`,
    ``,
    `Decide what to do.`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages: [{ role: "user", content: userMessage }],
  });

  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "create_descript_clip") {
      const input = block.input as {
        startSec: number;
        endSec: number;
        compositionName: string;
      };
      if (
        typeof input.startSec === "number" &&
        typeof input.endSec === "number" &&
        typeof input.compositionName === "string" &&
        input.endSec > input.startSec
      ) {
        return {
          kind: "descript_clip",
          startSec: input.startSec,
          endSec: input.endSec,
          compositionName: input.compositionName,
        };
      }
    }
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const message =
    textBlock && textBlock.type === "text"
      ? textBlock.text.trim()
      : "No automation available for this prompt yet.";
  return { kind: "no_action", message };
}
