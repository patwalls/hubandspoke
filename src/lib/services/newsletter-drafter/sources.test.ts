import { describe, expect, it } from "vitest";
import { usesCurrentTemplate } from "./sources";

describe("usesCurrentTemplate", () => {
  const futurepedia = ["How We Did It", "Free Resource", "How We Did It (continued)", "Use Cases", "Bonus Tips"];

  it("keeps Kevin/Saj-template issues and drops the retired Step-by-Step Guide layout", () => {
    expect(usesCurrentTemplate("Claude Guide\nHow We Did It\nFree Resource\nUse Cases\nBonus Tips", futurepedia)).toBe(true);
    expect(usesCurrentTemplate("How We Did It\n💫 Level Up\nOther Use Cases\n💡 Pro Tips\n⏭️ What's Next", futurepedia)).toBe(false);
  });

  it("matches headings with emoji and punctuation, and accepts everything when the template has none", () => {
    expect(usesCurrentTemplate("THE ORANGE JUICE 🍊 ... the coffee ☕ ... The Special 🍽️", ["The Orange Juice 🍊", "The Coffee ☕", "The Special 🍽️"])).toBe(true);
    expect(usesCurrentTemplate("anything", [])).toBe(true);
  });
});

describe("extractCaseStudyText (read_case_study)", () => {
  const page = `<html><body><nav>Home Data All Ideas Login</nav>
<article class="flex-1" itemscope>
<header><h1 class="text-4xl">I Grew A Drinkware Brand To $1.1M/Month</h1></header>
<div>Dylan Jacob</div><div>$12M revenue/mo</div><div>57 Employees</div>
<script>window.x = 1</script>
<h2>Hello! Who are you?</h2><p>I'm Dylan, founder of BrüMate &amp; more.</p>
<p>Full article is available for Starter Story premium members. Unlock it.</p>
<h2>Where can we go to learn more?</h2><p>Website: www.brumate.com</p>
<h3>More Case Studies Like This</h3><p>Two Brothers Make $36M/Year Selling Air Purifiers</p>
</article><footer>Footer</footer></body></html>`;

  it("keeps the article — the data panel and every section — and drops nav, scripts, the premium note and the related-stories rail", async () => {
    const { extractCaseStudyText } = await import("./sources");
    const r = extractCaseStudyText(page)!;
    expect(r.title).toBe("I Grew A Drinkware Brand To $1.1M/Month");
    expect(r.text).toContain("$12M revenue/mo");
    expect(r.text).toContain("57 Employees");
    expect(r.text).toContain("I'm Dylan, founder of BrüMate & more.");
    expect(r.text).toContain("Website: www.brumate.com");
    expect(r.text).not.toContain("Login");
    expect(r.text).not.toContain("window.x");
    expect(r.text).not.toContain("premium members");
    expect(r.text).not.toContain("Two Brothers");
    expect(extractCaseStudyText("<html>no article</html>")).toBeNull();
  });

  it("getCaseStudy reads only starterstory.com and reports a failed fetch", async () => {
    const { getCaseStudy } = await import("./sources");
    expect(await getCaseStudy("https://evil.example/stories/x")).toEqual({ error: "Only starterstory.com case studies can be read here" });
    const ok = await getCaseStudy("https://www.starterstory.com/stories/brumate", (async () => new Response(page, { status: 200 })) as unknown as typeof fetch);
    expect(ok).toMatchObject({ title: "I Grew A Drinkware Brand To $1.1M/Month", truncated: false });
    const nf = await getCaseStudy("https://www.starterstory.com/stories/nope", (async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    expect(nf).toEqual({ error: "The page returned 404" });
  });
});


describe("isCaseStudyType (story search keeps case studies only)", () => {
  it("keeps interviews, written case studies, follow-ups, starters and breakdowns; drops blogs, roundups, guides and SEO pages", async () => {
    const { isCaseStudyType } = await import("./sources");
    for (const t of ["story", "follow_up", "starter", "breakdown"]) expect(isCaseStudyType(t)).toBe(true);
    for (const t of ["blog", "roundup", "breakdown_tools", "idea_show", "database_item", "guide", "tool_wiki", null]) expect(isCaseStudyType(t)).toBe(false);
  });
});
