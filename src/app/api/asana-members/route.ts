import { NextResponse } from "next/server";

const ASANA_BASE = "https://app.asana.com/api/1.0";
const WORKSPACE_GID = "1200382537239879";

/**
 * GET /api/asana-members
 *
 * Returns workspace members from Asana with { gid, name, email }.
 * Cached for 5 minutes via Next.js revalidate.
 */
export async function GET() {
  try {
    const token = process.env.ASANA_ACCESS_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: "ASANA_ACCESS_TOKEN is not configured" },
        { status: 500 }
      );
    }

    const res = await fetch(
      `${ASANA_BASE}/workspaces/${WORKSPACE_GID}/users?opt_fields=name,email`,
      {
        headers: { Authorization: `Bearer ${token}` },
        next: { revalidate: 300 }, // cache 5 min
      }
    );

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json(
        { error: `Asana API error: ${err}` },
        { status: res.status }
      );
    }

    const json = await res.json();
    return NextResponse.json(json.data);
  } catch (error) {
    console.error("Error fetching Asana members:", error);
    return NextResponse.json(
      { error: "Failed to fetch Asana members" },
      { status: 500 }
    );
  }
}
