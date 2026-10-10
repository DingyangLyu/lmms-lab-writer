import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installer } from "./routes/downloads";
import { fixture } from "./test-fixture";

describe("desktop downloads", () => {
  it("names each release file's platform and processor", () => {
    expect(installer("Y-Writer_0.2.0_aarch64.pkg")).toEqual({
      platform: "macos",
      kind: "pkg",
      arch: "arm64",
    });
    expect(installer("Y-Writer_0.2.0_x64-setup.exe")).toMatchObject({ platform: "windows" });
    expect(installer("Y-Writer_0.2.0_amd64.AppImage")).toMatchObject({ arch: "x64" });
    expect(installer("Y-Writer-0.2.0-1.x86_64.rpm")).toMatchObject({ kind: "rpm", arch: "x64" });
    expect(installer("latest.json")).toBeNull();
    expect(installer("../secret.dmg")).toBeNull();
  });

  it("lists the installers to members and sends them, in ranges too", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "writer-downloads-")), "downloads");
    await mkdir(dir);
    await writeFile(join(dir, "Y-Writer_0.2.0_aarch64.dmg"), "0123456789");
    await writeFile(join(dir, "Y-Writer_0.2.0_x64-setup.exe"), "windows");
    await writeFile(join(dir, "Y-Writer_0.2.0_aarch64.dmg.sig"), "signature");
    await writeFile(join(dir, "Y-Writer-0.2.0-1.x86_64.rpm"), "linux");
    const f = await fixture({ downloadsDirectory: dir });

    expect((await f.call("/downloads")).status).toBe(401);
    const { data } = await f.call("/downloads", undefined, f.owner);
    expect(data.version).toBe("0.2.0");
    expect(data.installers.map((i: { name: string }) => i.name)).toEqual([
      "Y-Writer-0.2.0-1.x86_64.rpm",
      "Y-Writer_0.2.0_aarch64.dmg",
      "Y-Writer_0.2.0_x64-setup.exe",
    ]);
    expect(data.installers[1]).toMatchObject({ platform: "macos", arch: "arm64", bytes: 10 });

    const url = `${f.app.origin}/api/downloads/Y-Writer_0.2.0_aarch64.dmg`;
    const whole = await fetch(url, { headers: { Cookie: f.owner } });
    expect(whole.headers.get("content-disposition")).toContain("Y-Writer_0.2.0_aarch64.dmg");
    expect(await whole.text()).toBe("0123456789");
    const part = await fetch(url, { headers: { Cookie: f.owner, Range: "bytes=4-" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(await part.text()).toBe("456789");
    for (const name of ["Y-Writer_0.2.0_aarch64.dmg.sig", "..%2Fpasswd.dmg", "missing.dmg"])
      expect(
        (await fetch(`${f.app.origin}/api/downloads/${name}`, { headers: { Cookie: f.owner } }))
          .status,
      ).toBe(404);
    expect((await fetch(url)).status).toBe(401);
  });

  it("lists nothing when no folder is set up", async () => {
    const f = await fixture({ downloadsDirectory: join(tmpdir(), "writer-no-such-folder") });
    expect((await f.call("/downloads", undefined, f.owner)).data).toEqual({
      version: null,
      installers: [],
    });
  });
});
