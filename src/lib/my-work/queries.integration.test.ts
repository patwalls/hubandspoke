import { describe, expect, it } from "vitest";
import { createTestProductionItem } from "@/test/factories";
import { getMyWork } from "./queries";

describe("getMyWork", () => {
  it("leaves Ideas out of the query, so they can't crowd real work past the limit", async () => {
    const idea = await createTestProductionItem({ status: "Idea", sourceType: "repurposed", publishedAt: null });
    const assigned = await createTestProductionItem({ status: "Assigned", publishedAt: null });
    const onHold = await createTestProductionItem({ status: "On Hold", publishedAt: null });

    const { yourTurn, waitingOnOthers } = await getMyWork(idea.editorUserId!);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    expect(ids(yourTurn)).toContain(assigned.id);
    expect(ids(waitingOnOthers)).toContain(onHold.id);
    expect([...ids(yourTurn), ...ids(waitingOnOthers)]).not.toContain(idea.id);
  });
});
