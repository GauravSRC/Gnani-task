# Audio Notes

Upload an audio recording and get back a transcript (Gnani speech-to-text) and a summary (Google Gemini).

- **Live app:** https://gnani-audio-notes-website.vercel.app/
- **How it works:** https://gnani-audio-notes-website.vercel.app/architecture
- **API docs:** https://gnani-audio-notes-api.onrender.com/docs

The backend runs on Render's free tier, which sleeps after 15 minutes without traffic. The first request after that takes about a minute; the app shows a banner while it wakes.

## What it does

- Upload audio up to 50 MB (about 50 minutes of MP3) in any of Gnani's ten Indian languages.
- Long recordings are split at pauses into parts of at most 30 seconds and transcribed part by part.
- Live progress: upload percentage, current stage, which part is being transcribed, and the transcript as it arrives.
- A summary with an overview, key points and action items.
- Every past upload is listed and can be reopened and played back.
- Failures are shown with their reason, and a retry continues from the last finished part.
- A server restart mid-job pauses the job and resumes it from the next part.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router, TypeScript, Tailwind CSS) on Vercel |
| Backend | FastAPI on Render |
| Database | Supabase Postgres, via SQLAlchemy 2 and psycopg 3 |
| Storage | Supabase Storage, private bucket, signed playback URLs |
| Background jobs | A worker process that claims rows with `SELECT … FOR UPDATE SKIP LOCKED` |
| Audio | ffmpeg (bundled through `imageio-ffmpeg`) and NumPy |
| Speech-to-text | Gnani Prisma v2.5, `POST /stt/v3` |
| Summary | Google Gemini (`gemini-2.5-flash`) |

## How it works

1. The browser uploads the file to the API, which stores it in the bucket, inserts a `queued` row and returns its id.
2. A worker claims the row, decodes the audio to 16 kHz mono WAV and splits it into parts of at most 30 seconds, cutting at the quietest moment near each limit.
3. Each part goes to Gnani one at a time, at least 1.1 s apart, and each result is saved as soon as it arrives.
4. The joined transcript is saved, then summarized by Gemini.
5. The recording page polls every 2 seconds and draws progress from the database.

The full explanation, including measurements and why chunking was chosen over Gnani's Batch API, is on the [architecture page](https://gnani-audio-notes-website.vercel.app/architecture).

## Project layout

```
backend/
  app/
    main.py         HTTP API: upload, list, detail, retry, delete
    config.py       settings from environment variables
    db.py           engine and session
    models.py       recordings and chunks tables
    schemas.py      response shapes
    storage.py      Supabase Storage over REST, signed URLs
    audio.py        ffmpeg decode and pause-aware splitting
    gnani.py        Gnani client: pacing, retries, readable errors
    summarizer.py   Gemini summary
    pipeline.py     one job end to end, resumable
    worker.py       queue loop, stale-job recovery, graceful shutdown
  tests/            pytest suite for decoding and chunking
  start.sh          production entry point: API and worker together
frontend/
  src/app/          pages: home, recordings/[id], architecture
  src/components/   upload form, recordings list, recording view, status badge, server banner
  src/lib/          API client and formatting helpers
```

## Running locally (Windows PowerShell)

You need Python 3.12, Node.js 20.9 or newer, a Supabase project with a private bucket named `audio`, a Gnani API key and a Gemini API key. ffmpeg is installed by pip, so there is nothing to install system-wide.

**Backend**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env    # then fill in the values
uvicorn app.main:app --reload --port 8000
```

In a second terminal, from `backend/` with the venv active:

```powershell
python -m app.worker
```


**Frontend**

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
npm run dev
```


**Tests**

```powershell
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

## Environment variables

**Backend** (`backend/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Session pooler connection string (IPv4) |
| `SUPABASE_URL` | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `service_role` key; backend only, never sent to the browser |
| `SUPABASE_BUCKET` | Bucket name, default `audio` |
| `GNANI_API_KEY` | Gnani speech-to-text key |
| `GNANI_MIN_GAP_SECONDS` | Minimum gap between Gnani requests, default `1.1` |
| `GEMINI_API_KEY` | Google AI Studio key |
| `GEMINI_MODEL` | Default `gemini-2.5-flash` |
| `MAX_UPLOAD_MB` | Upload cap, default `50` |
| `CHUNK_SECONDS` | Longest part sent to Gnani, default `30` |
| `CORS_ORIGINS` | Comma-separated frontend origins |

**Frontend** (`frontend/.env.local`)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend base URL, no trailing slash |
| `NEXT_PUBLIC_MAX_UPLOAD_MB` | Keep equal to `MAX_UPLOAD_MB` |

## Deployment

**Backend on Render:** a Web Service with root directory `backend`, build command `pip install -r requirements.txt`, start command `bash start.sh`, and health check path `/health`. Set the backend variables above plus `PYTHON_VERSION=3.12.10` and `PYTHONUNBUFFERED=1`. `start.sh` runs the API and the worker in one service, because Render's free tier has no free background workers.

**Frontend on Vercel:** root directory `frontend`, framework Next.js, with `NEXT_PUBLIC_API_URL` set to the Render URL. `NEXT_PUBLIC_*` values are built into the bundle, so changing one requires a redeploy.

Once both are live, set `CORS_ORIGINS` on Render to the Vercel domain.

Local development and the deployed app can share one Supabase project, but don't leave a local worker running while the live app is in use, or it will pick up live jobs.

## Known limits

- Uploads are capped at 50 MB, the per-file limit on Supabase's free plan.
- No accounts: everyone sees the same list of recordings.
- No per-user upload rate limit; the size and duration caps are the only guard on API credits.
- One worker processes one recording at a time.
- The free backend sleeps after 15 idle minutes.
- English transcripts come back without punctuation and are shown as returned.
- Summaries are always in English and use Gemini's free tier.
