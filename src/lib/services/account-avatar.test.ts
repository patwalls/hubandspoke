import { describe, expect, it } from "vitest";
import { isProxiedAvatar, proxiedAvatarKey } from "./account-avatar";

describe("account avatar proxy urls", () => {
  it("recognises our proxied avatars and recovers the S3 key", () => {
    const key = "hubandspoke/uploads/accounts/abc/avatar-0123456789.jpg";
    const url = `/api/media-proxy?key=${encodeURIComponent(key)}`;
    expect(isProxiedAvatar(url)).toBe(true);
    expect(proxiedAvatarKey(url)).toBe(key);
    expect(isProxiedAvatar("https://scontent.cdninstagram.com/x.jpg")).toBe(false);
    expect(proxiedAvatarKey(null)).toBeNull();
  });
});
