"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function wrapOnChange(fn: (val: string) => void) {
  return (value: string | null) => {
    if (value) fn(value);
  };
}

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
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Platform:</span>
        <Select value={selectedPlatform} onValueChange={wrapOnChange(onPlatformChange)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Platforms</SelectItem>
            {platforms.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Format:</span>
        <Select value={selectedFormat} onValueChange={wrapOnChange(onFormatChange)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Formats</SelectItem>
            {formats.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Source:</span>
        <Select value={selectedSource} onValueChange={wrapOnChange(onSourceChange)}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="internal">Internal</SelectItem>
            <SelectItem value="external">External</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
