/** Shared by the moving pictures on the homepage and the sign-in page. */

/** The clock step at which line `line` of `source` is fully typed, one character a step. */
export const typedBy = (source: readonly string[], line: number) =>
  source.slice(0, line + 1).join("\n").length;

/**
 * The column a colleague's cursor stands at `t` steps after it arrives: it waits at each stop
 * for that stop's hold, then moves one character every `pace` steps to the next stop, as arrow
 * keys move a real cursor, never gliding between characters.
 */
export function walk(
  stops: ReadonlyArray<readonly [column: number, hold: number]>,
  t: number,
  pace = 3,
) {
  let column = stops[0]?.[0] ?? 0,
    left = t;
  for (const [index, [, hold]] of stops.entries()) {
    if (left < hold) return column;
    left -= hold;
    const next = stops[index + 1]?.[0];
    if (next === undefined) return column;
    const distance = Math.abs(next - column),
      steps = Math.floor(left / pace);
    if (steps < distance) return column + Math.sign(next - column) * steps;
    left -= distance * pace;
    column = next;
  }
  return column;
}
