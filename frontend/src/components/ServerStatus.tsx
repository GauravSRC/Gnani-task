"use client";

import { useEffect, useState } from "react";

import { checkHealth } from "@/lib/api";

type State = "checking" | "waking" | "ready" | "down";

const SHOW_AFTER_MS = 1_500; // a quick answer shows nothing at all
const RETRY_EVERY_MS = 3_000;
const GIVE_UP_AFTER_MS = 90_000;

/**
 * The backend runs on a free tier that sleeps after 15 idle minutes and
 * takes about a minute to wake. Without this banner, the first visit after a
 * quiet spell looks like a broken page.
 */
export default function ServerStatus() {
  const [state, setState] = useState<State>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    const showTimer = setTimeout(() => {
      if (!cancelled) setState((current) => (current === "checking" ? "waking" : current));
    }, SHOW_AFTER_MS);

    async function waitForServer() {
      while (!cancelled) {
        if (await checkHealth()) {
          if (!cancelled) setState("ready");
          return;
        }
        if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
          if (!cancelled) setState("down");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
      }
    }
    void waitForServer();

    return () => {
      cancelled = true;
      clearTimeout(showTimer);
    };
  }, [attempt]);

  if (state === "waking") {
    return (
      <div role="status" className="border-b border-meter/30 bg-meter-soft">
        <p className="mx-auto max-w-3xl px-5 py-3 text-sm">
          Connecting to the server. It sleeps when nobody has used it for a while, so the first request
          can take up to a minute.
        </p>
      </div>
    );
  }

  if (state === "down") {
    return (
      <div role="alert" className="border-b border-alarm/30 bg-alarm-soft">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
          <p>The server isn’t responding, so uploads and recordings can’t load.</p>
          <button
            type="button"
            onClick={() => {
              setState("checking");
              setAttempt((n) => n + 1);
            }}
            className="font-medium text-alarm hover:underline"
          >
            Check again
          </button>
        </div>
      </div>
    );
  }

  return null;
}