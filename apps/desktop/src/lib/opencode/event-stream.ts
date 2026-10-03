// Share one SSE socket per server/project. Many mounted conversations otherwise
// exhaust the browser's per-origin HTTP connection limit and stall API requests.
type Stream = Pick<EventSource, "onopen" | "onmessage" | "onerror" | "close">;
type Entry = { source: EventSource; clients: Set<Stream> };
const streams = new Map<string, Entry>();
export function openEventStream(url: string): Stream {
  let entry = streams.get(url);
  if (!entry || entry.source.readyState === EventSource.CLOSED) {
    const source = new EventSource(url);
    entry = { source, clients: new Set() };
    const current = entry;
    source.onopen = (event) => {
      for (const client of [...current.clients]) client.onopen?.call(source, event);
    };
    source.onmessage = (event) => {
      for (const client of [...current.clients]) client.onmessage?.call(source, event);
    };
    source.onerror = (event) => {
      for (const client of [...current.clients]) client.onerror?.call(source, event);
    };
    streams.set(url, entry);
  }
  const current = entry;
  let closed = false;
  const client: Stream = {
    onopen: null,
    onmessage: null,
    onerror: null,
    close: () => {
      if (closed) return;
      closed = true;
      current.clients.delete(client);
      if (!current.clients.size) {
        current.source.close();
        if (streams.get(url) === current) streams.delete(url);
      }
    },
  };
  current.clients.add(client);
  if (current.source.readyState === EventSource.OPEN)
    queueMicrotask(() => {
      if (current.clients.has(client)) client.onopen?.call(current.source, new Event("open"));
    });
  return client;
}
