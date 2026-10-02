"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import StatusBadge, { STATUS_LABELS } from "@/components/StatusBadge";
import {
  ApiError,
  deleteRecording,
  getRecording,
  isTerminal,
  retryRecording,
  type Chunk,
  type RecordingDetail,
  type Status,
} from "@/lib/api";
import { formatBytes, formatClock, formatElapsed, timeAgo } from "@/lib/format";

const POLL_MS = 2_000; // while the job is running
const POLL_BACKOFF_MS = 6_000; // after a poll fails
const STALL_AFTER_MS = 3 * 60_000; // no worker activity for this long gets a notice

const STAGES: Status[] = ["queued", "converting", "transcribing", "summarizing", "completed"];

export default function RecordingView({ id }: { id: string }) {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [rec, setRec] = useState<RecordingDetail | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const running = rec !== null && !isTerminal(rec.status);

  // Poll until the job reaches a terminal state. Chained setTimeout rather
  // than setInterval, so a slow response can never overlap the next request.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const data = await getRecording(id);
        if (cancelled) return;
        setRec(data);
        // Keep the first signed URL. The API mints a new one on every poll,
        // and swapping it would reload the player and interrupt playback.
        setAudioUrl((current) => current ?? data.audio_url);
        setPollError(null);
        setNow(Date.now());
        if (!isTerminal(data.status)) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setPollError(err instanceof Error ? err.message : "Couldn’t load this recording.");
        timer = setTimeout(poll, POLL_BACKOFF_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, pollKey]);

  // A one-second clock while running, so elapsed time keeps moving even
  // during a single long API call.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  async function handleRetry() {
    setBusy("retry");
    setActionError(null);
    try {
      await retryRecording(id);
      // Show the requeue at once instead of waiting for the next poll.
      setRec(
        (current) =>
          current && {
            ...current,
            status: "queued",
            stage_detail: "Requeued after failure",
            error_message: null,
            progress_percent: 0,
            updated_at: new Date().toISOString(),
          },
      );
      setPollKey((key) => key + 1); // restarts the polling effect
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn’t retry. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this recording, its transcript and its audio? This can’t be undone.")) {
      return;
    }
    setBusy("delete");
    setActionError(null);
    try {
      await deleteRecording(id);
      router.push("/");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn’t delete. Try again.");
      setBusy(null);
    }
  }

  function playFrom(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    audio.play().catch(() => {
      // The browser may refuse to start playback; the position is still set.
    });
  }

  if (notFound) {
    return (
      <div className="space-y-3">
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Recording not found</h1>
        <p className="text-graphite">It may have been deleted, or the link is incomplete.</p>
        <Link href="/" className="text-signal hover:underline">
          Back to all recordings
        </Link>
      </div>
    );
  }

  if (rec === null) {
    return (
      <p role="status" className="text-graphite">
        {pollError ? `Couldn’t load this recording. ${pollError} Trying again.` : "Loading recording…"}
      </p>
    );
  }

  const createdMs = new Date(rec.created_at).getTime();
  const updatedMs = new Date(rec.updated_at).getTime();
  const nowMs = now ?? updatedMs;
  const sinceUpdateMs = Math.max(0, nowMs - updatedMs);
  const stalled = running && sinceUpdateMs > STALL_AFTER_MS;
  const nextPart = rec.chunks.find((chunk) => !chunk.is_done)?.chunk_index;
  const partsDone = rec.chunks.filter((chunk) => chunk.is_done).length;

  const meta = [
    rec.language_label,
    rec.duration_seconds !== null ? formatClock(rec.duration_seconds) : null,
    formatBytes(rec.size_bytes),
    `uploaded ${timeAgo(rec.created_at, nowMs)}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <article className="space-y-10">
      <header>
        <Link href="/" className="text-sm text-graphite hover:text-ink">
          Back to all recordings
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 break-words font-serif text-3xl font-semibold tracking-tight">
            {rec.filename}
          </h1>
          <StatusBadge status={rec.status} />
        </div>
        <p className="mt-2 text-sm text-graphite">{meta}</p>
      </header>

      {pollError && (
        <p role="status" className="rounded-md bg-meter-soft px-4 py-3 text-sm">
          Lost contact with the server. Showing the last known state and retrying.
        </p>
      )}
      {actionError && (
        <p role="alert" className="rounded-md bg-alarm-soft px-4 py-3 text-sm text-alarm">
          {actionError}
        </p>
      )}

      <section aria-label="Progress" className="space-y-4">
        {running && <StageList status={rec.status} />}
        <PartsBar rec={rec} running={running} nextPart={nextPart} onSeek={playFrom} />
        {running && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <span>{rec.stage_detail || STATUS_LABELS[rec.status]}</span>
            <span className="tabular-nums text-graphite">
              {rec.progress_percent}% done, {formatElapsed(nowMs - createdMs)} elapsed, last update{" "}
              {formatElapsed(sinceUpdateMs)} ago
            </span>
          </div>
        )}
        {stalled && (
          <p className="rounded-md bg-meter-soft px-4 py-3 text-sm">
            {rec.status === "queued"
              ? "Still waiting for a worker. If another recording is being processed, this one starts when it finishes."
              : "No progress for a few minutes. If the server restarted, the job resumes automatically within about 15 minutes, from the last finished part."}
          </p>
        )}
        {rec.status === "failed" && (
          <FailurePanel
            message={rec.error_message}
            partsDone={partsDone}
            busy={busy === "retry"}
            onRetry={handleRetry}
          />
        )}
        {rec.status === "completed" && (
          <p className="text-sm text-graphite">Processed in {formatElapsed(updatedMs - createdMs)}.</p>
        )}
      </section>

      {audioUrl && (
        <audio ref={audioRef} src={audioUrl} controls preload="metadata" className="w-full" />
      )}

      <section>
        <h2 className="text-lg font-semibold">Summary</h2>
        {rec.summary ? (
          <div className="mt-3 whitespace-pre-wrap border-l-4 border-signal pl-4 font-serif text-[17px] leading-relaxed">
            {rec.summary}
          </div>
        ) : (
          <p className="mt-2 text-sm text-graphite">
            {running
              ? "Written once the whole recording is transcribed."
              : rec.transcript
                ? "Not written yet. Retry to generate it."
                : "Not available, because processing stopped before the transcript was finished."}
          </p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">Transcript</h2>
          {rec.chunks.length > 0 && (
            <span className="text-sm tabular-nums text-graphite">
              {partsDone} of {rec.chunks.length} parts
            </span>
          )}
        </div>
        {rec.chunks.length === 0 ? (
          <p className="mt-2 text-sm text-graphite">
            {running ? "Appears here part by part as each one is transcribed." : "No transcript was produced."}
          </p>
        ) : (
          <ol className="mt-4 space-y-4">
            {rec.chunks.map((chunk) => (
              <li key={chunk.chunk_index} className="grid grid-cols-[4rem_1fr] gap-3">
                <button
                  type="button"
                  onClick={() => playFrom(chunk.start_seconds)}
                  title="Play from here"
                  className="h-fit text-left text-sm tabular-nums text-signal hover:underline"
                >
                  {formatClock(chunk.start_seconds)}
                </button>
                <p
                  className={`font-serif text-[17px] leading-relaxed ${
                    chunk.is_done && chunk.text ? "" : "italic text-graphite"
                  }`}
                >
                  {partText(chunk, rec.status, nextPart)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {!running && (
        <footer className="border-t border-rule pt-6">
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy !== null}
            className="text-sm text-alarm hover:underline disabled:opacity-50"
          >
            {busy === "delete" ? "Deleting…" : "Delete recording"}
          </button>
        </footer>
      )}
    </article>
  );
}

function partText(chunk: Chunk, status: Status, nextPart: number | undefined): string {
  if (chunk.is_done) return chunk.text || "No speech in this part.";
  if (status === "transcribing" && chunk.chunk_index === nextPart) return "Transcribing this part…";
  if (status === "failed") return "Not transcribed.";
  return "Waiting.";
}

function StageList({ status }: { status: Status }) {
  const current = STAGES.indexOf(status);
  return (
    <ol className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {STAGES.map((stage, index) => (
        <li
          key={stage}
          aria-current={index === current ? "step" : undefined}
          className={
            index < current ? "text-signal" : index === current ? "font-medium text-ink" : "text-graphite/70"
          }
        >
          {index + 1}. {STATUS_LABELS[stage]}
        </li>
      ))}
    </ol>
  );
}

/** The recording drawn as the parts it was processed in, each as wide as its
 *  duration. Finished parts are teal, the one in flight pulses amber, and
 *  clicking any part plays the audio from there. */
function PartsBar({
  rec,
  running,
  nextPart,
  onSeek,
}: {
  rec: RecordingDetail;
  running: boolean;
  nextPart: number | undefined;
  onSeek: (seconds: number) => void;
}) {
  if (rec.chunks.length === 0) {
    if (!running) return null;
    // Before the audio is split there are no parts yet, only overall progress.
    return (
      <div className="h-3 overflow-hidden rounded-full bg-rule">
        <div
          className="h-full rounded-full bg-meter transition-[width] duration-500"
          style={{ width: `${Math.max(3, rec.progress_percent)}%` }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-3 gap-0.5" role="group" aria-label="Recording parts">
      {rec.chunks.map((chunk) => {
        const inFlight = running && rec.status === "transcribing" && chunk.chunk_index === nextPart;
        const color = chunk.is_done
          ? "bg-signal hover:bg-signal/80"
          : inFlight
            ? "bg-meter motion-safe:animate-pulse"
            : "bg-rule hover:bg-graphite/30";
        return (
          <button
            key={chunk.chunk_index}
            type="button"
            onClick={() => onSeek(chunk.start_seconds)}
            style={{ flexGrow: Math.max(0.1, chunk.end_seconds - chunk.start_seconds) }}
            className={`min-w-1 basis-0 first:rounded-l-full last:rounded-r-full ${color}`}
            title={`${formatClock(chunk.start_seconds)} to ${formatClock(chunk.end_seconds)}`}
            aria-label={`Play part ${chunk.chunk_index + 1} from ${formatClock(chunk.start_seconds)}`}
          />
        );
      })}
    </div>
  );
}

function FailurePanel({
  message,
  partsDone,
  busy,
  onRetry,
}: {
  message: string | null;
  partsDone: number;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="rounded-md bg-alarm-soft px-4 py-4">
      <p className="font-medium text-alarm">Processing stopped</p>
      <p className="mt-1 text-sm">{message ?? "No error details were recorded."}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="rounded-md bg-alarm px-4 py-2 text-sm font-medium text-white hover:bg-alarm/90 disabled:opacity-50"
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
        <span className="text-sm text-graphite">
          {partsDone > 0
            ? `${partsDone} finished ${partsDone === 1 ? "part is" : "parts are"} kept, so a retry continues from where it stopped.`
            : "A retry starts from the beginning."}
        </span>
      </div>
    </div>
  );
}