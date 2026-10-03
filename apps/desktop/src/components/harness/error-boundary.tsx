"use client";
import { Component, type ReactNode } from "react";
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
          <p>{this.props.name} 对话显示失败，其他对话仍可使用。</p>
          <pre className="my-3 whitespace-pre-wrap text-xs">{this.state.error}</pre>
          <button
            type="button"
            className="border border-border px-3 py-1"
            onClick={() => this.setState({ error: null })}
          >
            重新加载此对话
          </button>
        </div>
      );
    return this.props.children;
  }
}
