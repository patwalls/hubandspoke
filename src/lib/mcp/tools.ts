/** What the MCP server offers — kept dependency-free so the docs page can import it. */
export const MCP_SERVER_NAME = "hubandspoke";

export interface McpToolInfo {
  name: string;
  description: string;
  /** Only offered to keys with the `write` scope. */
  write?: boolean;
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
  { name: "list_drafts", description: "The AI draft and every editor rewrite for a post, newest first." },
  { name: "list_comments", description: "Comments on a post, with timecodes." },
  { name: "search_transcripts", description: "Find where something is said across every transcript, with timestamps." },
  { name: "list_users", description: "Team members, for assignments and editor filters." },
  { name: "list_statuses", description: "Workflow status names per brand." },
  { name: "update_content", description: "Change an item: status, editor, title, format, hub. Write scope.", write: true },
  { name: "create_content_from_link", description: "Track a live post by URL. Write scope.", write: true },
  { name: "add_comment", description: "Comment on an item as the key's owner. Write scope.", write: true },
  { name: "accept_clip_idea", description: "Turn a suggested clip into a queued item. Write scope.", write: true },
  { name: "kill_clip_idea", description: "Reject a suggested clip with a reason. Write scope.", write: true },
];
