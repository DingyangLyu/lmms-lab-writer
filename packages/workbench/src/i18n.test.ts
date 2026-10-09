import { dictionaryProblems } from "@lmms-lab/i18n";
import { expect, it } from "vitest";
import * as messages from "./i18n";

it("defines every workbench text in both languages with the same placeholders", () => {
  expect(Object.keys(messages.workbenchZh).length).toBeGreaterThan(50);
  expect(dictionaryProblems({ "i18n.tsx": messages })).toEqual([]);
});
