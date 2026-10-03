type ComposerKey = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
};

export function shouldSendOnEnter(event: ComposerKey, compositionPending: boolean): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !compositionPending &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}
