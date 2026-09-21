"use client";

/**
 * The brand's logo library, as a popover: built-in wordmarks, the brand's
 * account avatars and every logo anyone uploaded for the brand — plus an
 * upload that lands in the library (not on the post), so it is there next
 * time and in the other editor. One control for the clip editor's "Add a
 * logo" and the design editor's picture panel.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Loader2Icon, Trash2Icon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BrandLogo } from "@/lib/design-editor/brand-assets";
import { cn } from "@/lib/utils";

const GROUPS: Array<{ key: BrandLogo["group"]; label: string }> = [
  { key: "upload", label: "Uploaded" },
  { key: "wordmark", label: "Wordmarks" },
  { key: "avatar", label: "Account avatars" },
];

export function LogoPicker({
  brand,
  trigger,
  onPick,
  className,
}: {
  brand: string;
  trigger: ReactNode;
  onPick: (logo: BrandLogo) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [logos, setLogos] = useState<BrandLogo[] | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open || logos) return;
    let cancelled = false;
    void fetch(`/api/brands/${brand}/logos`)
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { logos?: BrandLogo[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setLogos(json.logos ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setLogos([]);
          toast.error(err instanceof Error ? err.message : "Couldn't load the logos");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, logos, brand]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/brands/${brand}/logos`, { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { logo?: BrandLogo; error?: string };
      if (!res.ok || !json.logo) throw new Error(json.error ?? `Upload failed (${res.status})`);
      const logo = json.logo;
      setLogos((prev) => [logo, ...(prev ?? [])]);
      onPick(logo);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (logo: BrandLogo) => {
    if (!logo.id) return;
    const res = await fetch(`/api/brands/${brand}/logos/${logo.id}`, { method: "DELETE" });
    if (!res.ok) return toast.error("Couldn't remove the logo");
    setLogos((prev) => (prev ?? []).filter((l) => l.id !== logo.id));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={className} onPointerDown={(e) => e.stopPropagation()}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 gap-3"
        onPointerDown={(e) => e.stopPropagation()}
        // Escape closes the picker only — never the editor dialog behind it.
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            setOpen(false);
          }
        }}
      >
        <label
          className={cn(
            "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs hover:bg-muted",
            uploading && "pointer-events-none opacity-60",
          )}
        >
          {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <UploadIcon className="size-3.5" />}
          Upload a logo for this brand
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        {!logos ? (
          <div className="flex h-16 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
          </div>
        ) : logos.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground">No logos yet — upload one and it stays in the library.</p>
        ) : (
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
            {GROUPS.map(({ key, label }) => {
              const items = logos.filter((l) => l.group === key);
              if (items.length === 0) return null;
              return (
                <div key={key}>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {items.map((logo) => (
                      <div key={logo.id ?? logo.previewUrl} className="group relative">
                        <button
                          type="button"
                          title={logo.label}
                          onClick={() => {
                            onPick(logo);
                            setOpen(false);
                          }}
                          className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-border bg-[repeating-conic-gradient(#9ca3af_0_25%,#d1d5db_0_50%)] bg-[length:12px_12px] p-1.5 hover:border-sky-400"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={logo.previewUrl} alt={logo.label} className={cn("max-h-full max-w-full object-contain", key === "avatar" && "rounded-full")} />
                        </button>
                        {logo.id && (
                          <button
                            type="button"
                            aria-label={`Remove ${logo.label}`}
                            onClick={() => void remove(logo)}
                            className="absolute -right-1 -top-1 hidden rounded-full border border-border bg-background p-0.5 text-muted-foreground shadow group-hover:block hover:text-red-600"
                          >
                            <Trash2Icon className="size-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
