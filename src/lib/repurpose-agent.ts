import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

/**
 * The capabilities this app can execute right now. Each maps to a
 * Claude tool below and to a branch in the caller (the clip-out API
 * route). Adding a capability = add a tool, add a variant here, and
 * handle it in the caller.
 */
export type RepurposeAction =
  | {
      kind: "descript_clip";
      descriptPrompt: string;
      compositionName: string;
    }
  | { kind: "no_action"; message: string };

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
];

const SYSTEM_PROMPT = `You are the repurpose dispatcher for a content production dashboard.

A user has a long-form pillar video with an existing Descript project. Each target format has a prompt we call its "skill" — a small markdown recipe describing how to make great content in that format. Skills typically use these headings:
  ## What this format is
  ## Why it works
  ## Clip guidance
  ## Avoid

Your job: read the target format's skill and turn it into a concrete directive for Descript's agent (which has transcript access and picks the actual moment).

Available capability:
- create_descript_clip: creates a new composition inside the pillar's existing Descript project. Pick this when the skill describes any kind of short-form clip, highlight, reel, or cut.

Rules:
1. If the skill describes a Descript clip action, call create_descript_clip exactly once.
   - descriptPrompt must be a single natural-language directive. Start with "Create a new composition named 'X' containing a clip from the main composition." Then describe the moment to pick (criteria from Clip guidance), the target length, and — if the skill has an Avoid section — a matching "Avoid …" clause.
   - Do NOT put timestamps (minutes, seconds, start/end) in descriptPrompt. Descript picks from its transcript.
   - compositionName: use the target format's name verbatim.
2. If the skill describes something we can't do yet (schedule a social post, generate an image, write a tweet, create an Asana task, etc.), do NOT call any tool. Respond with one short sentence naming what automation would be needed.
3. If the skill is empty, placeholder-only, or describes nothing actionable, do NOT call any tool. Respond with one short sentence telling the user to write a clip-style prompt on the format.

Be terse in any text response — the user sees it verbatim in a modal.`;

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
        descriptPrompt: string;
        compositionName: string;
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
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const message =
    textBlock && textBlock.type === "text"
      ? textBlock.text.trim()
      : "No automation available for this prompt yet.";
  return { kind: "no_action", message };
}
