import { describe, expect, it } from "vitest";
import { sentryPrivacyOptions, scrubEvent, scrubValue, isPiiKey } from "./sentry-privacy";

// The no-user-data guarantee for error reporting (2026-11-05, sentry.io ->
// self-hosted GlitchTip). Feeds the shape the SDK actually builds — what the
// old setSentrySessionUser + sendDefaultPii:true put on the wire — through the
// exact hooks every Sentry.init spreads in, and checks the serialized payload.
const EMAIL = "jane.editor@example.com";
const IP = "203.0.113.77";

function leakyErrorEvent() {
  return {
    event_id: "abc",
    user: { id: "u-1", email: EMAIL, username: "Jane Editor", ip_address: IP },
    message: `could not notify ${EMAIL}`,
    extra: { recipient: { email: EMAIL }, note: `from ${IP}`, attempts: 3 },
    tags: { task: "send-digest", userEmail: EMAIL },
    contexts: {
      runtime: { name: "node", version: "v22" },
      account: { fullName: "Jane Editor", plan: "pro" },
    },
    request: {
      url: `https://hubandspoke.example/api/invite?email=${encodeURIComponent(EMAIL)}`,
      method: "POST",
      query_string: `email=${EMAIL}`,
      cookies: { "authjs.session-token": "sess-secret-123" },
      data: { email: EMAIL, password: "hunter22" },
      env: { REMOTE_ADDR: IP },
      headers: {
        Cookie: "authjs.session-token=sess-secret-123",
        Authorization: "Bearer live-token-xyz",
        "X-Forwarded-For": IP,
        "User-Agent": "Mozilla/5.0 Jane",
        "Content-Type": "application/json",
      },
    },
    breadcrumbs: [
      { category: "fetch", message: `GET /users?email=${EMAIL}`, data: { url: `/users?email=${EMAIL}`, status_code: 200 } },
    ],
    exception: {
      values: [{
        type: "Error",
        value: `duplicate key (email)=(${EMAIL}) from ${IP}`,
        // What @sentry/node's ContextLines integration attaches — found leaking
        // the literals of a live test event on 2026-11-05.
        stacktrace: {
          frames: [{
            filename: "/app/src/lib/invite.ts",
            lineno: 12,
            pre_context: [`const who = "${EMAIL}";`],
            context_line: `throw new Error("dup " + "${IP}");`,
            post_context: [`// Jane Editor`],
            vars: { email: EMAIL, attempt: 2 },
          }],
        },
      }],
    },
  };
}

function leakyTransaction() {
  return {
    type: "transaction",
    transaction: "POST /api/invite",
    user: { email: EMAIL },
    spans: [
      { op: "db", description: `select * from users where email = '${EMAIL}'` },
      { op: "http.client", description: `GET https://api.example.com/lookup?email=${EMAIL}`, data: { "client.address": IP } },
    ],
  };
}

const LEAKS = [EMAIL, IP, "sess-secret-123", "live-token-xyz", "hunter22", "Jane Editor", "Mozilla/5.0 Jane"];

describe("sentry privacy scrubber", () => {
  it("control: the raw event DOES carry user data (the assertions can see a leak)", () => {
    const json = JSON.stringify(leakyErrorEvent());
    for (const leak of LEAKS) expect(json).toContain(leak);
  });

  it("an error event through beforeSend carries no email, IP, cookie, token, password or name", () => {
    const out = sentryPrivacyOptions.beforeSend(leakyErrorEvent());
    const json = JSON.stringify(out);
    for (const leak of LEAKS) expect(json).not.toContain(leak);
    expect(out.user).toBeUndefined();
  });

  it("keeps what a fix needs: route without query, safe headers, redacted message, plain extras", () => {
    const out = scrubEvent(leakyErrorEvent());
    expect(out.request.url).toBe("https://hubandspoke.example/api/invite");
    expect(out.request.method).toBe("POST");
    expect(Object.keys(out.request.headers)).toEqual(["Content-Type"]);
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.data).toBeUndefined();
    expect(out.exception.values[0].value).toBe("duplicate key (email)=([email]) from [ip]");
    expect(out.exception.values[0].stacktrace.frames[0]).toEqual({
      filename: "/app/src/lib/invite.ts",
      lineno: 12,
      vars: { email: "[filtered]", attempt: 2 },
    });
    expect(out.extra.attempts).toBe(3);
    expect(out.tags.task).toBe("send-digest");
    expect(out.contexts.runtime).toEqual({ name: "node", version: "v22" });
    expect(out.contexts.account).toEqual({ fullName: "[filtered]", plan: "pro" });
    expect(out.breadcrumbs[0].data).toEqual({ url: "/users", status_code: 200 });
  });

  it("a transaction through beforeSendTransaction redacts span SQL/URLs and drops the user", () => {
    const out = sentryPrivacyOptions.beforeSendTransaction(leakyTransaction());
    const json = JSON.stringify(out);
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain(IP);
    expect(out.spans[0].description).toBe("select * from users where email = '[email]'");
    expect(out.user).toBeUndefined();
  });

  it("beforeBreadcrumb redacts at record time too", () => {
    const crumb = sentryPrivacyOptions.beforeBreadcrumb({ message: `login ${EMAIL}`, data: { email: EMAIL, n: 1 } });
    expect(crumb).toEqual({ message: "login [email]", data: { email: "[filtered]", n: 1 } });
  });

  it("turns off default PII and log shipping", () => {
    expect(sentryPrivacyOptions.sendDefaultPii).toBe(false);
    expect(sentryPrivacyOptions.enableLogs).toBe(false);
  });

  it("filters PII keys in any casing, and leaves ordinary keys alone", () => {
    for (const k of ["email", "userEmail", "ip_address", "ipAddress", "billing_address", "phoneNumber", "authjs.session-token", "client.address"]) {
      expect(isPiiKey(k), k).toBe(true);
    }
    for (const k of ["task", "status_code", "plan", "attempts", "brand", "contentId", "formatId"]) {
      expect(isPiiKey(k), k).toBe(false);
    }
    expect(scrubValue({ items: [{ email: EMAIL, sku: "A1" }] })).toEqual({ items: [{ email: "[filtered]", sku: "A1" }] });
  });
});
