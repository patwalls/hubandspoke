import type { AcademyCategory } from "@/lib/academy/queries";

/**
 * Drag-and-drop reordering for the Academy sidebar. Pure functions over the
 * library so the UI can update instantly and then save.
 */

/** Move a video to `toIndex` within category `toCategoryId` (same or another category). */
export function moveVideo(library: AcademyCategory[], videoId: string, toCategoryId: string, toIndex: number): AcademyCategory[] {
  const from = library.find((c) => c.videos.some((v) => v.id === videoId));
  const video = from?.videos.find((v) => v.id === videoId);
  if (!from || !video || !library.some((c) => c.id === toCategoryId)) return library;

  const without = library.map((c) => (c.id === from.id ? { ...c, videos: c.videos.filter((v) => v.id !== videoId) } : c));
  return without.map((c) => {
    if (c.id !== toCategoryId) return c;
    const videos = [...c.videos];
    // Indexes are measured with the video still in place; adjust when moving down in the same list.
    const fromIndex = from.id === toCategoryId ? from.videos.findIndex((v) => v.id === videoId) : -1;
    const at = fromIndex !== -1 && fromIndex < toIndex ? toIndex - 1 : toIndex;
    videos.splice(Math.max(0, Math.min(at, videos.length)), 0, { ...video, categoryId: toCategoryId });
    return { ...c, videos };
  });
}

/** Move a category to `toIndex` (measured with the category still in place). */
export function moveCategory(library: AcademyCategory[], categoryId: string, toIndex: number): AcademyCategory[] {
  const fromIndex = library.findIndex((c) => c.id === categoryId);
  if (fromIndex === -1) return library;
  const next = [...library];
  const [cat] = next.splice(fromIndex, 1);
  const at = fromIndex < toIndex ? toIndex - 1 : toIndex;
  next.splice(Math.max(0, Math.min(at, next.length)), 0, cat);
  return next;
}
