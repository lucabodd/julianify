import { useEffect, useState } from 'react';

export type Route =
  | { name: 'library' }
  | { name: 'score'; id: number }
  | { name: 'admin' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const score = /^\/score\/(\d+)/.exec(path);
  if (score) return { name: 'score', id: Number(score[1]) };
  if (path.startsWith('/admin')) return { name: 'admin' };
  return { name: 'library' };
}

export function navigate(to: string): void {
  if (window.location.hash !== `#${to}`) window.location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
