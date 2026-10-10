import { describe, expect, it } from "vitest";
import type { FoundUser, Friends, Member } from "../shared/api";
import { fixture } from "./test-fixture";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
/** A member approved by the administrator and signed in, outside any project. */
async function member(f: Fixture, username: string) {
  await f.call("/register", { username, password: "test-password-1234" });
  const id = (await f.call("/admin/users", undefined, f.owner)).data.find(
    (u: { username: string }) => u.username === username,
  ).id;
  await f.call(`/admin/users/${id}/approve`, {}, f.owner);
  const cookie = (await f.call("/login", { username, password: "test-password-1234" })).cookie;
  return { id, cookie };
}
const putAvatar = async (f: Fixture, cookie: string, body: Uint8Array) => {
  const r = await fetch(`${f.app.origin}/api/me/avatar`, {
    method: "PUT",
    headers: { Origin: f.app.origin, Cookie: cookie, "Content-Type": "image/png" },
    body: new Uint8Array(body),
  });
  return { status: r.status, data: await r.json() };
};

describe("people", () => {
  it("stores a profile picture, serves it by version and removes it", async () => {
    const f = await fixture();
    expect((await f.call("/me", undefined, f.owner)).data.avatar).toBeNull();
    expect((await putAvatar(f, f.owner, new TextEncoder().encode("<svg/>"))).status).toBe(400);
    const saved = await putAvatar(f, f.owner, PNG);
    expect(saved.status).toBe(200);
    const me = (await f.call("/me", undefined, f.owner)).data;
    expect(me.avatar).toBe(saved.data.avatar);
    const image = await fetch(`${f.app.origin}/api/users/${me.id}/avatar?v=${me.avatar}`, {
      headers: { Cookie: f.owner },
    });
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    const members = (await f.call(`/projects/${f.project}/members`, undefined, f.owner))
      .data as Member[];
    expect(members[0]?.avatar).toBe(me.avatar);
    await f.call("/me/avatar", {}, f.owner, "DELETE");
    expect((await f.call("/me", undefined, f.owner)).data.avatar).toBeNull();
    const gone = await fetch(`${f.app.origin}/api/users/${me.id}/avatar`, {
      headers: { Cookie: f.owner },
    });
    expect(gone.status).toBe(404);
  });

  it("finds colleagues, makes friends both ways, and lets either side end it", async () => {
    const f = await fixture();
    const alice = await member(f, "alice");
    const bob = await member(f, "bob");
    await f.call("/register", { username: "waiting", password: "test-password-1234" });
    const found = (await f.call("/users/search?q=A", undefined, alice.cookie)).data as FoundUser[];
    // Not oneself, and not an account still waiting for approval.
    expect(found.map((u) => u.username)).toEqual([]);
    expect(
      ((await f.call("/users/search?q=bo", undefined, alice.cookie)).data as FoundUser[]).map(
        (u) => [u.username, u.relation],
      ),
    ).toEqual([["bob", "none"]]);
    expect((await f.call("/friends", { username: "waiting" }, alice.cookie)).status).toBe(404);
    expect((await f.call("/friends", { username: "alice" }, alice.cookie)).status).toBe(400);

    const asked = (await f.call("/friends", { username: "Bob" }, alice.cookie)).data as Friends;
    expect(asked.outgoing.map((p) => p.username)).toEqual(["bob"]);
    const bobView = (await f.call("/friends", undefined, bob.cookie)).data as Friends;
    expect(bobView.incoming.map((p) => p.username)).toEqual(["alice"]);
    expect(
      ((await f.call("/users/search?q=ali", undefined, bob.cookie)).data as FoundUser[])[0]
        ?.relation,
    ).toBe("incoming");
    // Asking back accepts.
    const friends = (await f.call("/friends", { username: "alice" }, bob.cookie)).data as Friends;
    expect(friends.friends.map((p) => p.username)).toEqual(["alice"]);
    expect((await f.call("/friends", { username: "bob" }, alice.cookie)).status).toBe(409);

    await f.call(`/friends/${alice.id}`, {}, bob.cookie, "DELETE");
    expect(((await f.call("/friends", undefined, alice.cookie)).data as Friends).friends).toEqual(
      [],
    );
    // Declining a request removes it too; accepting needs one to exist.
    await f.call("/friends", { username: "bob" }, alice.cookie);
    expect((await f.call(`/friends/${alice.id}/accept`, {}, bob.cookie)).status).toBe(200);
    expect((await f.call(`/friends/${bob.id}/accept`, {}, bob.cookie)).status).toBe(404);
  });

  it("lets an owner add a friend to a project directly", async () => {
    const f = await fixture();
    const carol = await member(f, "carol");
    const dave = await member(f, "dave");
    const add = (user: string, role: string, cookie = f.owner) =>
      f.call(`/projects/${f.project}/members`, { user, role }, cookie);
    expect((await add(carol.id, "editor")).status).toBe(403);
    await f.call("/friends", { username: "carol" }, f.owner);
    await f.call("/friends", { username: "owner" }, carol.cookie);
    expect((await add(carol.id, "owner")).status).toBe(400);
    expect((await add(carol.id, "editor")).status).toBe(200);
    expect((await add(carol.id, "viewer")).status).toBe(409);
    expect(
      (await f.call("/projects", undefined, carol.cookie)).data.map(
        (p: { name: string; role: string }) => [p.name, p.role],
      ),
    ).toEqual([["test-paper", "editor"]]);
    // Only owners add people.
    await f.call("/friends", { username: "dave" }, carol.cookie);
    await f.call("/friends", { username: "carol" }, dave.cookie);
    expect((await add(dave.id, "viewer", carol.cookie)).status).toBe(403);
  });
});
