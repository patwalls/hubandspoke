"use client";

interface FiltersProps {
  platforms: string[];
  formats: string[];
  selectedPlatform: string;
  selectedFormat: string;
  selectedSource: string;
  onPlatformChange: (platform: string) => void;
  onFormatChange: (format: string) => void;
  onSourceChange: (source: string) => void;
}

export function Filters({
  platforms,
  formats,
  selectedPlatform,
  selectedFormat,
  selectedSource,
  onPlatformChange,
  onFormatChange,
  onSourceChange,
}: FiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border/50">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Platform</span>
        <select
          value={selectedPlatform}
          onChange={(e) => onPlatformChange(e.target.value)}
          className="h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-w-[160px]"
        >
          <option value="all">All Platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Format</span>
        <select
          value={selectedFormat}
          onChange={(e) => onFormatChange(e.target.value)}
          className="h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-w-[160px]"
        >
          <option value="all">All Formats</option>
          {formats.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Source</span>
        <select
          value={selectedSource}
          onChange={(e) => onSourceChange(e.target.value)}
          className="h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All</option>
          <option value="internal">Internal</option>
          <option value="external">External</option>
        </select>
      </div>
    </div>
  );
}
