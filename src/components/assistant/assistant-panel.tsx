"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowUp, MessageCircle, RotateCcw, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Dispatch on window to open the panel, optionally with a question to ask. */
export const OPEN_ASSISTANT_EVENT = "hs:open-assistant";
export function openAssistant(question?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT, { detail: { question } }));
}

type Turn = { role: "user" | "assistant"; content: string; error?: boolean };

const SUGGESTIONS = [
  "How do cross-posts work?",
  "What's waiting for my review?",
  "How do I set production goals?",
  "What did we publish this week?",
];

/**
 * Hub & Spoke Assistant: a chat bubble bottom-right on every page that opens
 * a small chat window above it. Mounted once in the
 * dashboard layout, so the conversation survives moving between pages.
 * Talks to POST /api/assistant, which streams newline-delimited JSON events.
 */
export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef<Turn[]>([]);

  useEffect(() => {
    turnsRef.current = turns;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns, status]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<{ question?: string }>).detail?.question;
      if (q) void ask(q);
      else setTimeout(() => inputRef.current?.focus(), 50);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener(OPEN_ASSISTANT_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_ASSISTANT_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = [...turnsRef.current.filter((t) => !t.error), { role: "user" as const, content: q }];
    setTurns([...turnsRef.current, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    setStatus("Thinking…");

    const update = (fn: (t: Turn) => Turn) =>
      setTurns((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "The assistant couldn't answer that.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; text?: string; message?: string };
          if (event.type === "status") setStatus(event.text ?? null);
          else if (event.type === "text") {
            setStatus(null);
            update((t) => ({ ...t, content: t.content + (event.text ?? "") }));
          } else if (event.type === "error") throw new Error(event.message);
        }
      }
    } catch (err) {
      update((t) => ({ ...t, error: true, content: err instanceof Error ? err.message : "Something went wrong." }));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  // Closed: a chat bubble in the bottom-right corner of every page.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="fixed bottom-5 right-5 z-40 flex size-12 items-center justify-center rounded-full bg-orange-500 text-white shadow-lg ring-4 ring-orange-500/15 transition-transform hover:scale-105 focus:outline-none focus-visible:ring-orange-500/40"
        aria-label="Ask the Hub & Spoke Assistant"
        title="Ask the assistant"
      >
        <MessageCircle className="size-5" />
      </button>
    );
  }

  return (
    <>
      <aside
        className="fixed inset-x-3 bottom-3 top-16 z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl sm:inset-x-auto sm:right-5 sm:bottom-5 sm:top-auto sm:h-[min(640px,calc(100vh-6rem))] sm:w-[400px]"
        aria-label="Hub & Spoke Assistant"
      >
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-orange-600">Assistant</div>
            <div className="text-base font-semibold text-foreground">Ask about Hub &amp; Spoke</div>
          </div>
          <div className="flex items-center gap-1">
            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => setTurns([])}
                disabled={busy}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                aria-label="New conversation"
                title="New conversation"
              >
                <RotateCcw className="size-4" />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <Sparkles className="size-6 text-orange-500" />
              <p className="max-w-xs text-sm text-muted-foreground">
                Ask how anything in Hub &amp; Spoke works, or about your own content and what&apos;s on your plate.
              </p>
              <div className="flex flex-col items-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-full border border-border px-3.5 py-1.5 text-sm text-foreground/80 hover:border-orange-300 hover:bg-orange-50/50 dark:hover:bg-orange-950/20"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="ml-8 rounded-2xl rounded-br-md bg-orange-500 px-3.5 py-2 text-sm text-white">
                  {t.content}
                </div>
              ) : (
                <div
                  key={i}
                  className={cn(
                    "text-sm leading-relaxed text-foreground/90 [&_a]:font-medium [&_a]:text-orange-600 [&_a]:underline-offset-2 hover:[&_a]:underline [&_li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-5 [&>*+*]:mt-2",
                    t.error && "text-destructive",
                  )}
                >
                  {t.content ? (
                    <ReactMarkdown
                      components={{
                        a: ({ href, children }) => {
                          const internal = href?.startsWith(window.location.origin) || href?.startsWith("/");
                          return internal ? (
                            <a href={href}>{children}</a>
                          ) : (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          );
                        },
                      }}
                    >
                      {t.content}
                    </ReactMarkdown>
                  ) : null}
                  {i === turns.length - 1 && status && <p className="animate-pulse text-xs text-muted-foreground">{status}</p>}
                </div>
              ),
            )
          )}
        </div>

        <form
          className="flex items-end gap-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            placeholder="Ask a question…"
            aria-label="Ask a question"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-input bg-muted/30 px-3.5 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white transition-opacity disabled:opacity-40"
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
        <p className="px-4 pb-2 text-center text-[11px] text-muted-foreground/70">Answers can be wrong — check the Academy for the full walkthrough.</p>
      </aside>
    </>
  );
}
