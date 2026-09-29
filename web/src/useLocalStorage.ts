import { useCallback, useState } from 'react';

/** Stato persistito nel browser (preferenze legate al dispositivo). */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed = JSON.parse(raw) as T;
      // Per gli oggetti si uniscono i valori salvati ai default (nuove chiavi comprese).
      if (typeof initial === 'object' && initial !== null && !Array.isArray(initial)) return { ...initial, ...parsed };
      return parsed;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // storage non disponibile (es. navigazione privata)
      }
    },
    [key],
  );
  return [value, set];
}
