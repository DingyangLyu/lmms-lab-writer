/**
 * AI conversations on the server a folder is linked to: the workbench's relay link, over the
 * socket the Rust side opens with this computer's device token.
 */
import { AgentLink } from "@lmms-lab/workbench/agents";
import { desktopTransport } from "./transport";

export function desktopAgentLink(server: string, project: string, me: string) {
  const transport = desktopTransport(server);
  return new AgentLink(
    (events) => transport.connect(`/api/projects/${project}/agents`, events),
    me,
  );
}
