import { describe, expect, test } from "vitest";
import { PROXY_FORMAT, normalizeProxy } from "@bap/protocol";

describe("a proxy written any common way becomes the one form ls-clicker takes", () => {
  test.each([
    ["1.2.3.4:1080", "1.2.3.4:1080"],
    [" 1.2.3.4:1080 ", "1.2.3.4:1080"],
    ["1.2.3.4:1080@user:pa:ss", "1.2.3.4:1080@user:pa:ss"],
    ["user:pass@1.2.3.4:1080", "1.2.3.4:1080@user:pass"],
    ["1.2.3.4:1080:user:pass", "1.2.3.4:1080@user:pass"],
    ["user:pass:1.2.3.4:1080", "1.2.3.4:1080@user:pass"],
    ["socks5://user:pass@1.2.3.4:1080", "1.2.3.4:1080@user:pass"],
    ["socks5h://1.2.3.4:1080", "1.2.3.4:1080"],
    ["http://user:pass@proxy.example.com:8080/", "http://proxy.example.com:8080@user:pass"],
    ["HTTPS://1.2.3.4:3128", "http://1.2.3.4:3128"],
    ["ssh://1.2.3.4:22:root:pw", "ssh://1.2.3.4:22@root:pw"],
    ["1.2.3.4 1080 user pass", "1.2.3.4:1080@user:pass"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeProxy(input)).toBe(expected);
    expect(PROXY_FORMAT.test(expected)).toBe(true);
  });

  test.each(["", "1.2.3.4", "1.2.3.4:99999", "ftp://1.2.3.4:21", "1.2.3.4:1080@user", "a b:c", "1.2.3.4:1080:user"])("%j is not a proxy", (input) => {
    expect(normalizeProxy(input)).toBeNull();
  });
});
