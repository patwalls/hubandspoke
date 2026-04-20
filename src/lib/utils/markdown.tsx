import type { ReactNode } from "react";

// Render a markdown-ish string: [label](url) → anchor, bare URLs → anchor,
// newlines preserved. Read-only, no other markdown features.
export function renderInstructions(text: string): ReactNode[] {
  const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const BARE_URL = /(https?:\/\/[^\s)]+)/g;

  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  const pushText = (s: string) => {
    if (!s) return;
    let last = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(BARE_URL);
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      parts.push(
        <a
          key={`u${key++}`}
          href={m[1]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline break-all"
        >
          {m[1]}
        </a>
      );
      last = m.index + m[1].length;
    }
    if (last < s.length) parts.push(s.slice(last));
  };

  while ((match = MD_LINK.exec(text)) !== null) {
    if (match.index > cursor) pushText(text.slice(cursor, match.index));
    parts.push(
      <a
        key={`l${key++}`}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:text-blue-800 underline"
      >
        {match[1]}
      </a>
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushText(text.slice(cursor));
  return parts;
}
