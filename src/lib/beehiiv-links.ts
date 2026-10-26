// Pure beehiiv app links for a post id (safe to import from the client; the
// API client itself is server-only in beehiiv.ts). The API's `preview_url`
// keeps the `post_` prefix; its editor link drops it.

const bare = (postId: string) => postId.replace(/^post_/, "");

/** beehiiv's editor for a post ("post_<uuid>" → /posts/<uuid>/edit). */
export function beehiivEditUrl(postId: string): string {
  return `https://app.beehiiv.com/posts/${bare(postId)}/edit`;
}

/** beehiiv's rendered preview of a post (what the API returns as `preview_url`). */
export function beehiivPreviewUrl(postId: string): string {
  return `https://app.beehiiv.com/posts/post_${bare(postId)}/preview`;
}

/** The preview link for a saved editor link (`newsletter_drafts.beehiiv_post_url`); null for anything else. */
export function beehiivPreviewUrlFromEditUrl(editUrl: string | null | undefined): string | null {
  const m = editUrl?.match(/^https:\/\/app\.beehiiv\.com\/posts\/(?:post_)?([0-9a-f-]{36})\/edit$/);
  return m ? beehiivPreviewUrl(m[1]) : null;
}
