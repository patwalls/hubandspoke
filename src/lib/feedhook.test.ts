import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyFeedhookSignature } from "./feedhook";

const SECRET = "shared-secret-0123456789abcdef";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("verifyFeedhookSignature", () => {
  const body = JSON.stringify({ event: "post.published", postId: "1" });

  it("accepts a correctly signed raw body", () => {
    expect(
      verifyFeedhookSignature({ rawBody: body, signatureHeader: sign(body), secret: SECRET })
    ).toBe(true);
  });

  it("rejects a signature from a different secret", () => {
    expect(
      verifyFeedhookSignature({ rawBody: body, signatureHeader: sign(body, "wrong-secret-0123456789"), secret: SECRET })
    ).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    expect(
      verifyFeedhookSignature({ rawBody: body + " ", signatureHeader: sign(body), secret: SECRET })
    ).toBe(false);
  });

  it("rejects missing, malformed, and wrong-prefix headers", () => {
    expect(verifyFeedhookSignature({ rawBody: body, signatureHeader: null, secret: SECRET })).toBe(false);
    expect(verifyFeedhookSignature({ rawBody: body, signatureHeader: "sha1=abc", secret: SECRET })).toBe(false);
    expect(verifyFeedhookSignature({ rawBody: body, signatureHeader: "sha256=nothex", secret: SECRET })).toBe(false);
  });
});
