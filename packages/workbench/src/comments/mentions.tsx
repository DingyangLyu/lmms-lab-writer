/**
 * Naming people in comments with @: a text field that offers the project's members as soon as
 * "@" is typed, and comment text with the names it mentions picked out.
 */
import {
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Someone a comment can name. */
export type MentionPerson = { id: string; name: string };

/** The "@name" being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number) {
  const found = /(^|[\s(（，,。:：])@([^\s@]{0,40})$/u.exec(text.slice(0, caret));
  return found ? { query: found[2] ?? "", at: caret - (found[2] ?? "").length - 1 } : null;
}

/** People whose names start with (or else contain) the query, best first. */
export function matchPeople(people: MentionPerson[], query: string, limit = 6) {
  const q = query.toLowerCase();
  const scored = people
    .map((p) => ({ p, at: p.name.toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => Number(a.at > 0) - Number(b.at > 0) || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, limit).map((x) => x.p);
}

/** The people `text` names with @ (longest names first, so "@Ann Lee" is not "@Ann"). */
export function mentionedIn(text: string, people: MentionPerson[]) {
  const found: MentionPerson[] = [];
  let rest = text;
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const name = `@${p.name}`;
    let at = rest.indexOf(name);
    while (at >= 0) {
      if (!/[\p{L}\p{N}_.-]/u.test(rest[at + name.length] ?? "")) {
        if (!found.includes(p)) found.push(p);
        rest = rest.slice(0, at) + " ".repeat(name.length) + rest.slice(at + name.length);
      }
      at = rest.indexOf(name, at + 1);
    }
  }
  return found;
}

/** Comment text with each @name of `people` shown as a tag. */
export function WithMentions({ text, people }: { text: string; people: MentionPerson[] }) {
  if (!people.length || !text.includes("@")) return <>{text}</>;
  const names = [...people].map((p) => p.name).sort((a, b) => b.length - a.length);
  const parts: ReactNode[] = [];
  let i = 0,
    plain = "";
  while (i < text.length) {
    const name = text[i] === "@" ? names.find((n) => text.startsWith(n, i + 1)) : undefined;
    const end = name ? i + 1 + name.length : i;
    if (name && !/[\p{L}\p{N}_.-]/u.test(text[end] ?? "")) {
      if (plain) parts.push(plain);
      plain = "";
      parts.push(
        <span
          key={i}
          className="rounded-sm bg-sky-100 px-0.5 font-medium text-sky-800 dark:bg-sky-400/15 dark:text-sky-300"
        >
          @{name}
        </span>,
      );
      i = end;
    } else {
      plain += text[i];
      i++;
    }
  }
  if (plain) parts.push(plain);
  return <>{parts}</>;
}

type FieldProps = {
  value: string;
  onValue: (value: string) => void;
  people: MentionPerson[];
};

/**
 * A text field (one line, or several with `multiline`) where "@" offers the people to name.
 * Arrow keys choose, Enter or Tab takes one, Escape closes the list.
 */
export function MentionField({
  value,
  onValue,
  people,
  multiline,
  onKeyDown,
  ...rest
}: FieldProps &
  (
    | ({ multiline: true } & Omit<
        TextareaHTMLAttributes<HTMLTextAreaElement>,
        "value" | "onChange"
      >)
    | ({ multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">)
  )) {
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [open, setOpen] = useState<{ query: string; at: number } | null>(null),
    [index, setIndex] = useState(0),
    [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);
  const found = open ? matchPeople(people, open.query) : [];
  const shown = !!open && found.length > 0;
  useLayoutEffect(() => {
    if (!shown || !field.current) return setPlace(null);
    const rect = field.current.getBoundingClientRect();
    const below = rect.bottom + 4 + 30 * found.length < window.innerHeight;
    setPlace({
      left: rect.left,
      top: below ? rect.bottom + 4 : rect.top - 4 - 30 * found.length - 8,
      width: Math.min(260, Math.max(180, rect.width)),
    });
  }, [shown, found.length]);
  const look = (text: string, caret: number | null) => {
    const next = caret === null ? null : mentionQuery(text, caret);
    setOpen(next);
    setIndex(0);
  };
  const choose = (person: MentionPerson) => {
    if (!open) return;
    const caret = field.current?.selectionStart ?? value.length;
    const before = value.slice(0, open.at),
      after = value.slice(caret).replace(/^\S*/, "");
    const inserted = `@${person.name} `;
    onValue(before + inserted + after.replace(/^ /, ""));
    setOpen(null);
    requestAnimationFrame(() => {
      const at = before.length + inserted.length;
      field.current?.focus();
      field.current?.setSelectionRange(at, at);
    });
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement & HTMLInputElement>) => {
    if (shown) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + found.length) % found.length);
        return;
      }
      if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        event.preventDefault();
        const person = found[index] ?? found[0];
        if (person) choose(person);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
        return;
      }
    }
    (onKeyDown as ((event: KeyboardEvent<HTMLElement>) => void) | undefined)?.(event);
  };
  const common = {
    ref: field,
    value,
    onChange: (event: { target: HTMLTextAreaElement | HTMLInputElement }) => {
      onValue(event.target.value);
      look(event.target.value, event.target.selectionStart);
    },
    onKeyDown: keys,
    onBlur: () => setTimeout(() => setOpen(null), 150),
    onClick: (event: { currentTarget: HTMLTextAreaElement | HTMLInputElement }) =>
      look(event.currentTarget.value, event.currentTarget.selectionStart),
    "aria-autocomplete": "list" as const,
    "aria-expanded": shown,
  };
  return (
    <>
      {multiline ? (
        <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...common} />
      ) : (
        <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...common} />
      )}
      {shown && place && (
        <div
          role="listbox"
          className="fixed z-[400] overflow-hidden rounded-md border border-border bg-background py-1 text-xs text-foreground shadow-lg pop-in"
          style={{ left: place.left, top: place.top, width: place.width }}
        >
          {found.map((person, i) => (
            <button
              key={person.id}
              type="button"
              role="option"
              aria-selected={i === index}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(person)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${i === index ? "bg-accent-hover" : ""}`}
            >
              <span
                aria-hidden="true"
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
                style={{ background: personColor(person.id) }}
              >
                {person.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate">{person.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** The same colour a person's cursor has in the web editor. */
export const personColor = (id: string) =>
  `hsl(${[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360},65%,42%)`;
