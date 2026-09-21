import { describe, expect, it } from "vitest";
import { isProxiedAvatar, proxiedAvatarKey, largestAvatarVariant } from "./account-avatar";

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

describe("largestAvatarVariant", () => {
  it("asks YouTube for a 400px avatar instead of the 68px thumbnail, and leaves other URLs alone", () => {
    expect(largestAvatarVariant("https://yt3.googleusercontent.com/abc=s68-c-k-c0x00ffffff-no-rj")).toBe("https://yt3.googleusercontent.com/abc=s400-c-k-c0x00ffffff-no-rj");
    expect(largestAvatarVariant("https://scontent.cdninstagram.com/x/y.jpg?stp=dst-jpg_s150x150")).toBe("https://scontent.cdninstagram.com/x/y.jpg?stp=dst-jpg_s150x150");
  });
});
