/**
 * Daily scorecard email template — pure rendering, no mail client.
 * `src/lib/email.ts` provides the send wrapper; the preview route calls
 * the renderer directly to display HTML in a browser without sending.
 */
import type { ScorecardData, BrandScorecard } from "@/lib/services/scorecard";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDelta(curr: number, prev: number): {
  text: string;
  color: string;
  arrow: string;
} {
  const delta = curr - prev;
  if (delta > 0) return { text: `+${delta}`, color: "#16a34a", arrow: "▲" };
  if (delta < 0) return { text: `${delta}`, color: "#dc2626", arrow: "▼" };
  return { text: "±0", color: "#737373", arrow: "—" };
}

function fmtRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  // end is exclusive; show the inclusive end date for human readability.
  const inclusiveEnd = new Date(end);
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
  return `${fmt(start)} – ${fmt(inclusiveEnd)}`;
}

export function renderDailyScorecardEmail(data: ScorecardData): RenderedEmail {
  const { thisWeek, lastWeek } = data;
  const headlineDelta = fmtDelta(
    thisWeek.totalOriginals,
    lastWeek.totalOriginals
  );

  const subject = `Daily scorecard: ${thisWeek.totalOriginals} originals last 7 days (${headlineDelta.arrow}${headlineDelta.text === "±0" ? "0" : headlineDelta.text.replace(/^\+/, "")})`;

  // ─── Text body ───────────────────────────────────────────────────────
  const textLines: string[] = [];
  textLines.push(`Daily scorecard — ${fmtRange(thisWeek.start, thisWeek.end)}`);
  textLines.push("");
  textLines.push(
    `Originals published: ${thisWeek.totalOriginals}  (${headlineDelta.arrow}${headlineDelta.text} vs prior 7 days)`
  );
  textLines.push(
    `Reposts: ${thisWeek.totalReposts}    Cross-posts: ${thisWeek.totalCrossPosts}    Repurposed: ${thisWeek.totalRepurposed}`
  );
  textLines.push(
    `Accounts shipping: ${thisWeek.totalAccountsShipped} of ${thisWeek.totalAccounts}`
  );
  textLines.push("");
  textLines.push("By brand:");
  for (const b of thisWeek.byBrand) {
    const prior = lastWeek.byBrand.find((p) => p.slug === b.slug);
    const d = fmtDelta(b.originals, prior?.originals ?? 0);
    const goalSuffix = b.weeklyGoal ? `  / goal ${b.weeklyGoal}` : "";
    const sub = [
      b.reposts ? `${b.reposts} reposts` : null,
      b.crossPosts ? `${b.crossPosts} cross-posts` : null,
      b.repurposed ? `${b.repurposed} repurposed` : null,
    ]
      .filter(Boolean)
      .join(", ");
    textLines.push(
      `  ${b.label}: ${b.originals} originals (${d.arrow}${d.text})${goalSuffix} — ${b.accountsShipped}/${b.totalAccounts} accounts shipped${sub ? `; ${sub}` : ""}`
    );
  }
  textLines.push("");
  textLines.push("— Hub & Spoke");
  const text = textLines.join("\n");

  // ─── HTML body ───────────────────────────────────────────────────────
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#171717;">
      <div style="padding:20px 0;border-bottom:1px solid #e5e5e5;">
        <p style="margin:0 0 4px 0;color:#737373;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Daily scorecard</p>
        <p style="margin:0;color:#737373;font-size:13px;">${escapeHtml(fmtRange(thisWeek.start, thisWeek.end))}</p>
      </div>

      <div style="padding:24px 0;">
        <p style="margin:0 0 4px 0;font-size:13px;color:#737373;">Originals published</p>
        <p style="margin:0;font-size:48px;font-weight:700;line-height:1;">
          ${thisWeek.totalOriginals}
          <span style="font-size:18px;font-weight:600;color:${headlineDelta.color};margin-left:8px;">
            ${headlineDelta.arrow} ${escapeHtml(headlineDelta.text)}
          </span>
        </p>
        <p style="margin:6px 0 0 0;font-size:12px;color:#737373;">vs ${lastWeek.totalOriginals} the prior 7 days</p>
      </div>

      <div style="display:flex;gap:24px;padding:0 0 24px 0;border-bottom:1px solid #e5e5e5;">
        ${[
          ["Reposts", thisWeek.totalReposts, lastWeek.totalReposts],
          ["Cross-posts", thisWeek.totalCrossPosts, lastWeek.totalCrossPosts],
          ["Repurposed", thisWeek.totalRepurposed, lastWeek.totalRepurposed],
        ]
          .map(([label, curr, prev]) => {
            const c = curr as number;
            const p = prev as number;
            const d = fmtDelta(c, p);
            return `
              <div>
                <p style="margin:0 0 2px 0;font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(String(label))}</p>
                <p style="margin:0;font-size:20px;font-weight:600;">
                  ${c}
                  <span style="font-size:11px;font-weight:500;color:${d.color};margin-left:4px;">${d.arrow} ${escapeHtml(d.text)}</span>
                </p>
              </div>
            `;
          })
          .join("")}
      </div>

      <div style="padding:20px 0;border-bottom:1px solid #e5e5e5;">
        <p style="margin:0;font-size:13px;color:#525252;">
          <strong style="color:#171717;">${thisWeek.totalAccountsShipped}</strong> of ${thisWeek.totalAccounts} accounts shipped this period.
        </p>
      </div>

      <div style="padding:20px 0;">
        <p style="margin:0 0 12px 0;font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.04em;">By brand</p>
        ${renderBrandTable(thisWeek.byBrand, lastWeek.byBrand)}
      </div>

      <p style="margin:24px 0 0 0;font-size:11px;color:#a3a3a3;">— Hub &amp; Spoke</p>
    </div>
  `.trim();

  return { subject, text, html };
}

function renderBrandTable(
  curr: BrandScorecard[],
  prev: BrandScorecard[]
): string {
  if (curr.length === 0) {
    return `<p style="margin:0;color:#737373;font-size:13px;">No brands configured.</p>`;
  }
  const rows = curr
    .map((b) => {
      const p = prev.find((x) => x.slug === b.slug);
      const d = fmtDelta(b.originals, p?.originals ?? 0);
      const subBits = [
        b.reposts ? `${b.reposts} repost${b.reposts === 1 ? "" : "s"}` : null,
        b.crossPosts
          ? `${b.crossPosts} cross-post${b.crossPosts === 1 ? "" : "s"}`
          : null,
        b.repurposed ? `${b.repurposed} repurposed` : null,
      ].filter(Boolean) as string[];
      const goalCell = b.weeklyGoal
        ? `<span style="color:#737373;">/ ${b.weeklyGoal} goal</span>`
        : "";
      return `
        <tr>
          <td style="padding:8px 12px 8px 0;border-bottom:1px solid #f5f5f5;font-weight:500;">${escapeHtml(b.label)}</td>
          <td style="padding:8px 12px 8px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-variant-numeric:tabular-nums;">
            <span style="font-weight:600;">${b.originals}</span>
            ${goalCell}
          </td>
          <td style="padding:8px 12px 8px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-variant-numeric:tabular-nums;color:${d.color};font-weight:500;">
            ${d.arrow} ${escapeHtml(d.text)}
          </td>
          <td style="padding:8px 12px 8px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-variant-numeric:tabular-nums;color:#737373;font-size:12px;">
            ${b.accountsShipped}/${b.totalAccounts} acct
          </td>
          <td style="padding:8px 0 8px 0;border-bottom:1px solid #f5f5f5;color:#a3a3a3;font-size:12px;">
            ${escapeHtml(subBits.join(", "))}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="color:#737373;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">
          <th style="padding:0 12px 6px 0;text-align:left;font-weight:500;">Brand</th>
          <th style="padding:0 12px 6px 0;text-align:right;font-weight:500;">Originals</th>
          <th style="padding:0 12px 6px 0;text-align:right;font-weight:500;">vs prior</th>
          <th style="padding:0 12px 6px 0;text-align:right;font-weight:500;">Coverage</th>
          <th style="padding:0 0 6px 0;text-align:left;font-weight:500;">Other</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
