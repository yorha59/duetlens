/** 行号只影响文件头的编辑器操作,不应让整份 diff 重新渲染并计算高亮。 */
export class EditorLineStore {
  private selected: { path: string; line: number } | null = null;
  private listeners = new Map<string, Set<() => void>>();

  get(path: string): number | null {
    return this.selected?.path === path ? this.selected.line : null;
  }

  subscribe(path: string, listener: () => void): () => void {
    let listeners = this.listeners.get(path);
    if (!listeners) this.listeners.set(path, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(path);
    };
  }

  select(next: { path: string; line: number } | null): void {
    const previous = this.selected;
    if (previous?.path === next?.path && previous?.line === next?.line) return;
    this.selected = next;
    const changed = new Set([previous?.path, next?.path]);
    for (const path of changed) {
      if (path) this.listeners.get(path)?.forEach((listener) => listener());
    }
  }
}
