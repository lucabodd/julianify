import type {
  Annotation,
  AnnotationInput,
  AudioTrack,
  FlatSyncPoint,
  LibraryListing,
  SavedLoop,
  SavedLoopInput,
  ScoreDetail,
  ScorePrefs,
  ScoreSummary,
  ServerInfo,
  User,
  WaveformPeaks,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Notifica quando la sessione scade (401) per tornare al login. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Julianify': '1' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', ...init });
  if (!res.ok) {
    let message = `Errore ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // risposta non JSON
    }
    if (res.status === 401 && !url.endsWith('/auth/login')) unauthorizedListeners.forEach((l) => l());
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Upload con avanzamento (fetch non espone il progresso di invio). */
function upload<T>(url: string, form: FormData, onProgress?: (fraction: number) => void, method = 'POST'): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('X-Julianify', '1');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
      else {
        if (xhr.status === 401) unauthorizedListeners.forEach((l) => l());
        reject(new ApiError(xhr.status, xhr.response?.error ?? `Errore ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Errore di rete durante il caricamento'));
    xhr.send(form);
  });
}

export const api = {
  me: () => request<{ user: User }>('GET', '/api/auth/me').then((r) => r.user),
  login: (username: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/login', { username, password }).then((r) => r.user),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('POST', '/api/auth/password', { currentPassword, newPassword }),
  info: () => request<ServerInfo>('GET', '/api/info'),

  listUsers: () => request<{ users: User[] }>('GET', '/api/users').then((r) => r.users),
  createUser: (data: { username: string; password: string; displayName?: string; isAdmin?: boolean }) =>
    request<{ user: User }>('POST', '/api/users', data).then((r) => r.user),
  updateUser: (id: number, data: Partial<{ displayName: string | null; isAdmin: boolean; isEnabled: boolean; password: string }>) =>
    request<{ user: User }>('PATCH', `/api/users/${id}`, data).then((r) => r.user),
  deleteUser: (id: number) => request<{ ok: boolean }>('DELETE', `/api/users/${id}`),

  listScores: () => request<{ scores: ScoreSummary[] }>('GET', '/api/scores').then((r) => r.scores),
  getScore: (id: number) => request<{ score: ScoreDetail }>('GET', `/api/scores/${id}`).then((r) => r.score),
  uploadScore: (file: File, meta: { title?: string; artist?: string; album?: string }, onProgress?: (f: number) => void) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(meta)) if (v) form.append(k, v);
    form.append('file', file);
    return upload<{ score: ScoreDetail }>('/api/scores', form, onProgress).then((r) => r.score);
  },
  replaceScoreFile: (id: number, file: File, onProgress?: (f: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    return upload<{ score: ScoreDetail }>(`/api/scores/${id}/file`, form, onProgress, 'PUT').then((r) => r.score);
  },
  updateScore: (id: number, data: Partial<{ title: string; artist: string | null; album: string | null; shared: boolean }>) =>
    request<{ score: ScoreDetail }>('PATCH', `/api/scores/${id}`, data).then((r) => r.score),
  deleteScore: (id: number) => request<{ ok: boolean }>('DELETE', `/api/scores/${id}`),
  scoreFileUrl: (id: number) => `/api/scores/${id}/file`,
  getPrefs: (id: number) => request<{ prefs: ScorePrefs }>('GET', `/api/scores/${id}/prefs`).then((r) => r.prefs),
  savePrefs: (id: number, prefs: ScorePrefs) =>
    request<{ prefs: ScorePrefs }>('PUT', `/api/scores/${id}/prefs`, prefs).then((r) => r.prefs),

  uploadAudio: (scoreId: number, file: File, name: string | undefined, onProgress?: (f: number) => void) => {
    const form = new FormData();
    if (name) form.append('name', name);
    form.append('file', file);
    return upload<{ audio: AudioTrack }>(`/api/scores/${scoreId}/audio`, form, onProgress).then((r) => r.audio);
  },
  linkLibraryAudio: (scoreId: number, path: string, name?: string) =>
    request<{ audio: AudioTrack }>('POST', `/api/scores/${scoreId}/audio/library`, { path, name }).then((r) => r.audio),
  updateAudio: (id: number, data: Partial<{ name: string; syncPoints: FlatSyncPoint[]; durationMs: number }>) =>
    request<{ audio: AudioTrack }>('PATCH', `/api/audio/${id}`, data).then((r) => r.audio),
  deleteAudio: (id: number) => request<{ ok: boolean }>('DELETE', `/api/audio/${id}`),
  audioStreamUrl: (id: number) => `/api/audio/${id}/stream`,
  getPeaks: (id: number) => request<WaveformPeaks>('GET', `/api/audio/${id}/peaks`),
  savePeaks: (id: number, peaks: WaveformPeaks) => request<{ ok: boolean }>('PUT', `/api/audio/${id}/peaks`, peaks),

  listAnnotations: (scoreId: number) =>
    request<{ annotations: Annotation[] }>('GET', `/api/scores/${scoreId}/annotations`).then((r) => r.annotations),
  createAnnotation: (scoreId: number, data: AnnotationInput) =>
    request<{ annotation: Annotation }>('POST', `/api/scores/${scoreId}/annotations`, data).then((r) => r.annotation),
  createAnnotations: (scoreId: number, annotations: AnnotationInput[]) =>
    request<{ annotations: Annotation[] }>('POST', `/api/scores/${scoreId}/annotations/bulk`, { annotations }).then((r) => r.annotations),
  deleteAnnotationsOfKind: (scoreId: number, kind: string) =>
    request<{ deleted: number }>('DELETE', `/api/scores/${scoreId}/annotations?kind=${encodeURIComponent(kind)}`),
  updateAnnotation: (id: number, data: Partial<AnnotationInput>) =>
    request<{ annotation: Annotation }>('PATCH', `/api/annotations/${id}`, data).then((r) => r.annotation),
  deleteAnnotation: (id: number) => request<{ ok: boolean }>('DELETE', `/api/annotations/${id}`),

  listLoops: (scoreId: number) => request<{ loops: SavedLoop[] }>('GET', `/api/scores/${scoreId}/loops`).then((r) => r.loops),
  createLoop: (scoreId: number, data: SavedLoopInput) =>
    request<{ loop: SavedLoop }>('POST', `/api/scores/${scoreId}/loops`, data).then((r) => r.loop),
  updateLoop: (id: number, data: Partial<SavedLoopInput>) =>
    request<{ loop: SavedLoop }>('PATCH', `/api/loops/${id}`, data).then((r) => r.loop),
  deleteLoop: (id: number) => request<{ ok: boolean }>('DELETE', `/api/loops/${id}`),

  browseLibrary: (path: string) => request<LibraryListing>('GET', `/api/library/browse?path=${encodeURIComponent(path)}`),
  searchLibrary: (q: string) => request<LibraryListing>('GET', `/api/library/search?q=${encodeURIComponent(q)}`),
  libraryStreamUrl: (path: string) => `/api/library/stream?path=${encodeURIComponent(path)}`,
};
