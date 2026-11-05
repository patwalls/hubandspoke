"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { AcademySidebar } from "@/components/academy/academy-sidebar";
import { VideoBadge } from "@/components/academy/video-badge";
import { GUIDE_PROSE } from "@/components/academy/guide-prose";
import { renderGuideHtml } from "@/lib/academy/guide-render";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { embedUrlAt, timestampSeconds, videoEmbedUrl } from "@/lib/academy/video-embed";
import type { AcademyCategory, AcademyProgressMap, AcademyVideo } from "@/lib/academy/queries";
import { VideoFormDialog } from "@/components/academy/video-form-dialog";

export function AcademyVideoPage({
  library,
  video,
  categoryName,
  prev,
  next,
  progress,
  canEdit,
}: {
  library: AcademyCategory[];
  video: AcademyVideo;
  categoryName: string;
  prev: Pick<AcademyVideo, "slug" | "title"> | null;
  next: Pick<AcademyVideo, "slug" | "title"> | null;
  progress: AcademyProgressMap;
  canEdit: boolean;
}) {
  const router = useRouter();
  const embed = videoEmbedUrl(video.videoUrl);
  const [playerSrc, setPlayerSrc] = useState(embed);
  const [checked, setChecked] = useState<string[]>(progress[video.id]?.checkedItems ?? []);
  const [completed, setCompleted] = useState(progress[video.id]?.completed ?? false);
  const [editing, setEditing] = useState(false);

  async function saveProgress(body: { checkedItems?: string[]; completed?: boolean }) {
    const res = await fetch(`/api/academy/progress/${video.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast.error("Couldn't save your progress");
      return false;
    }
    router.refresh();
    return true;
  }

  async function toggleItem(item: string) {
    const nextChecked = checked.includes(item) ? checked.filter((c) => c !== item) : [...checked, item];
    setChecked(nextChecked);
    // Ticking the last box completes the video.
    const allDone = video.actionItems.length > 0 && video.actionItems.every((a) => nextChecked.includes(a));
    if (allDone && !completed) setCompleted(true);
    await saveProgress({ checkedItems: nextChecked, ...(allDone && !completed ? { completed: true } : {}) });
  }

  async function toggleCompleted() {
    const value = !completed;
    setCompleted(value);
    if (!(await saveProgress({ completed: value }))) setCompleted(!value);
  }

  async function remove() {
    if (!window.confirm(`Delete "${video.title}"? Everyone's progress on it is removed too.`)) return;
    const res = await fetch(`/api/academy/videos/${video.id}`, { method: "DELETE" });
    if (!res.ok) return toast.error("Couldn't delete the video");
    toast.success("Video deleted");
    router.push("/academy");
    router.refresh();
  }

  return (
    <div className="mx-auto flex max-w-7xl gap-8 pb-16">
      <AcademySidebar
        library={library}
        progress={{ ...progress, [video.id]: { checkedItems: checked, completed } }}
        activeVideoId={video.id}
      />

      {/* Main */}
      <article className="min-w-0 flex-1 max-w-3xl">
        <Link href="/academy" className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground lg:hidden">
          <ArrowLeft className="size-3" /> All videos
        </Link>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-orange-600">{categoryName}</span>
          <VideoBadge video={video} />
        </div>
        <div className="mt-1 flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{video.title}</h1>
          {canEdit && (
            <div className="flex shrink-0 gap-1 pt-1">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Delete video" onClick={remove}>
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
        {(video.summary || video.durationLabel) && (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {video.summary}
            {video.durationLabel && (
              <span className="inline-flex items-center gap-1 text-xs">
                <Clock className="size-3" /> {video.durationLabel}
              </span>
            )}
          </p>
        )}

        {/* Player */}
        <div className="mt-6">
          {video.comingSoon ? (
            <div className="flex aspect-video flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-muted/30 text-center">
              <span className="text-sm font-semibold text-foreground">Coming soon</span>
              <span className="max-w-sm text-xs text-muted-foreground">This video is on its way. It&apos;ll show up here as &ldquo;New&rdquo; when it&apos;s ready.</span>
            </div>
          ) : playerSrc ? (
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-sm ring-1 ring-border">
              <iframe
                key={playerSrc}
                src={playerSrc}
                title={video.title}
                className="absolute inset-0 size-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
          ) : video.videoUrl ? (
            <a href={video.videoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-600 hover:underline">
              Open video <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">Video coming soon</div>
          )}
        </div>

        {/* You'll learn */}
        {video.learnPoints.length > 0 && (
          <section className="mt-8">
            <h2 className="text-base font-semibold text-foreground">In this video, you&apos;ll learn</h2>
            <ul className="mt-3 space-y-2">
              {video.learnPoints.map((p, i) => {
                const secs = timestampSeconds(p.time);
                return (
                  <li key={i} className="flex items-start gap-3 text-sm leading-relaxed text-foreground/90">
                    {p.time ? (
                      embed && secs !== null ? (
                        <button
                          type="button"
                          onClick={() => setPlayerSrc(embedUrlAt(embed, secs))}
                          className="shrink-0 rounded bg-orange-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-orange-700 hover:bg-orange-100 dark:bg-orange-950/40 dark:text-orange-300"
                          title={`Jump to ${p.time}`}
                        >
                          {p.time}
                        </button>
                      ) : (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">{p.time}</span>
                      )
                    ) : (
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                    )}
                    <span>{p.text}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Action items */}
        {!video.comingSoon && video.actionItems.length > 0 && (
          <section className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900/60 dark:bg-amber-950/30">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">Action items</h2>
              <span className="text-xs text-amber-800/70 dark:text-amber-300/70">
                {video.actionItems.filter((a) => checked.includes(a)).length} of {video.actionItems.length} done
              </span>
            </div>
            <ul className="mt-3 space-y-1">
              {video.actionItems.map((item) => {
                const on = checked.includes(item);
                return (
                  <li key={item}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-md py-1.5 text-sm leading-relaxed">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleItem(item)}
                        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-orange-500"
                      />
                      <span className={cn("text-foreground", on && "text-muted-foreground line-through")}>{item}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Step-by-step guide (sanitized on save; video placeholders become players) */}
        {!video.comingSoon && video.notes && (
          <section className={cn("mt-10 border-t border-border pt-8", GUIDE_PROSE)} dangerouslySetInnerHTML={{ __html: renderGuideHtml(video.notes) }} />
        )}

        {/* Complete + prev/next ("Coming soon" videos can't be completed yet) */}
        <div className={cn("mt-10 flex justify-center", video.comingSoon && "hidden")}>
          <Button variant={completed ? "outline" : "default"} onClick={toggleCompleted}>
            {completed ? (
              <>
                <CheckCircle2 className="text-emerald-600" /> Completed
              </>
            ) : (
              <>
                <Check /> Mark as complete
              </>
            )}
          </Button>
        </div>
        <nav className="mt-8 grid gap-3 border-t border-border pt-6 sm:grid-cols-2" aria-label="Previous and next video">
          {prev ? (
            <Link href={`/academy/${prev.slug}`} className="group rounded-xl border border-border p-4 hover:border-orange-300">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowLeft className="size-3" /> Previous
              </span>
              <span className="mt-1 block text-sm font-medium text-foreground group-hover:text-orange-600">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/academy/${next.slug}`} className="group rounded-xl border border-border p-4 text-right hover:border-orange-300">
              <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                Next <ArrowRight className="size-3" />
              </span>
              <span className="mt-1 block text-sm font-medium text-foreground group-hover:text-orange-600">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>

      {editing && <VideoFormDialog categories={library} video={video} onClose={() => setEditing(false)} />}
    </div>
  );
}
