import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDesignPhoto, createTestProductionItem } from "@/test/factories";
import { enhanceSourceKey } from "@/lib/design-editor/enhance";
import { enhanceStatus } from "./enhance";

describe("enhanceStatus", () => {
  // The photo comes back with a presigned preview URL; signing needs creds, not a network.
  beforeAll(() => {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "vitest");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "vitest");
      vi.stubEnv("AWS_REGION", process.env.AWS_REGION ?? "us-east-1");
    }
  });
  const src = { kind: "s3" as const, bucket: null, key: "vitest/founder.jpg" };

  it("finds the enhanced copy of a picture, and keeps the blurred one separate", async () => {
    const item = await createTestProductionItem({});
    const row = await createTestDesignPhoto({ productionItemId: item.id, kind: "enhanced", sourceKey: enhanceSourceKey(src, false) });

    const plain = await enhanceStatus(item.id, src, false);
    expect(plain.state).toBe("done");
    expect(plain.state === "done" && plain.photo.id).toBe(row.id);
    // Same picture, blur not made yet → not done.
    expect((await enhanceStatus(item.id, src, true)).state).toBe("none");
  });

  it("ignores a cutout of the same picture", async () => {
    const item = await createTestProductionItem({});
    await createTestDesignPhoto({ productionItemId: item.id, kind: "cutout", sourceKey: enhanceSourceKey(src, false) });
    expect((await enhanceStatus(item.id, src, false)).state).toBe("none");
  });
});
