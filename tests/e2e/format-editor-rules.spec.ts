import { test, expect } from "@playwright/test";
import postgres from "postgres";
import type { Page } from "@playwright/test";

// A What's new card newer than the test user pops up over the page.
async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

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
    await dismissWhatsNew(page);
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

// The way in: the Formats list flags formats with rules not yet in the Skill
// ("2 edit rules"), and the chip opens the format page at the panel.
test("formats list flags formats with new editor rules", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const rules = {
      rules: ["Swap em dashes for a plain period.", "End on the takeaway, not a summary.", "Lead with the founder's name."],
      pairCount: 7,
      generatedAt: new Date().toISOString(),
      model: "e2e",
    };
    const name = `E2E List Rules ${stamp}`;
    // One rule is already in the Skill, so two are new.
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions, editor_rules)
      VALUES (${name}, 'starter-story', ${"## House rules\n- Lead with the founder's name."}, ${sql.json(rules)})
      RETURNING id`;
    await sql`
      INSERT INTO formats (name, brand, instructions)
      VALUES (${`E2E No Rules ${stamp}`}, 'starter-story', 'plain')`;

    await page.goto(`/starter-story/formats`);
    await dismissWhatsNew(page);
    const row = page.getByRole("row").filter({ hasText: name });
    const chip = row.getByTestId("format-editor-rules-chip");
    await expect(chip).toHaveText("2 edit rules");
    await expect(
      page.getByRole("row").filter({ hasText: `E2E No Rules ${stamp}` }).getByTestId("format-editor-rules-chip"),
    ).toHaveCount(0);

    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await chip.click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/formats/${format.id}#editor-rules$`));
    await expect(page.getByTestId("format-editor-rules")).toBeVisible();
  } finally {
    await sql.end();
  }
});
