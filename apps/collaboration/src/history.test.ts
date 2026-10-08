import { describe, expect, it } from "vitest";
import { diffRows } from "./history";

describe("version diff", () => {
  it("marks changed lines and folds long unchanged runs", () => {
    const same = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const rows = diffRows(`${same}\nold ending\n`, `${same}\nnew ending\n`);
    expect(rows.filter((r) => r.kind === "remove").map((r) => r.text)).toEqual(["old ending"]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["new ending"]);
    expect(rows.find((r) => r.kind === "skip")?.skipped).toBe(4);
  });
});
