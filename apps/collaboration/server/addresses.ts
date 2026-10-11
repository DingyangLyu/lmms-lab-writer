/**
 * WRITER_ADDRESSES: the addresses members can reach this server at, each with a name, e.g.
 * `campus=http://10.0.0.5,china=http://203.0.113.7:18089,global=https://writer.example.com`.
 * A lab server reached on campus, through a relay at home and through a domain abroad can be
 * ten milliseconds or two seconds away, so the homepage and sign-in page offer the others.
 * `campus`, `china` and `global` are named in the visitor's language; other names are shown
 * as written.
 */
import type { ServerAddress } from "../shared/api";

export function parseAddresses(value: string | undefined): ServerAddress[] {
  const addresses: ServerAddress[] = [];
  for (const entry of (value ?? "").split(",")) {
    if (!entry.trim()) continue;
    const at = entry.indexOf("="),
      name = entry.slice(0, at).trim(),
      address = entry.slice(at + 1).trim();
    let url: URL | null = null;
    try {
      url = new URL(address);
    } catch {}
    if (
      at < 1 ||
      !name ||
      !url ||
      !/^https?:$/.test(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.username
    )
      throw new Error(
        `WRITER_ADDRESSES 的 "${entry.trim()}" 应写成 名称=http(s)://地址[:端口]，多个用逗号分隔`,
      );
    addresses.push({ name, url: url.origin });
  }
  return addresses;
}
