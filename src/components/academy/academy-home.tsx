"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, CheckCircle2, Clock, GraduationCap, Pencil, PlayCircle, Plus, SearchIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AcademyCategory, AcademyProgressMap, AcademyVideo } from "@/lib/academy/queries";
import { VideoFormDialog } from "@/components/academy/video-form-dialog";
import { CategoryFormDialog } from "@/components/academy/category-form-dialog";
import { AcademySidebar } from "@/components/academy/academy-sidebar";
import { VideoBadge } from "@/components/academy/video-badge";

type Editing =
  | { kind: "video"; video?: AcademyVideo; categoryId?: string }
  | { kind: "category"; category?: AcademyCategory }
  | null;

/** Text a video is searchable by: title, description, learn points, action items, notes. */
function haystack(v: AcademyVideo, categoryName: string): string {
  return [v.title, v.summary, categoryName, ...v.learnPoints.map((p) => p.text), ...v.actionItems, v.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function AcademyHome({
  library,
  progress,
  canEdit,
}: {
  library: AcademyCategory[];
  progress: AcademyProgressMap;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);

  // Progress counts only videos you can actually watch (not "Coming soon").
  const total = library.reduce((n, c) => n + c.videos.filter((v) => !v.comingSoon).length, 0);
  const done = library.reduce((n, c) => n + c.videos.filter((v) => !v.comingSoon && progress[v.id]?.completed).length, 0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Empty categories are only shown to editors (so they can fill or delete them).
    if (!q) return canEdit ? library : library.filter((c) => c.videos.length > 0);
    return library
      .map((c) => ({ ...c, videos: c.videos.filter((v) => haystack(v, c.name).includes(q)) }))
      .filter((c) => c.videos.length > 0);
  }, [library, query, canEdit]);

  async function deleteCategory(category: AcademyCategory) {
    if (!window.confirm(`Delete the "${category.name}" category?`)) return;
    const res = await fetch(`/api/academy/categories/${category.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(data.error ?? "Couldn't delete the category");
    toast.success("Category deleted");
    router.refresh();
  }

  async function reorder(kind: "videos" | "categories", ids: string[]) {
    const res = await fetch("/api/academy/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ids }),
    });
    if (!res.ok) toast.error("Couldn't reorder");
    router.refresh();
  }

  function move<T extends { id: string }>(list: T[], index: number, delta: number): string[] {
    const ids = list.map((x) => x.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    return ids;
  }

  return (
    <div className="mx-auto flex max-w-7xl gap-8">
    <AcademySidebar library={library} progress={progress} activeVideoId={null} canEdit={canEdit} />
    <div className="min-w-0 flex-1 max-w-5xl space-y-10 pb-16">
      {/* Hero */}
      <section className="rounded-2xl border border-border bg-gradient-to-br from-orange-50 via-background to-amber-50 px-6 py-10 text-center dark:from-orange-950/30 dark:to-amber-950/20 sm:px-10">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-orange-500/10 text-orange-600">
          <GraduationCap className="size-5" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Hub &amp; Spoke Academy</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Short training videos on how to use Hub &amp; Spoke — watch them in order, or search for what you need.
        </p>
        <div className="relative mx-auto mt-6 max-w-lg">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What are you trying to do?"
            aria-label="Search the Academy"
            className="h-11 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        {total > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {done} of {total} videos completed
          </p>
        )}
      </section>

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing({ kind: "category" })}>
            <Plus /> Add category
          </Button>
          <Button size="sm" onClick={() => setEditing({ kind: "video" })}>
            <Plus /> Add video
          </Button>
        </div>
      )}

      {visible.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {query ? `No videos match "${query}".` : canEdit ? "No videos yet — add the first one." : "No videos yet."}
        </p>
      )}

      {visible.map((category) => {
        const catIndex = library.findIndex((c) => c.id === category.id);
        return (
          <section key={category.id} className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">{category.name}</h2>
                {category.description && <p className="text-sm text-muted-foreground">{category.description}</p>}
              </div>
              {canEdit && !query && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Move category up" disabled={catIndex === 0} onClick={() => reorder("categories", move(library, catIndex, -1))}>
                    <ArrowUp />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Move category down" disabled={catIndex === library.length - 1} onClick={() => reorder("categories", move(library, catIndex, 1))}>
                    <ArrowDown />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Edit category" onClick={() => setEditing({ kind: "category", category })}>
                    <Pencil />
                  </Button>
                  {category.videos.length === 0 && (
                    <Button variant="ghost" size="icon-sm" aria-label="Delete category" title="Delete category" onClick={() => deleteCategory(category)}>
                      <Trash2 />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm" aria-label="Add video to this category" onClick={() => setEditing({ kind: "video", categoryId: category.id })}>
                    <Plus />
                  </Button>
                </div>
              )}
            </div>

            {category.videos.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                <p>No videos in this category yet — only Academy editors can see it.</p>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing({ kind: "video", categoryId: category.id })}>
                      <Plus /> Add a video
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => deleteCategory(category)}>
                      <Trash2 /> Delete category
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {category.videos.map((video, i) => {
                  const completed = progress[video.id]?.completed;
                  return (
                    <div key={video.id} className="group relative">
                      <Link
                        href={`/academy/${video.slug}`}
                        className={cn(
                          "flex h-full flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-orange-300 hover:bg-orange-50/40 dark:hover:bg-orange-950/20",
                          completed && "border-emerald-200 dark:border-emerald-900",
                          video.comingSoon && "border-dashed bg-muted/30 hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          {completed ? (
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Completed" />
                          ) : (
                            <PlayCircle className="mt-0.5 size-4 shrink-0 text-orange-500" />
                          )}
                          <span className={cn("text-sm font-medium leading-snug text-foreground", video.comingSoon && "text-muted-foreground")}>{video.title}</span>
                          <VideoBadge video={video} className="ml-auto mt-0.5" />
                        </div>
                        {video.summary && <p className="line-clamp-2 pl-6.5 text-xs leading-relaxed text-muted-foreground">{video.summary}</p>}
                        {video.durationLabel && (
                          <span className="mt-auto flex items-center gap-1 pl-6.5 text-[11px] text-muted-foreground">
                            <Clock className="size-3" /> {video.durationLabel}
                          </span>
                        )}
                      </Link>
                      {canEdit && !query && (
                        <div className="absolute right-2 top-2 hidden gap-0.5 rounded-md bg-background/90 p-0.5 shadow-sm ring-1 ring-border group-hover:flex group-focus-within:flex">
                          <Button variant="ghost" size="icon-xs" aria-label="Move earlier" disabled={i === 0} onClick={() => reorder("videos", move(category.videos, i, -1))}>
                            <ArrowUp />
                          </Button>
                          <Button variant="ghost" size="icon-xs" aria-label="Move later" disabled={i === category.videos.length - 1} onClick={() => reorder("videos", move(category.videos, i, 1))}>
                            <ArrowDown />
                          </Button>
                          <Button variant="ghost" size="icon-xs" aria-label="Edit video" onClick={() => setEditing({ kind: "video", video })}>
                            <Pencil />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      {editing?.kind === "video" && (
        <VideoFormDialog
          categories={library}
          video={editing.video}
          defaultCategoryId={editing.categoryId}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "category" && (
        <CategoryFormDialog
          category={editing.category ? { ...editing.category, videoCount: editing.category.videos.length } : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
    </div>
  );
}
