import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type Argument = "reference" | "environment" | null;
type State = { pending: Argument; argument: Argument; optionDepth: number; mathEnd: string | null };

export const latexLanguage = StreamLanguage.define<State>({
  name: "latex",
  startState: () => ({ pending: null, argument: null, optionDepth: 0, mathEnd: null }),
  languageData: { commentTokens: { line: "%" }, closeBrackets: { brackets: ["(", "[", "{"] } },
  tokenTable: { reference: tags.labelName, environment: tags.typeName, math: tags.string },
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^%.*/)) return "comment";
    if (state.mathEnd) {
      if (stream.match(state.mathEnd)) {
        state.mathEnd = null;
        return "math";
      }
      if (stream.match(/^\\[a-zA-Z@]+/)) return "keyword";
      if (stream.match(/^\\./)) return "escape";
      if (stream.match(/^[=+*/^_<>-]+/)) return "operator";
      stream.next();
      return "math";
    }
    if (state.argument) {
      if (stream.eat("}")) {
        state.argument = null;
        return "bracket";
      }
      if (stream.match(/^\\./)) return "escape";
      if (stream.eat(",")) return "bracket";
      stream.match(/^[^}%\\,]+/) || stream.next();
      return state.argument;
    }
    if (state.pending) {
      if (stream.eat("[")) {
        state.optionDepth++;
        return "bracket";
      }
      if (state.optionDepth) {
        if (stream.eat("]")) {
          state.optionDepth--;
          return "bracket";
        }
        if (stream.match(/^\\[a-zA-Z@]+/)) return "keyword";
        stream.next();
        return null;
      }
      if (stream.eat("{")) {
        state.argument = state.pending;
        state.pending = null;
        return "bracket";
      }
      state.pending = null;
    }
    if (stream.match("$$")) {
      state.mathEnd = "$$";
      return "math";
    }
    if (stream.match("$")) {
      state.mathEnd = "$";
      return "math";
    }
    if (stream.match("\\[")) {
      state.mathEnd = "\\]";
      return "math";
    }
    if (stream.match("\\(")) {
      state.mathEnd = "\\)";
      return "math";
    }
    const command = stream.match(/^\\([a-zA-Z@]+)\*?/) as RegExpMatchArray | null;
    if (command) {
      const name = command[1] ?? "";
      if (name === "begin" || name === "end") state.pending = "environment";
      else if (
        /^(?:[Cc]ite\w*|nocite|autocite|parencite|textcite|footcite|supercite|smartcite|fullcite|ref|pageref|eqref|label)$/.test(
          name,
        )
      )
        state.pending = "reference";
      else if (name === "verb") {
        const delimiter = stream.next();
        if (delimiter && stream.skipTo(delimiter)) stream.next();
        else stream.skipToEnd();
        return "string";
      }
      return "keyword";
    }
    if (stream.match("\\\\") || stream.eat("&")) return "keyword";
    if (stream.match(/^\\./) || stream.match(/^#[1-9]/)) return "escape";
    if (stream.match(/^[{}[\]]/)) return "bracket";
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return "number";
    stream.match(/^[^\\%$&{}[\]\d]+/) || stream.next();
    return null;
  },
});

export function latexHighlighting(dark: boolean) {
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: dark ? "#9cc3f5" : "#0000a2" },
      { tag: tags.comment, color: dark ? "#8bae96" : "#4c886b" },
      { tag: [tags.labelName, tags.typeName], color: dark ? "#77bdc5" : "#318495" },
      { tag: tags.bracket, color: dark ? "#9ba8b4" : "#687687" },
      { tag: tags.string, color: dark ? "#a9c788" : "#036a07" },
      { tag: [tags.number, tags.operator, tags.escape], color: dark ? "#c7a5db" : "#833fba" },
    ]),
  );
}
