/** What the MCP server offers — kept dependency-free so the docs page can import it. */
export const MCP_SERVER_NAME = "hubandspoke";

export interface McpToolInfo {
  name: string;
  description: string;
}

/** For the docs page: what an assistant gets when it connects. */
export const MCP_TOOLS: McpToolInfo[] = [
  { name: "whoami", description: "Who the connected API key belongs to." },
  { name: "list_brands", description: "Brands in the workspace." },
  { name: "list_accounts", description: "Social accounts (YouTube channel, X handle, IG account…) per brand." },
  { name: "list_formats", description: "Content formats per brand with their Skill instructions." },
  { name: "search_content", description: "Find content: filter by brand, account, type, status, format, dates, or search text." },
  { name: "get_content", description: "One content item in full, with metrics." },
  { name: "get_transcript", description: "The transcript of a video or audio post (plain text by default)." },
  { name: "list_derivatives", description: "Everything cut, cross-posted or reposted from an item (its spokes)." },
  { name: "list_clip_ideas", description: "AI-suggested clips for a long video and what editors decided." },
  { name: "get_media_links", description: "Time-limited download links for an item's video, images and poster." },
];
