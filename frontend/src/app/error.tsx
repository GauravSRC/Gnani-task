"use client";

import Link from "next/link";
import { useEffect } from "react";

// Next.js renders this in place of a page when something throws while
// rendering it, instead of showing a blank screen.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="space-y-3">
      <h1 className="font-serif text-3xl font-semibold tracking-tight">This page stopped working</h1>
      <p className="text-graphite">
        Something in the page failed unexpectedly. Your recordings are stored on the server and aren’t
        affected.
      </p>
      <div className="flex items-center gap-5 pt-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-white hover:bg-signal/90"
        >
          Try again
        </button>
        <Link href="/" className="text-sm text-signal hover:underline">
          Go to recordings
        </Link>
      </div>
    </div>
  );
}