"use client";

import { useState, useEffect, useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  parseSkillSections,
  assembleSkillFromSections,
  type SkillSections,
} from "@/lib/format-skill";

interface SectionDef {
  key: keyof SkillSections;
  heading: string;
  agentTag: string;
  description: string;
  placeholder: string;
  example: string;
  clippableOnly?: boolean;
  rows?: number;
}

const SECTIONS: SectionDef[] = [
  {
    key: "whatThisFormatIs",
    heading: "What this format is",
    agentTag: "all agents",
    description: "One-liner description. Gives Claude brand context before any task.",
    placeholder:
      "e.g. Vertical 30–60s highlight clip for Instagram Reels. Pulled from the SS podcast pillar. Founder insight delivered fast, no fluff.",
    example:
      "Vertical 30–60s Instagram Reel showcasing a founder's app in action, with a hook leading with monthly revenue. Shows the actual product, a feature walkthrough, and the founder's story — all built around the revenue reveal as the payoff.",
  },
  {
    key: "whyItWorks",
    heading: "Why it works",
    agentTag: "all agents",
    description: "What makes this format resonate. Helps Claude avoid generic output.",
    placeholder:
      "e.g. Strong hook in the first 3s, payoff by 15s. Audience gets a tactical insight without watching the full pillar.",
    example:
      "Pairing product demo with revenue creates immediate social proof and a curiosity gap. Viewers stop scrolling because the hook promises a surprise (\"It's simple? And makes $25K/month?\"). Combines two high-performing patterns: the behind-the-scenes product reveal and financial validation — both signal authenticity and achievability to bootstrapper audiences.",
  },
  {
    key: "clipGuidance",
    heading: "Clip guidance",
    agentTag: "Splice agent",
    description:
      "How to pick and frame the moment. Required for clippable formats.",
    placeholder:
      "e.g. Look for a single strong quote, a surprising stat, or a tactical tip. Start on a clean sentence boundary. End on a thought-ending beat. Target 30–60s.",
    example:
      "Start at the moment the founder begins showing the app — skip any lengthy preamble. End after the founder finishes explaining the core insight about why it works. Skip lengthy feature deep-dives, technical jargon, or multi-minute tutorial sections. Capture at least one moment of genuine surprise or pride when they mention the revenue figure.",
    clippableOnly: true,
    rows: 5,
  },
  {
    key: "avoid",
    heading: "Avoid",
    agentTag: "all agents",
    description: "Format-specific anti-patterns Claude must never do.",
    placeholder:
      "e.g. No filler intros. No \"so yeah\" tail-offs. Skip moments where the speaker is reading from a doc.",
    example:
      "First-person hooks (\"I'm a founder who…\"). Paraphrased quotables. Lines that read as setup for a story the viewer can't hear in the clip. Quotables that span more than one paragraph of dense context — keep each one punchy.",
  },
  {
    key: "clipIdeaGeneration",
    heading: "Clip idea generation",
    agentTag: "Splice agent",
    description:
      "Hook style, target runtime, anti-patterns, and optional extras-schema.",
    placeholder:
      "Hook style: describe what the hook IS for this format — narrator overlay? third-person framing tweet? founder quote?\nTarget runtime: e.g. 30–60s for Reels, 20–40s for X.\nAnti-patterns: what the hook must NEVER do.",
    example:
      "Hook style: A third-person framing line about the speaker in editorial voice — surface a stance the speaker takes (e.g. \"He built a $2M business by ignoring this advice.\"). Never use first-person; the speaker is being quoted, not narrating.\nTarget runtime: 20–40 seconds. Tight beats long — Twitter video gets fewer seconds of attention than Reels.\nAnti-patterns: first-person hooks; paraphrased quotables; lines drawn from outside the clip's timestamp range.",
    clippableOnly: true,
    rows: 8,
  },
  {
    key: "descriptInstructions",
    heading: "Descript instructions",
    agentTag: "Descript Underlord",
    description:
      "Auto-edit rules: pacing, filler words, captions, layout pack. Used when Descript processes a clip.",
    placeholder:
      "e.g. Apply the layout pack at https://web.descript.com/… — it handles 9:16 framing, the hook-text track, and captions.\nSet the hook text track to: \"{{hook}}\".\nMark filler words (um, uh, like as filler, false starts, silences > 400ms) as IGNORED. Do not delete them.\nNo transitions, music, or title cards beyond what the layout pack includes.",
    example:
      "Apply the layout pack at https://web.descript.com/1cf77b5b-68e6-4c71-bb4a-edf7f1f17044. The pack handles vertical 9:16 framing, the hook-text track, and captions — use it instead of manually setting aspect ratio.\nSet the hook text track to: \"{{hook}}\". Replace whatever placeholder the pack provides — do not append; replace.\nMark filler words (\"um\", \"uh\", \"like\" when used as filler, \"you know\", false starts, repeated words, silences > 400ms) as IGNORED — do not delete them.\nDo not add transitions, effects, music, or title cards beyond what the layout pack includes.",
    rows: 8,
  },
  {
    key: "crossPostRules",
    heading: "Cross-posting rules",
    agentTag: "cross-post agent",
    description:
      "Platform-by-platform caption and framing rules when repurposing clips from this format.",
    placeholder:
      "e.g.\nInstagram, TikTok, YT Shorts: vertical (9:16)\nX and LinkedIn: horizontal (16:9)\nFor X: use the on-screen hook as the tweet body, verbatim. No thread, no CTA, no link.",
    example:
      "Instagram, TikTok and YT Shorts: vertical (9:16).\nX and LinkedIn: horizontal (16:9) — apply framing changes in Descript.\nFor X cross-posts: use the source's on-screen hook as the tweet body, verbatim. No thread, no bullet points, no CTA, no link. One line, that's it.",
    rows: 5,
  },
];

