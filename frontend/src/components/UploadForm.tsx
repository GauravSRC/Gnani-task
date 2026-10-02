"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { getLanguages, uploadRecording, type Language } from "@/lib/api";
import { formatBytes } from "@/lib/format";

// Mirrors the backend's checks so mistakes are caught before any bytes are
// sent. The backend validates again and stays the authority.
const ALLOWED_EXTENSIONS = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".webm", ".mp4", ".amr"];
const MAX_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB ?? "50");
const MIN_BYTES = 1024;
const DEFAULT_LANGUAGE = "en-IN";

function validate(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const what = ext ? `“${ext}” files aren’t supported` : "This file has no extension";
    return `${what}. Choose one of: ${ALLOWED_EXTENSIONS.join(", ")}.`;
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    return `This file is ${formatBytes(file.size)}. The limit is ${MAX_MB} MB.`;
  }
  if (file.size < MIN_BYTES) return "This file is empty or too small to contain audio.";
  return null;
}

export default function UploadForm() {
  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);

  const [languages, setLanguages] = useState<Language[] | null>(null);
  const [languagesFailed, setLanguagesFailed] = useState(false);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null); // null when not uploading

  useEffect(() => {
    let cancelled = false;
    getLanguages()
      .then((list) => {
        if (!cancelled) setLanguages(list);
      })
      .catch(() => {
        if (!cancelled) setLanguagesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Leaving the page mid-upload cancels it, instead of letting it finish in
  // the background and then pulling the person to the new recording.
  useEffect(() => () => abortRef.current?.abort(), []);

  const uploading = percent !== null;
  const languagesLoading = languages === null && !languagesFailed;

  function pick(picked: File | null) {
    setFile(picked);
    setFileProblem(picked ? validate(picked) : null);
    setUploadError(null);
  }

  async function startUpload() {
    if (!file || uploading) return;
    const problem = validate(file);
    if (problem) {
      setFileProblem(problem);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setUploadError(null);
    setPercent(0);
    try {
      const { id } = await uploadRecording(file, language, setPercent, controller.signal);
      router.push(`/recordings/${id}`);
    } catch (err) {
      setPercent(null);
      setUploadError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally {
      abortRef.current = null;
    }
  }

  const sentBytes = file && percent !== null ? Math.round((file.size * percent) / 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <label
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            // Without this, dropping a file makes the browser open it and leave the app.
            event.preventDefault();
            if (!uploading) pick(event.dataTransfer.files[0] ?? null);
          }}
          className={`flex min-h-28 flex-col justify-center rounded-lg border-2 border-dashed px-5 py-4 focus-within:border-signal ${
            fileProblem ? "border-alarm/60" : file ? "border-signal/60 bg-white" : "border-rule hover:border-graphite/50"
          } ${uploading ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
        >
          <input
            type="file"
            accept={ALLOWED_EXTENSIONS.join(",")}
            disabled={uploading}
            onChange={(event) => pick(event.target.files?.[0] ?? null)}
            className="sr-only"
          />
          {file ? (
            <>
              <span className="truncate font-medium">{file.name}</span>
              <span className="mt-1 text-sm text-graphite">
                {formatBytes(file.size)}. Click or drop to choose a different file.
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">Choose an audio file, or drop it here</span>
              <span className="mt-1 text-sm text-graphite">
                MP3, WAV, M4A, MP4, OGG, FLAC and others, up to {MAX_MB} MB
              </span>
            </>
          )}
        </label>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Spoken language</span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={uploading || languagesLoading}
              className="rounded-md border border-rule bg-white px-3 py-2"
            >
              {languages ? (
                languages.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))
              ) : (
                <option value={DEFAULT_LANGUAGE}>
                  {languagesFailed ? "English (India)" : "Loading languages…"}
                </option>
              )}
            </select>
          </label>
          <button
            type="button"
            onClick={startUpload}
            disabled={!file || fileProblem !== null || uploading || languagesLoading}
            className="rounded-md bg-signal px-4 py-2.5 text-sm font-medium text-white hover:bg-signal/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading ? "Uploading…" : "Upload and transcribe"}
          </button>
        </div>
      </div>

      {languagesFailed && (
        <p className="text-sm text-graphite">
          The language list didn’t load, so English (India) is used. Check that the server is running.
        </p>
      )}

      {fileProblem && (
        <p role="alert" className="rounded-md bg-alarm-soft px-4 py-3 text-sm text-alarm">
          {fileProblem}
        </p>
      )}
      {uploadError && (
        <p role="alert" className="rounded-md bg-alarm-soft px-4 py-3 text-sm text-alarm">
          {uploadError}
        </p>
      )}

      {file && percent !== null && (
        <div>
          <div className="flex justify-between gap-3 text-sm">
            <span>
              {percent < 100
                ? `Uploading ${formatBytes(sentBytes)} of ${formatBytes(file.size)}`
                : "Upload complete. Saving the file…"}
            </span>
            <span className="tabular-nums text-graphite">{percent}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-2 overflow-hidden rounded-full bg-rule"
          >
            <div
              className="h-full bg-signal transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          {percent < 100 && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="mt-3 text-sm text-graphite underline hover:text-ink"
            >
              Cancel upload
            </button>
          )}
        </div>
      )}
    </div>
  );
}