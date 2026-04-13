import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formats, formatRepurposeMappings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const brand =
      request.nextUrl.searchParams.get("brand") || "starter-story";
    const allFormats = await db
      .select()
      .from(formats)
      .where(eq(formats.brand, brand))
      .orderBy(formats.name);

    // Get repurpose mappings
    const mappings = await db.select().from(formatRepurposeMappings);

    const formatsWithRepurpose = allFormats.map((f) => ({
      ...f,
      repurposeTargetIds: mappings
        .filter((m) => m.sourceFormatId === f.id)
        .map((m) => m.targetFormatId),
    }));

    return NextResponse.json(formatsWithRepurpose);
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
    const { name, channels, event, brand, repurposeTargetIds } = body;

    const [created] = await db
      .insert(formats)
      .values({
        name,
        brand: brand || "starter-story",
        channels: channels || [],
        event: event || null,
      })
      .returning();

    // Create repurpose mappings
    if (repurposeTargetIds?.length) {
      await db.insert(formatRepurposeMappings).values(
        repurposeTargetIds.map((targetId: string) => ({
          sourceFormatId: created.id,
          targetFormatId: targetId,
        }))
      );
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
    const { id, name, channels, event, repurposeTargetIds } = body;

    const [updated] = await db
      .update(formats)
      .set({
        name,
        channels: channels || [],
        event: event || null,
        updatedAt: new Date(),
      })
      .where(eq(formats.id, id))
      .returning();

    // Replace repurpose mappings
    await db
      .delete(formatRepurposeMappings)
      .where(eq(formatRepurposeMappings.sourceFormatId, id));

    if (repurposeTargetIds?.length) {
      await db.insert(formatRepurposeMappings).values(
        repurposeTargetIds.map((targetId: string) => ({
          sourceFormatId: id,
          targetFormatId: targetId,
        }))
      );
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
