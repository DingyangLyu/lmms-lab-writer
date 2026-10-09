"use client";

import { WarningIcon } from "@phosphor-icons/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { workbenchI18n as i18n } from "./i18n";

type Props = {
  children: ReactNode;
  onReset?: () => void;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

export class EditorErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Editor Component Error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center">
          <div className="size-12 border border-border flex items-center justify-center mb-4">
            <WarningIcon className="size-6 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium text-foreground mb-1">
            {i18n.t("ui.editorComponentError")}
          </h3>
          <p className="text-xs text-muted mb-4 max-w-[200px]">
            {this.state.error?.message || i18n.t("ui.anUnexpectedErrorOccurred")}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            className="px-3 py-1.5 text-xs border border-foreground bg-background hover:bg-accent-hover transition-colors"
            style={{ boxShadow: "2px 2px 0 0 var(--foreground)" }}
          >
            {i18n.t("ui.tryAgain")}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
