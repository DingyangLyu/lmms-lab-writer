import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
    const lab = ["http://10.100.131.101", "http://writer.lab.example"];
    expect(allowedOrigin("http://10.100.131.101", lab)).toBe(true);
    expect(allowedOrigin("http://writer.lab.example", lab)).toBe(true);
    // The PC's other (wired) address, as the browser used it.
    expect(allowedOrigin("http://10.100.147.57", lab, "10.100.147.57")).toBe(true);
    expect(allowedOrigin("http://[fd00::5]:8787", lab, "[fd00::5]:8787")).toBe(true);
    // Another site, another port, or a name that could be rebound: not trusted.
    expect(allowedOrigin("http://evil.example", lab, "10.100.147.57")).toBe(false);
    expect(allowedOrigin("http://10.100.147.57:8080", lab, "10.100.147.57")).toBe(false);
    expect(allowedOrigin("http://attacker.example", lab, "attacker.example")).toBe(false);
    expect(allowedOrigin(undefined, lab, "10.100.147.57")).toBe(false);
    expect(allowedOrigin("http://localhost:8787", "http://127.0.0.1:8787")).toBe(true);
  });

  it("lets members sign in through any of the server's addresses and invites with the one in use", async () => {
    const { port, send } = await labServer("http://10.100.131.101, http://writer.lab.example");
    const wired = `10.100.147.57:${port}`;
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
    expect(invite.data.url).toMatch(new RegExp(`^http://10\\.100\\.147\\.57:${port}/\\?signup=`));
  });
});
