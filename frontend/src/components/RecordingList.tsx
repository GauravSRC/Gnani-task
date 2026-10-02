"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import StatusBadge from "@/components/StatusBadge";
import { isTerminal, listRecordings, type RecordingSummary } from "@/lib/api";
import { formatBytes, formatClock, timeAgo } from "@/lib/format";

const REFRESH_MS = 5_000;

export default function RecordingList() {
  const [items, setItems] = useState<RecordingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loadedOnce = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const data = await listRecordings();
        if (cancelled) return;
        loadedOnce = true;
        setItems(data);
        setError(null);
        setNow(Date.now());
        // Keep refreshing only while something is still being processed.
        if (data.some((r) => !isTerminal(r.status))) timer = setTimeout(load, REFRESH_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn’t load recordings.");
        // A failed refresh keeps the old list and tries again; a failed
        // first load waits for the person to press Try again.
        if (loadedOnce) timer = setTimeout(load, REFRESH_MS * 2);
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reloadKey]);

  if (items === null) {
    if (error) {
      return (
        <div role="alert" className="rounded-md bg-alarm-soft px-4 py-3 text-sm">
          <p>Couldn’t load recordings. {error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setReloadKey((key) => key + 1);
            }}
            className="mt-2 font-medium text-alarm hover:underline"
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <p role="status" className="text-sm text-graphite">
        Loading recordings…
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="text-graphite">No recordings yet. Each upload appears here with its progress.</p>;
  }

  return (
    <div>
      {error && <p className="mb-3 text-sm text-graphite">Couldn’t refresh the list. Trying again.</p>}
      <ul className="divide-y divide-rule border-y border-rule">
        {items.map((r) => {
          const meta = [
            r.language_label,
            r.duration_seconds !== null ? formatClock(r.duration_seconds) : null,
            formatBytes(r.size_bytes),
            now !== null ? timeAgo(r.created_at, now) : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <li key={r.id}>
              <Link
                href={`/recordings/${r.id}`}
                className="-mx-3 flex items-center gap-4 rounded-md px-3 py-3 hover:bg-white"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.filename}</p>
                  <p className="mt-0.5 truncate text-sm text-graphite">{meta}</p>
                </div>
                {!isTerminal(r.status) && (
                  <span className="text-sm tabular-nums text-graphite">{r.progress_percent}%</span>
                )}
                <StatusBadge status={r.status} />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}