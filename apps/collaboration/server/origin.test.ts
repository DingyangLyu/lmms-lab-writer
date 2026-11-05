import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseAddresses } from "./addresses";
import { createWriterServer } from "./app";
import { allowedOrigin } from "./auth";

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
/** A server configured for the lab's addresses; requests still go to 127.0.0.1. */
async function labServer(origin: string) {
  const app = await createWriterServer({
    databaseUrl: "pglite:memory",
    port: 0,
    origin,
    adminUser: "owner",
    adminPassword: "test-password-1234",
  });
  servers.push(app);
  const port = (app.server.address() as { port: number }).port;
  const send = (path: string, headers: Record<string, string>, body: unknown) =>
    new Promise<{ status: number; data: Record<string, unknown>; cookie: string }>(
      (resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: `/api${path}`,
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                data: text ? JSON.parse(text) : {},
                cookie: String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      },
    );
  return { port, send };
}

describe("request origins", () => {
  it("trusts the configured origins and same-origin pages opened by IP address", () => {
    const lab = ["http://192.168.1.20", "http://writer.lab.example"];
    expect(allowedOrigin("http://192.168.1.20", lab)).toBe(true);
    expect(allowedOrigin("http://writer.lab.example", lab)).toBe(true);
    // The PC's other (wired) address, as the browser used it.
    expect(allowedOrigin("http://192.168.1.57", lab, "192.168.1.57")).toBe(true);
    expect(allowedOrigin("http://[fd00::5]:8787", lab, "[fd00::5]:8787")).toBe(true);
    // Another site, another port, or a name that could be rebound: not trusted.
    expect(allowedOrigin("http://evil.example", lab, "192.168.1.57")).toBe(false);
    expect(allowedOrigin("http://192.168.1.57:8080", lab, "192.168.1.57")).toBe(false);
    expect(allowedOrigin("http://attacker.example", lab, "attacker.example")).toBe(false);
    expect(allowedOrigin(undefined, lab, "192.168.1.57")).toBe(false);
    expect(allowedOrigin("http://localhost:8787", "http://127.0.0.1:8787")).toBe(true);
  });

  it("lets members sign in through any of the server's addresses and invites with the one in use", async () => {
    const { port, send } = await labServer("http://192.168.1.20, http://writer.lab.example");
    const wired = `192.168.1.57:${port}`;
    const wrong = { username: "owner", password: "wrong-password-0000" };
    // 401: the origin check passed and the password was wrong.
    expect(
      (
        await send(
          "/login",
          { Host: "writer.lab.example", Origin: "http://writer.lab.example" },
          wrong,
        )
      ).status,
    ).toBe(401);
    expect((await send("/login", { Host: wired, Origin: `http://${wired}` }, wrong)).status).toBe(
      401,
    );
    expect(
      (await send("/login", { Host: wired, Origin: "http://evil.example" }, wrong)).status,
    ).toBe(403);
    expect(
      (await send("/login", { Host: "rebound.example", Origin: "http://rebound.example" }, wrong))
        .status,
    ).toBe(403);

    const signedIn = await send(
      "/login",
      { Host: wired, Origin: `http://${wired}` },
      { username: "owner", password: "test-password-1234" },
    );
    expect(signedIn.status).toBe(200);
    const invite = await send(
      "/admin/invites",
      { Host: wired, Origin: `http://${wired}`, Cookie: signedIn.cookie },
      { days: 1, uses: 1 },
    );
    expect(invite.data.url).toMatch(new RegExp(`^http://192\\.168\\.1\\.57:${port}/\\?signup=`));
  });

  it("offers visitors the server's named addresses", async () => {
    expect(
      parseAddresses(" campus=http://192.168.1.57, china=http://203.0.113.10:18089/ ,"),
    ).toEqual([
      { name: "campus", url: "http://192.168.1.57" },
      { name: "china", url: "http://203.0.113.10:18089" },
    ]);
    expect(parseAddresses(undefined)).toEqual([]);
    for (const wrong of [
      "http://192.168.1.57",
      "=http://192.168.1.57",
      "lab=ftp://192.168.1.57",
      "lab=https://writer.example.com/app",
      "lab=writer.example.com",
    ])
      expect(() => parseAddresses(wrong), wrong).toThrow(/WRITER_ADDRESSES/);

    const app = await createWriterServer({
      databaseUrl: "pglite:memory",
      port: 0,
      origin: "https://writer.example.com,http://192.168.1.57",
      addresses: "global=https://writer.example.com,campus=http://192.168.1.57",
      adminUser: "owner",
      adminPassword: "test-password-1234",
    });
    servers.push(app);
    const port = (app.server.address() as { port: number }).port;
    // Asked before signing in, by the homepage.
    const response = await fetch(`http://127.0.0.1:${port}/api/addresses`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { name: "global", url: "https://writer.example.com" },
      { name: "campus", url: "http://192.168.1.57" },
    ]);
  });
});
