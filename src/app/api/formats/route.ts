import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formats, productionItems } from "@/lib/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  getChannelsForFormats,
  setFormatChannels,
  type FormatChannelInput,
} from "@/lib/format-channels";

async function isAncestor(candidateAncestorId: string, descendantId: string): Promise<boolean> {
  // Walk up from candidateAncestorId. Return true if we reach descendantId.
  let cursor: string | null = candidateAncestorId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === descendantId) return true;
    if (seen.has(cursor)) return false; // safety — shouldn't happen with clean data
    seen.add(cursor);
    const [row] = await db
      .select({ parentFormatId: formats.parentFormatId })
      .from(formats)
      .where(eq(formats.id, cursor));
    cursor = row?.parentFormatId ?? null;
  }
  return false;
}

export async function GET(request: NextRequest) {
  try {
    const brand =
      request.nextUrl.searchParams.get("brand") || "starter-story";
    const allFormats = await db
      .select()
      .from(formats)
      .where(eq(formats.brand, brand))
      .orderBy(formats.name);

    // Sum views for every format name that appears on a production_item, in one
    // scan. Then roll each format's total up through its descendants so a pillar
    // row reflects its whole repurpose chain.
    const viewsRows = await db
      .select({
        format: productionItems.format,
        total: sql<string>`COALESCE(SUM(${productionItems.views}), 0)`,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, brand),
          isNotNull(productionItems.format)
        )
      )
      .groupBy(productionItems.format);

    const viewsByName = new Map<string, number>();
    for (const r of viewsRows) {
      if (r.format) viewsByName.set(r.format, Number(r.total) || 0);
    }

    const childrenByParent = new Map<string, string[]>();
    for (const f of allFormats) {
      if (f.parentFormatId) {
        const arr = childrenByParent.get(f.parentFormatId) ?? [];
        arr.push(f.id);
        childrenByParent.set(f.parentFormatId, arr);
      }
    }
    const byId = new Map(allFormats.map((f) => [f.id, f]));
    const rollup = new Map<string, number>();
    const rollupFor = (id: string): number => {
      const cached = rollup.get(id);
      if (cached !== undefined) return cached;
      const f = byId.get(id);
      if (!f) return 0;
      let total = viewsByName.get(f.name) ?? 0;
      for (const childId of childrenByParent.get(id) ?? []) {
        total += rollupFor(childId);
      }
      rollup.set(id, total);
      return total;
    };

    const channelsByFormat = await getChannelsForFormats(allFormats.map((f) => f.id));

    const enriched = allFormats.map((f) => ({
      ...f,
      totalViews: rollupFor(f.id),
      accountChannels: channelsByFormat.get(f.id) ?? [],
    }));

    return NextResponse.json(enriched);
  } catch (error) {
    console.error("Error fetching formats:", error);
    return NextResponse.json(
      { error: "Failed to fetch formats" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      accountChannels,
      brand,
      viewThreshold,
      editor,
      editorAsanaGid,
      producer,
      producerAsanaGid,
      instructions,
      parentFormatId,
    } = body as {
      name: string;
      accountChannels?: FormatChannelInput[];
      brand?: string;
      viewThreshold?: number | null;
      editor?: string | null;
      editorAsanaGid?: string | null;
      producer?: string | null;
      producerAsanaGid?: string | null;
      instructions?: string | null;
      parentFormatId?: string | null;
    };

    const resolvedBrand = brand || "starter-story";

    if (parentFormatId) {
      const [parent] = await db
        .select({ brand: formats.brand })
        .from(formats)
        .where(eq(formats.id, parentFormatId));
      if (!parent) {
        return NextResponse.json({ error: "Parent format not found" }, { status: 400 });
      }
      if (parent.brand !== resolvedBrand) {
        return NextResponse.json({ error: "Parent format must be in the same brand" }, { status: 400 });
      }
    }

    const [created] = await db
      .insert(formats)
      .values({
        name,
        brand: resolvedBrand,
        // Mirror written by setFormatChannels below; create with empty default
        // so the row is valid before the channels write lands.
        channels: [],
        viewThreshold: viewThreshold || null,
        editor: editor || null,
        editorAsanaGid: editorAsanaGid || null,
        producer: producer || null,
        producerAsanaGid: producerAsanaGid || null,
        instructions: instructions || null,
        parentFormatId: parentFormatId || null,
      })
      .returning();

    if (accountChannels && accountChannels.length) {
      await setFormatChannels(created.id, accountChannels);
    }

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Error creating format:", error);
    return NextResponse.json(
      { error: "Failed to create format" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      id,
      name,
      accountChannels,
      viewThreshold,
      editor,
      editorAsanaGid,
      producer,
      producerAsanaGid,
      instructions,
      parentFormatId,
    } = body as {
      id: string;
      name: string;
      accountChannels?: FormatChannelInput[];
      viewThreshold?: number | null;
      editor?: string | null;
      editorAsanaGid?: string | null;
      producer?: string | null;
      producerAsanaGid?: string | null;
      instructions?: string | null;
      parentFormatId?: string | null;
    };

    // Validate parent: existence, same brand, not self, not descendant (cycle).
    if (parentFormatId) {
      if (parentFormatId === id) {
        return NextResponse.json({ error: "A format cannot be its own parent" }, { status: 400 });
      }
      const [selfRow] = await db
        .select({ brand: formats.brand })
        .from(formats)
        .where(eq(formats.id, id));
      const [parent] = await db
        .select({ brand: formats.brand })
        .from(formats)
        .where(eq(formats.id, parentFormatId));
      if (!parent) {
        return NextResponse.json({ error: "Parent format not found" }, { status: 400 });
      }
      if (selfRow && parent.brand !== selfRow.brand) {
        return NextResponse.json({ error: "Parent format must be in the same brand" }, { status: 400 });
      }
      if (await isAncestor(parentFormatId, id)) {
        return NextResponse.json({ error: "Cycle detected: parent is a descendant of this format" }, { status: 400 });
      }
    }

    // Get the old name before updating so we can cascade the rename
    const [existing] = await db
      .select({ name: formats.name })
      .from(formats)
      .where(eq(formats.id, id));

    const [updated] = await db
      .update(formats)
      .set({
        name,
        viewThreshold: viewThreshold || null,
        editor: editor || null,
        editorAsanaGid: editorAsanaGid || null,
        producer: producer || null,
        producerAsanaGid: producerAsanaGid || null,
        instructions: instructions || null,
        parentFormatId: parentFormatId || null,
        updatedAt: new Date(),
      })
      .where(eq(formats.id, id))
      .returning();

    if (accountChannels !== undefined) {
      await setFormatChannels(id, accountChannels);
    }

    // If the name changed, update all production items that use the old name
    if (existing && existing.name !== name) {
      await db
        .update(productionItems)
        .set({ format: name, updatedAt: new Date() })
        .where(eq(productionItems.format, existing.name));
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating format:", error);
    return NextResponse.json(
      { error: "Failed to update format" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    await db.delete(formats).where(eq(formats.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting format:", error);
    return NextResponse.json(
      { error: "Failed to delete format" },
      { status: 500 }
    );
  }
}
