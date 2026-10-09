/** How new accounts come in: self-registration awaiting approval (default), open, or closed. */
import { type Sql, sql } from "./db";

export type RegistrationMode = "approval" | "open" | "closed";
export const registrationModes: RegistrationMode[] = ["approval", "open", "closed"];

export async function registrationMode(db: Sql): Promise<RegistrationMode> {
  const row = await db.row<{ value: string }>(
    sql`SELECT value FROM settings WHERE key='registration'`,
  );
  return registrationModes.find((mode) => mode === row?.value) ?? "approval";
}

export async function setRegistrationMode(db: Sql, mode: RegistrationMode) {
  await db.run(
    sql`INSERT INTO settings(key, value) VALUES('registration', ${mode})
        ON CONFLICT (key) DO UPDATE SET value=${mode}`,
  );
}

/** A site invitation that can still register an account. */
export const usableInvite = (token: string, now = Date.now()) =>
  sql`SELECT id FROM signup_invites WHERE token=${token} AND NOT revoked AND used<uses AND expires>${now}`;
