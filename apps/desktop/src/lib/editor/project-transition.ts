type ProjectTransitionActions = {
  current: string | null;
  choose: () => Promise<string | null>;
  confirm: () => Promise<boolean>;
  freeze: (active: boolean) => void;
  save: () => Promise<void>;
  open: (path: string) => Promise<void>;
  reset: () => void;
};

/** One picker/transition at a time; never clear buffers before both save and open succeed. */
export class ProjectTransition {
  active = false;

  async run(actions: ProjectTransitionActions): Promise<string | null> {
    if (this.active) return null;
    this.active = true;
    try {
      const path = await actions.choose();
      if (!path || path === actions.current || !(await actions.confirm())) return null;
      actions.freeze(true);
      await actions.save();
      await actions.open(path);
      actions.reset();
      return path;
    } finally {
      actions.freeze(false);
      this.active = false;
    }
  }
}

/** Validate/read first. A missing or unreadable destination cannot replace the active root. */
export async function prepareProject<T>(
  path: string,
  read: (path: string) => Promise<T>,
  activate: (path: string) => Promise<unknown>,
): Promise<T> {
  const prepared = await read(path);
  await activate(path);
  return prepared;
}
