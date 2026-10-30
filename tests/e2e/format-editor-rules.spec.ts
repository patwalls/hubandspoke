import { test, expect } from "@playwright/test";
import postgres from "postgres";

// drafts-learn M4: the format page shows the weekly job's "What editors keep
// changing" rules, and "Add to Skill" appends one under the house-rules
// heading (saved, survives a reload). The rules are seeded straight into
// formats.editor_rules — the job needs an LLM key the e2e box doesn't have.
test("format page shows editor rules and adds one to the Skill", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const rules = {
      rules: [
        "Open with the founder's name instead of \"He\" or \"She\".",
        "Put the second sentence of the hook on its own line.",
        "Cut filler words like \"just\" and \"basically\".",
      ],
      pairCount: 9,
      generatedAt: new Date().toISOString(),
      model: "e2e",
    };
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions, editor_rules)
      VALUES (${`E2E Rules ${stamp}`}, 'starter-story', ${"## What this format is\nA short clip with a hook."},
        ${sql.json(rules)})
      RETURNING id`;

    await page.goto(`/starter-story/formats/${format.id}`);
    const panel = page.getByTestId("format-editor-rules");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("What editors keep changing");
    await expect(panel).toContainText("From 9 recent rewrites");
    await expect(panel.getByRole("button", { name: "Add to Skill" })).toHaveCount(3);

    await panel.getByRole("button", { name: "Add to Skill" }).first().click();
    await expect(panel.getByText("In Skill")).toHaveCount(1);
    await expect(page.getByPlaceholder(/Teach Claude this format/)).toHaveValue(/## House rules \(from editor rewrites\)\n- Open with/);

    // Saved, not just local state.
    await expect
      .poll(async () => (await sql`SELECT instructions FROM formats WHERE id = ${format.id}`)[0].instructions)
      .toContain("- Open with the founder's name");

    await panel.scrollIntoViewIfNeeded();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await page.reload();
    await expect(page.getByTestId("format-editor-rules").getByText("In Skill")).toHaveCount(1);
  } finally {
    await sql.end();
  }
});
