/**
 * Copy-paste snippets for the Developers page. Pure string builders so they
 * are easy to keep correct in a unit test. `key` is the real key right after
 * creation, otherwise the placeholder people replace.
 */
export const KEY_PLACEHOLDER = "YOUR_API_KEY";

export function curlSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return `curl "${baseUrl}/api/v1/content?brand=starter-story&limit=5" \\
  -H "Authorization: Bearer ${key}"`;
}

export function javascriptSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return `const res = await fetch("${baseUrl}/api/v1/content?brand=starter-story&limit=5", {
  headers: { Authorization: "Bearer ${key}" },
});
const { data, next_cursor } = await res.json();
for (const item of data) console.log(item.title, item.metrics.views);`;
}

export function pythonSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return `import requests

API = "${baseUrl}/api/v1"
headers = {"Authorization": "Bearer ${key}"}

items = requests.get(f"{API}/content", headers=headers,
                     params={"brand": "starter-story", "limit": 5}).json()["data"]
for item in items:
    print(item["title"], item["metrics"]["views"])

# The transcript of the first one, as plain text
first = items[0]["id"]
print(requests.get(f"{API}/content/{first}/transcript",
                   headers=headers, params={"format": "text"}).text)`;
}

export function sheetsSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return `// Google Sheets → Extensions → Apps Script. Paste, save, then put
// =HUBSPOKE_CONTENT("starter-story", 50) in a cell.
function HUBSPOKE_CONTENT(brand, limit) {
  const url = "${baseUrl}/api/v1/content?brand=" + encodeURIComponent(brand || "all") + "&limit=" + (limit || 25);
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer ${key}" } });
  const rows = JSON.parse(res.getContentText()).data;
  return [["Title", "Type", "Status", "Published", "Views", "Link"]].concat(
    rows.map(r => [r.title, r.post_type, r.status, r.published_at, r.metrics.views, r.url])
  );
}`;
}

export function mcpUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/mcp`;
}

export function claudeCodeSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return `claude mcp add --transport http hubandspoke ${mcpUrl(baseUrl)} \\
  --header "Authorization: Bearer ${key}"`;
}

export function cursorSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        hubandspoke: {
          url: mcpUrl(baseUrl),
          headers: { Authorization: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );
}

/** Claude Desktop's config only speaks stdio; mcp-remote bridges to our HTTP endpoint. */
export function claudeDesktopSnippet(baseUrl: string, key = KEY_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        hubandspoke: {
          command: "npx",
          args: ["-y", "mcp-remote", mcpUrl(baseUrl), "--header", `Authorization:Bearer ${key}`],
        },
      },
    },
    null,
    2,
  );
}

export function openApiUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/openapi.json`;
}
