import { describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

const password = "test-password-1234";
type Fixture = Awaited<ReturnType<typeof fixture>>;
const login = (f: Fixture, username: string) => f.call("/login", { username, password });
const register = (f: Fixture, username: string, extra: Record<string, unknown> = {}) =>
  f.call("/register", { username, password, ...extra });
const userId = async (f: Fixture, username: string) =>
  (await f.call("/admin/users", undefined, f.owner)).data.find(
    (u: { username: string }) => u.username === username,
  )?.id as string;

describe("registration and account administration", () => {
  it("keeps new registrations waiting until an administrator approves them", async () => {
    const f = await fixture();
    expect((await f.call("/registration")).data).toEqual({ mode: "approval", invite: false });
    const alice = await register(f, "alice", { note: "PhD student, optics group" });
    expect(alice.data).toEqual({ pending: true });
    expect(alice.cookie).toBe("");
    expect((await login(f, "alice")).status).toBe(403);
    expect((await f.call("/admin/summary", undefined, f.owner)).data).toEqual({ pending: 1 });
    const listed = (await f.call("/admin/users", undefined, f.owner)).data[0];
    expect(listed).toMatchObject({
      username: "alice",
      pending: true,
      note: "PhD student, optics group",
    });
    expect((await f.call(`/admin/users/${listed.id}/approve`, {}, f.owner)).status).toBe(200);
    expect((await login(f, "alice")).status).toBe(200);

    await register(f, "bob");
    const bob = await userId(f, "bob");
    expect((await f.call(`/admin/users/${bob}/reject`, {}, f.owner)).status).toBe(200);
    expect((await login(f, "bob")).status).toBe(401);
    // A rejected name is free again; an approved account cannot be "rejected".
    expect((await register(f, "bob")).data).toEqual({ pending: true });
    expect((await f.call(`/admin/users/${listed.id}/reject`, {}, f.owner)).status).toBe(409);
    const member = await login(f, "alice");
    expect((await f.call("/admin/summary", undefined, member.cookie)).status).toBe(403);
  });

  it("lets site invitations register at once, and closes or opens self-registration", async () => {
    const f = await fixture();
    expect(
      (await f.call("/admin/settings", { registration: "closed" }, f.owner, "PUT")).data,
    ).toEqual({ registration: "closed" });
    expect((await register(f, "carol")).status).toBe(403);
    const invite = (await f.call("/admin/invites", { days: 1, uses: 1, note: "lab" }, f.owner))
      .data;
    expect(invite.url).toContain(`/?signup=${invite.token}`);
    expect((await f.call(`/registration?invite=${invite.token}`)).data).toEqual({
      mode: "closed",
      invite: true,
    });
    const carol = await register(f, "carol", { invite: invite.token });
    expect(carol.data).toMatchObject({ pending: false, user: { name: "carol" } });
    expect((await f.call("/me", undefined, carol.cookie)).data.name).toBe("carol");
    expect((await register(f, "carol2", { invite: invite.token })).status).toBe(410);
    expect((await f.call("/admin/invites", undefined, f.owner)).data).toEqual([]);

    const revoked = (await f.call("/admin/invites", { days: 7, uses: 5 }, f.owner)).data;
    await f.call(`/admin/invites/${revoked.id}`, {}, f.owner, "DELETE");
    expect((await register(f, "dave", { invite: revoked.token })).status).toBe(410);
    await f.call("/admin/settings", { registration: "open" }, f.owner, "PUT");
    expect((await register(f, "dave")).data).toMatchObject({ pending: false });
  });

  it("holds new accounts from a member's project invitation for approval", async () => {
    const f = await fixture();
    // The administrator's own project invitation admits the new account directly.
    const erin = await f.invite("editor", "erin");
    expect((await f.call("/me", undefined, erin)).data.name).toBe("erin");
    const project = (await f.call("/projects", { name: "erin-paper" }, erin)).data.id;
    const token = (await f.call(`/projects/${project}/invite`, { role: "editor" }, erin)).data
      .token;
    const frank = await f.call("/join", { token, username: "frank", password });
    expect(frank.data).toEqual({ pending: true });
    expect((await login(f, "frank")).status).toBe(403);
    await f.call(`/admin/users/${await userId(f, "frank")}/approve`, {}, f.owner);
    const signedIn = await login(f, "frank");
    expect(
      (await f.call("/projects", undefined, signedIn.cookie)).data.map(
        (p: { name: string }) => p.name,
      ),
    ).toEqual(["erin-paper"]);
  });

  it("deletes accounts, handing projects they owned alone to the administrator", async () => {
    const f = await fixture();
    const erin = await f.invite("editor", "erin");
    await f.call("/projects", { name: "erin-paper" }, erin);
    const id = await userId(f, "erin");
    expect(
      (await f.call("/admin/users", undefined, f.owner)).data.find(
        (u: { id: string }) => u.id === id,
      ).soleOwned,
    ).toBe(1);
    expect(
      (await f.call(`/admin/users/${await userId(f, "owner")}`, {}, f.owner, "DELETE")).status,
    ).toBe(400);
    expect((await f.call(`/admin/users/${id}`, {}, f.owner, "DELETE")).status).toBe(409);
    expect((await f.call(`/admin/users/${id}`, { transfer: true }, f.owner, "DELETE")).status).toBe(
      200,
    );
    expect((await f.call("/me", undefined, erin)).status).toBe(401);
    expect((await login(f, "erin")).status).toBe(401);
    const mine = (await f.call("/projects", undefined, f.owner)).data;
    expect(mine.find((p: { name: string }) => p.name === "erin-paper")?.role).toBe("owner");
    expect(
      (await f.call("/admin/users", undefined, f.owner)).data.map(
        (u: { username: string }) => u.username,
      ),
    ).toEqual(["owner"]);
    // The name is free for someone new.
    expect((await register(f, "erin")).data).toEqual({ pending: true });
  });
});
