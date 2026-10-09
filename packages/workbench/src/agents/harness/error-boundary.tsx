"use client";
import { Component, type ReactNode } from "react";
import { workbenchI18n as i18n } from "../../i18n";
export class HarnessErrorBoundary extends Component<
  { name: string; children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <div role="alert" className="p-4 text-sm">
          <p>
            {i18n.t("chat.theNameConversationCouldNotBeShownOtherC", { name: this.props.name })}
          </p>
          <pre className="my-3 whitespace-pre-wrap text-xs">{this.state.error}</pre>
          <button
            type="button"
            className="border border-border px-3 py-1"
            onClick={() => this.setState({ error: null })}
          >
            {i18n.t("chat.reloadThisConversation")}
          </button>
        </div>
      );
    return this.props.children;
  }
}
