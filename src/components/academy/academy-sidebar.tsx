"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, GripVertical, Pencil, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcademyCategory, AcademyProgressMap } from "@/lib/academy/queries";
import { moveCategory, moveVideo } from "@/lib/academy/reorder";
import { VideoBadge } from "@/components/academy/video-badge";
import { VideoFormDialog } from "@/components/academy/video-form-dialog";
import { CategoryFormDialog } from "@/components/academy/category-form-dialog";

type Drag = { kind: "video"; id: string } | { kind: "category"; id: string } | null;
type Drop = { kind: "video"; categoryId: string; index: number } | { kind: "category"; index: number } | null;

/**
 * Help-center style left nav for the Academy: Home, then each category as a
 * heading with its videos underneath. The current page is a tinted pill;
 * finished videos get a small check.
 *
 * Academy editors also get: drag videos (within or across categories) and
 * category headings to reorder, "+ Add video" per category, "+ Add category".
 */
export function AcademySidebar({
  library,
  progress,
  activeVideoId,
  canEdit = false,
}: {
  library: AcademyCategory[];
  progress: AcademyProgressMap;
  /** null on the Academy home page. */
  activeVideoId: string | null;
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(library);
  const [drag, setDrag] = useState<Drag>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const [adding, setAdding] = useState<{ kind: "video"; categoryId: string } | { kind: "category" } | { kind: "editCategory"; category: AcademyCategory } | null>(null);

  // Server data wins whenever it changes (after a save + refresh).
  const [seen, setSeen] = useState(library);
  if (seen !== library) {
    setSeen(library);
    setOrder(library);
  }

  async function save(body: { kind: "videos" | "categories"; ids: string[]; categoryId?: string }) {
    const res = await fetch("/api/academy/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast.error("Couldn't save the new order");
      setOrder(library);
    }
    router.refresh();
  }

  function finishDrop() {
    if (drag?.kind === "video" && drop?.kind === "video") {
      const fromCat = order.find((c) => c.videos.some((v) => v.id === drag.id));
      const next = moveVideo(order, drag.id, drop.categoryId, drop.index);
      setOrder(next);
      const target = next.find((c) => c.id === drop.categoryId);
      if (target) {
        void save({ kind: "videos", ids: target.videos.map((v) => v.id), categoryId: drop.categoryId });
        // The category it left keeps a gap-free order too.
        const source = next.find((c) => c.id === fromCat?.id);
        if (source && source.id !== target.id && source.videos.length > 0) {
          void save({ kind: "videos", ids: source.videos.map((v) => v.id) });
        }
      }
    } else if (drag?.kind === "category" && drop?.kind === "category") {
      const next = moveCategory(order, drag.id, drop.index);
      setOrder(next);
      void save({ kind: "categories", ids: next.map((c) => c.id) });
    }
    setDrag(null);
    setDrop(null);
  }

  /** Drop position before/after an element, from the pointer's vertical position. */
  const half = (e: React.DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY > r.top + r.height / 2 ? 1 : 0;
  };

  const item = (active: boolean) =>
    cn(
      "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-[14px] leading-snug transition-colors",
      active
        ? "bg-orange-100/70 font-medium text-orange-900 dark:bg-orange-950/50 dark:text-orange-200"
        : "text-muted-foreground hover:bg-accent hover:text-foreground",
    );
  const line = <div className="mx-3 h-0.5 rounded-full bg-orange-400" />;
  const grip = "size-3.5 shrink-0 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing";

  // Viewers don't see empty categories; editors do (to fill, drop into, or delete them).
  const shown = canEdit ? order : order.filter((c) => c.videos.length > 0);

  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <nav
        className="sticky top-20 max-h-[calc(100vh-6rem)] space-y-6 overflow-y-auto pb-8 pr-2"
        aria-label="Academy"
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
      >
        <div className="space-y-0.5">
          <div className="px-3 pb-1 text-[14px] font-semibold text-foreground">Academy</div>
          <Link href="/academy" aria-current={activeVideoId === null ? "page" : undefined} className={item(activeVideoId === null)}>
            Home
          </Link>
        </div>

        {shown.map((cat, catIndex) => (
          <div
            key={cat.id}
            className={cn("space-y-0.5", drag?.kind === "category" && drag.id === cat.id && "opacity-40")}
            onDragOver={(e) => {
              if (drag?.kind !== "category") return;
              e.preventDefault();
              setDrop({ kind: "category", index: catIndex + half(e) });
            }}
            onDrop={(e) => {
              e.preventDefault();
              finishDrop();
            }}
          >
            {drop?.kind === "category" && drop.index === catIndex && line}
            <div
              className="group flex items-center gap-1 pb-1"
              draggable={canEdit}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDrag({ kind: "category", id: cat.id });
              }}
            >
              {canEdit && <GripVertical className={cn(grip, "-ml-1")} aria-hidden />}
              <span className={cn("flex-1 text-[14px] font-semibold text-foreground", !canEdit && "px-3")}>{cat.name}</span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setAdding({ kind: "editCategory", category: cat })}
                  className="rounded p-1 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  aria-label={`Edit ${cat.name}`}
                  title="Rename or delete category"
                >
                  <Pencil className="size-3" />
                </button>
              )}
            </div>

            {cat.videos.map((v, i) => {
              const active = v.id === activeVideoId;
              return (
                <div key={v.id}>
                  {drop?.kind === "video" && drop.categoryId === cat.id && drop.index === i && line}
                  <div
                    className={cn("group flex items-center", drag?.kind === "video" && drag.id === v.id && "opacity-40")}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = "move";
                      setDrag({ kind: "video", id: v.id });
                    }}
                    onDragOver={(e) => {
                      if (drag?.kind !== "video") return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDrop({ kind: "video", categoryId: cat.id, index: i + half(e) });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      finishDrop();
                    }}
                  >
                    {canEdit && <GripVertical className={cn(grip, "-ml-1")} aria-hidden />}
                    <Link href={`/academy/${v.slug}`} aria-current={active ? "page" : undefined} className={item(active)} draggable={false}>
                      <span className={cn(v.comingSoon && "opacity-60")}>{v.title}</span>
                      {progress[v.id]?.completed ? (
                        <Check className="size-3.5 shrink-0 text-emerald-600" aria-label="Completed" />
                      ) : (
                        <VideoBadge video={v} />
                      )}
                    </Link>
                  </div>
                </div>
              );
            })}
            {drop?.kind === "video" && drop.categoryId === cat.id && drop.index === cat.videos.length && line}

            {canEdit && (
              <button
                type="button"
                onClick={() => setAdding({ kind: "video", categoryId: cat.id })}
                onDragOver={(e) => {
                  if (drag?.kind !== "video") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDrop({ kind: "video", categoryId: cat.id, index: cat.videos.length });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  finishDrop();
                }}
                className="flex w-full items-center gap-1.5 rounded-lg px-3 py-1 text-[13px] text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-3.5" /> Add video
              </button>
            )}
          </div>
        ))}
        {drop?.kind === "category" && drop.index === shown.length && line}

        {canEdit && (
          <button
            type="button"
            onClick={() => setAdding({ kind: "category" })}
            className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:border-orange-300 hover:text-foreground"
          >
            <Plus className="size-3.5" /> Add category
          </button>
        )}
      </nav>

      {adding?.kind === "video" && <VideoFormDialog categories={order} defaultCategoryId={adding.categoryId} onClose={() => setAdding(null)} />}
      {adding?.kind === "category" && <CategoryFormDialog onClose={() => setAdding(null)} />}
      {adding?.kind === "editCategory" && (
        <CategoryFormDialog category={{ ...adding.category, videoCount: adding.category.videos.length }} onClose={() => setAdding(null)} />
      )}
    </aside>
  );
}
