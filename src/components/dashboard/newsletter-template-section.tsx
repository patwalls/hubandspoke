"use client";

// Format page card: edit a newsletter format's template (the ordered sections
// every issue is drafted into). Flag `newsletterDrafter`; renders nothing for
// users without it or for formats with no newsletter template. Saving applies
// to the next draft or section regenerate; existing drafts keep their text.

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PropertyRowSolo } from "@/components/dashboard/property-row";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import type { NewsletterTemplate, NewsletterTemplateSection } from "@/lib/newsletter-template";

export function NewsletterTemplateSection({ formatId }: { formatId: string }) {
  const flags = useFeatureFlags();
  const enabled = !!flags?.newsletterDrafter;
  const [template, setTemplate] = useState<NewsletterTemplate | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/formats/${formatId}/newsletter-template`)
      .then((r) => (r.ok ? (r.json() as Promise<{ template: NewsletterTemplate | null; isDefault: boolean }>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setTemplate(j.template);
        setSaved(JSON.stringify(j.template));
        setIsDefault(j.isDefault);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, formatId]);

  if (!enabled || !template) return null;
  const dirty = JSON.stringify(template) !== saved;

  const update = (i: number, patch: Partial<NewsletterTemplateSection>) =>
    setTemplate({ ...template, sections: template.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const next = [...template.sections];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    setTemplate({ ...template, sections: next });
  };

  async function call(method: "PUT" | "DELETE") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/formats/${formatId}/newsletter-template`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "PUT" ? JSON.stringify({ template }) : undefined,
      });
      const j = (await res.json().catch(() => ({}))) as { template?: NewsletterTemplate; isDefault?: boolean; error?: string };
      if (!res.ok || !j.template) throw new Error(j.error ?? "Couldn't save");
      setTemplate(j.template);
      setSaved(JSON.stringify(j.template));
      setIsDefault(!!j.isDefault);
      setMessage(method === "PUT" ? "Saved — applies to the next draft" : "Reset to default");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PropertyRowSolo>
      <div className="space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="text-sm text-muted-foreground">Newsletter template</span>
            <span className="text-xs text-muted-foreground">
              The sections every issue is drafted into, in order. {isDefault ? "Using the built-in default." : "Customized."}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {message && <span className="text-xs text-muted-foreground">{message}</span>}
            {!isDefault && (
              <Button size="sm" variant="ghost" onClick={() => call("DELETE")} disabled={busy}>
                Reset to default
              </Button>
            )}
            <Button size="sm" onClick={() => call("PUT")} disabled={!dirty || busy}>
              {busy && <Loader2 className="animate-spin" />}
              Save template
            </Button>
          </div>
        </div>
        {template.sections.map((sec, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="h-7 w-40 font-mono text-xs" value={sec.key} onChange={(e) => update(i, { key: e.target.value })} title="Section key" />
              <Input
                className="h-7 min-w-48 flex-1 text-xs"
                placeholder="Heading (empty = the section writes its own)"
                value={sec.heading ?? ""}
                onChange={(e) => update(i, { heading: e.target.value || null })}
              />
              <select className="h-7 rounded-md border border-input bg-background px-1 text-xs" value={sec.headingLevel} onChange={(e) => update(i, { headingLevel: Number(e.target.value) as 2 | 3 })}>
                <option value={2}>H2</option>
                <option value={3}>H3</option>
              </select>
              <select className="h-7 rounded-md border border-input bg-background px-1 text-xs" value={sec.kind} onChange={(e) => update(i, { kind: e.target.value as "text" | "sponsor" })}>
                <option value="text">Text</option>
                <option value="sponsor">Sponsor (from Asana)</option>
              </select>
              <Button size="icon-xs" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => move(i, 1)} disabled={i === template.sections.length - 1} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setTemplate({ ...template, sections: template.sections.filter((_, j) => j !== i) })}
                disabled={template.sections.length === 1}
                aria-label="Remove section"
              >
                <Trash2 />
              </Button>
            </div>
            <Textarea className="min-h-14 text-xs" placeholder="What goes in this section (the drafter reads this)" value={sec.hint} onChange={(e) => update(i, { hint: e.target.value })} />
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setTemplate({
              ...template,
              sections: [...template.sections, { key: `section_${template.sections.length + 1}`, heading: null, headingLevel: 2, kind: "text", hint: "" }],
            })
          }
        >
          <Plus /> Add section
        </Button>
      </div>
    </PropertyRowSolo>
  );
}
