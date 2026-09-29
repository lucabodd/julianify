import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function notify(message: string, kind: Toast['kind'] = 'info', timeoutMs = 4000): void {
  const toast = { id: nextId++, message, kind };
  toasts = [...toasts, toast];
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== toast.id);
    emit();
  }, timeoutMs);
}

export function notifyError(err: unknown): void {
  notify(err instanceof Error ? err.message : String(err), 'error', 6000);
}

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
