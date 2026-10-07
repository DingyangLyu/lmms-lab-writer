/** Suggested changes reviewed hunk by hunk and merged into the live text. */
import { mergeText, type ReviewHunk, reviewedText, reviewHunks } from "@lmms-lab/writing";
import type { Proposal } from "../../shared/api";
import { sql } from "../db";
import { created, type InProject, number, route, str } from "../http";
import { checked, fail, uid } from "../util";

type Row = Omit<Proposal, "hunks"> & { hunks: string };

export const proposalRoutes = [
  route<InProject>(
    "GET",
    /^proposals$/,
    async (ctx): Promise<Proposal[]> =>
      (
        await ctx.store.db.rows<Row>(
          sql`SELECT * FROM proposals WHERE project=${ctx.project} ORDER BY created DESC LIMIT 100`,
        )
      ).map((p) => ({ ...p, hunks: JSON.parse(p.hunks) as ReviewHunk[] })),
  ),
  route<InProject>("POST", /^proposals$/, async (ctx) => {
    await ctx.need("edit");
    const { store, project } = ctx,
      body = await ctx.body(),
      file = await store.fileMeta(project, str(body, "file"));
    if (file.binary) fail(400, "暂不支持二进制补丁");
    const base = str(body, "base", 2_000_000),
      proposed = str(body, "proposed", 2_000_000),
      id = uid();
    const hunks = checked(() => reviewHunks(base, proposed));
    await store.db.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO proposals(id, project, file, author, base, proposed, hunks, revision, created)
            VALUES(${id}, ${project}, ${file.id}, ${ctx.user.id}, ${base}, ${proposed}, ${JSON.stringify(hunks)}, 1, ${Date.now()})`,
      );
      await store.audit(project, ctx.user.id, "proposal.create", { id, file: file.id }, tx);
    });
    ctx.collab.changed(project);
    return created({ id });
  }),
  route<InProject>("POST", /^proposals\/([^/]+)\/decide$/, async (ctx, [id = ""]) => {
    await ctx.need("edit");
    const { store, collab, project } = ctx,
      body = await ctx.body(),
      p =
        (await store.db.row<Row>(
          sql`SELECT * FROM proposals WHERE project=${project} AND id=${id}`,
        )) ?? fail(404, "建议不存在");
    const revision = number(body, "revision");
    if (p.revision !== revision) fail(409, "建议已被其他人更新");
    const hunks = JSON.parse(p.hunks) as ReviewHunk[],
      part = hunks[number(body, "part")];
    if (!part) fail(400, "修改项不存在");
    const status = str(body, "status");
    if (!["pending", "accepted", "rejected"].includes(status)) fail(400, "无效决定");
    const rendered = () =>
      reviewedText(
        p.proposed,
        hunks.map((h) => ({ ...h, status: h.status === "accepted" ? "accepted" : "rejected" })),
      );
    const before = rendered();
    part.status = status as ReviewHunk["status"];
    const after = rendered(),
      current = await collab.text(project, p.file),
      merged = mergeText(before, current, after);
    if (merged.content === null)
      fail(409, "这处内容已有重叠修改；建议保留，请核对最新正文后重新提交");
    await store.snapshot(project, ctx.user.id, "审阅决定前");
    await collab.replaceMany(
      project,
      [{ file: p.file, expected: current, content: merged.content }],
      ctx.user.id,
      async (tx) => {
        // Optimistic check inside the same transaction as the text change.
        const updated = await tx.run(
          sql`UPDATE proposals SET hunks=${JSON.stringify(hunks)}, revision=revision+1
              WHERE id=${p.id} AND revision=${revision}`,
        );
        if (!updated) fail(409, "建议已被其他人更新");
        await store.audit(
          project,
          ctx.user.id,
          "proposal.decide",
          { id: p.id, part: body.part, status },
          tx,
        );
      },
    );
    return { ok: true };
  }),
];
