/**
 * Typed client for the FastAPI backend. Every request goes through here, so
 * the base URL and the error handling live in one place.
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000").replace(
  /\/+$/,
  "",
);

export type Status =
  | "queued"
  | "converting"
  | "transcribing"
  | "summarizing"
  | "completed"
  | "failed";

const TERMINAL: ReadonlySet<Status> = new Set<Status>(["completed", "failed"]);

export function isTerminal(status: Status): boolean {
  return TERMINAL.has(status);
}

export interface Language {
  code: string;
  label: string;
}

export interface RecordingSummary {
  id: string;
  filename: string;
  language_code: string;
  language_label: string;
  size_bytes: number;
  duration_seconds: number | null;
  status: Status;
  progress_percent: number;
  created_at: string;
  updated_at: string;
}

export interface Chunk {
  chunk_index: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
  is_done: boolean;
}

export interface RecordingDetail extends RecordingSummary {
  stage_detail: string;
  chunks_total: number;
  chunks_done: number;
  transcript: string | null;
  summary: string | null;
  error_message: string | null;
  audio_url: string | null;
  chunks: Chunk[];
}

export interface UploadAccepted {
  id: string;
  status: Status;
}

/** `status` is 0 when the request never got an HTTP response at all. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const UNREACHABLE = "Can’t reach the server. Check your connection and try again.";

/** FastAPI errors look like {"detail": "..."}, or {"detail": [{"msg": "..."}]} for validation. */
function errorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0];
      if (first !== null && typeof first === "object" && "msg" in first) {
        return String((first as { msg: unknown }).msg);
      }
    }
  }
  if (status === 413) return "This file is too large to upload.";
  if (status >= 500) return "The server hit an error. Try again in a moment.";
  return `Request failed with status ${status}.`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Error body wasn't JSON; fall back to a message based on the status.
    }
    throw new ApiError(errorMessage(body, res.status), res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** True once /health answers. A sleeping free-tier backend can take about a minute. */
export async function checkHealth(timeoutMs = 70_000): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getLanguages(): Promise<Language[]> {
  const body = await request<{ languages: Language[] }>("/api/languages");
  return body.languages;
}

export function listRecordings(): Promise<RecordingSummary[]> {
  return request<RecordingSummary[]>("/api/recordings");
}

export function getRecording(id: string): Promise<RecordingDetail> {
  return request<RecordingDetail>(`/api/recordings/${encodeURIComponent(id)}`);
}

export function retryRecording(id: string): Promise<UploadAccepted> {
  return request<UploadAccepted>(`/api/recordings/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
}

export function deleteRecording(id: string): Promise<void> {
  return request<void>(`/api/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Upload with progress. fetch() can't report upload progress, so this uses
 * XMLHttpRequest. Aborting `signal` cancels the transfer.
 */
export function uploadRecording(
  file: File,
  languageCode: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadAccepted> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError("Upload cancelled.", 0));
      return;
    }

    const form = new FormData();
    form.append("file", file);
    form.append("language_code", languageCode);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/recordings`);
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as UploadAccepted | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) {
        resolve(body);
      } else {
        reject(new ApiError(errorMessage(xhr.response, xhr.status), xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError(`Upload failed. ${UNREACHABLE}`, 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));

    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}