import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { englishMessages, requestLocale, say } from "./messages";
import { fixture } from "./test-fixture";

/** Every message a client can see: fail() templates and WebSocket close reasons. */
function serverMessages() {
  const found = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.ts$/.test(entry.name) && !/test/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/fail\(\s*\d+,\s*"([^"]+)"/g)) found.add(m[1] ?? "");
        for (const m of text.matchAll(
          /(?:closeWith\([^,]+,\s*\d+,|disconnect(?:User|Session)\([^,]+,|closeProject\([^,]+,|closeFile\([^,]+,)\s*"([^"]+)"/g,
        ))
          found.add(m[1] ?? "");
      }
    }
  };
  visit(import.meta.dirname);
  return [...found].filter((m) => /[一-鿿]/.test(m));
}

describe("server messages", () => {
  it("has English wording for every Chinese message", () => {
    const messages = serverMessages();
    expect(messages.length).toBeGreaterThan(100);
    expect(messages.filter((m) => !englishMessages[m])).toEqual([]);
  });

  it("keeps parameters when translating and picks the client's language", () => {
    expect(say("en", "无效字段 {key}", { key: "name" })).toBe("Invalid field name");
    expect(say("zh", "无效字段 {key}", { key: "name" })).toBe("无效字段 name");
    expect(requestLocale({ "x-writer-locale": "en", "accept-language": "zh-CN" })).toBe("en");
    expect(requestLocale({ "accept-language": "en-US,en;q=0.9" })).toBe("en");
    expect(requestLocale({ "accept-language": "*" })).toBe("zh");
  });

  it("answers in the language the client asks for", async () => {
    const f = await fixture();
    const login = async (locale?: string) =>
      (
        (await (
          await fetch(`${f.app.origin}/api/login`, {
            method: "POST",
            headers: {
              Origin: f.app.origin,
              "Content-Type": "application/json",
              ...(locale ? { "X-Writer-Locale": locale } : {}),
            },
            body: JSON.stringify({ username: "owner", password: "wrong-password-0000" }),
          })
        ).json()) as { error: string }
      ).error;
    expect(await login("en")).toBe("Wrong username or password");
    expect(await login()).toBe("用户名或密码错误");
  });
});