interface FormatSkillEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
  isClippable: boolean;
}

export function FormatSkillEditor({
  value,
  onChange,
  onBlur,
  isClippable,
}: FormatSkillEditorProps) {
  const [sections, setSections] = useState<SkillSections>(() =>
    parseSkillSections(value)
  );
  const [openKeys, setOpenKeys] = useState<Set<keyof SkillSections>>(() => {
    const parsed = parseSkillSections(value);
    const open = new Set<keyof SkillSections>();
    for (const key of Object.keys(parsed) as (keyof SkillSections)[]) {
      if (parsed[key].trim()) open.add(key);
    }
    return open;
  });

  // Re-parse when the value changes externally (e.g. AI regenerate)
  useEffect(() => {
    const parsed = parseSkillSections(value);
    setSections(parsed);
    setOpenKeys((prev) => {
      const next = new Set(prev);
      for (const key of Object.keys(parsed) as (keyof SkillSections)[]) {
        if (parsed[key].trim()) next.add(key);
      }
      return next;
    });
  }, [value]);

  const updateSection = useCallback(
    (key: keyof SkillSections, body: string) => {
      setSections((prev) => {
        const next = { ...prev, [key]: body };
        onChange(assembleSkillFromSections(next));
        return next;
      });
    },
    [onChange]
  );

  const handleBlur = useCallback(
    (key: keyof SkillSections, body: string) => {
      setSections((prev) => {
        const next = { ...prev, [key]: body };
        const assembled = assembleSkillFromSections(next);
        onBlur?.(assembled);
        return next;
      });
    },
    [onBlur]
  );

  const toggleOpen = (key: keyof SkillSections) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleSections = isClippable
    ? SECTIONS
    : SECTIONS.filter((s) => !s.clippableOnly);

  return (
    <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
      {visibleSections.map((sec) => {
        const isOpen = openKeys.has(sec.key);
        const body = sections[sec.key];
        const isEmpty = !body.trim();

        return (
          <div key={sec.key}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggleOpen(sec.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleOpen(sec.key); }}
              className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-foreground">
                  {sec.heading}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  · {sec.agentTag}
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-border text-[10px] italic font-serif text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
                      aria-label={`Example for ${sec.heading}`}
                    >
                      i
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="max-w-sm text-xs leading-relaxed space-y-1.5"
                    >
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Example
                      </p>
                      <p className="whitespace-pre-wrap font-mono text-[11px]">
                        {sec.example}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isEmpty ? (
                  <span className="text-[11px] text-amber-600">⚠ empty</span>
                ) : (
                  <span className="text-[11px] text-green-600">✓ filled</span>
                )}
                <svg
                  className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </div>
            </div>

            {isOpen && (
              <div className="px-4 pb-3 pt-1 bg-muted/20 space-y-1.5">
                <p className="text-[11px] text-muted-foreground">
                  {sec.description}
                </p>
                <Textarea
                  value={body}
                  rows={sec.rows ?? 4}
                  placeholder={sec.placeholder}
                  className="font-mono text-xs resize-y"
                  onChange={(e) => updateSection(sec.key, e.target.value)}
                  onBlur={(e) => handleBlur(sec.key, e.target.value)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
