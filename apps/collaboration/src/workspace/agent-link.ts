/**
 * The browser's socket to the server's AI relay; the link and the backends over it are the
 * workbench's (@lmms-lab/workbench/agents relay), which the desktop uses too.
 */
import { AgentLink, type OpenRelaySocket } from "@lmms-lab/workbench/agents";

/** One socket per open project, in the browser's own session. */
export function webAgentLink(project: string, me: string, locale: () => string) {
  const open: OpenRelaySocket = (events) => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/projects/${project}/agents?locale=${locale()}`,
    );
    socket.onmessage = (message) => events.message(String(message.data));
    socket.onclose = (event) => events.close(event.code, event.reason);
    return { send: (data) => socket.send(data), close: () => socket.close() };
  };
  return new AgentLink(open, me);
}
