import { useState } from "react";

/** Anyone with a picture: a user, a member, a friend or a project's owner. */
export type Pictured = { id: string; name: string; avatar: number | null | undefined };

/** The same hue for a person everywhere, as their cursor in the editor has. */
export const personHue = (id: string) => [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;

/** A person's picture, or the first letter of their name on a colour of their own. */
export function Avatar({ person, size = 28 }: { person: Pictured; size?: number }) {
  const [broken, setBroken] = useState<number | null>(null);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (person.avatar && broken !== person.avatar)
    return (
      <img
        className="avatar"
        src={`/api/users/${encodeURIComponent(person.id)}/avatar?v=${person.avatar}`}
        alt=""
        aria-hidden="true"
        style={style}
        onError={() => setBroken(person.avatar ?? null)}
      />
    );
  const initial = [...person.name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      className="avatar avatar-initial"
      aria-hidden="true"
      style={{ ...style, background: `hsl(${personHue(person.id)} 45% 42%)` }}
    >
      {initial}
    </span>
  );
}
