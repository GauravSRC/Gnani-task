# Audio Notes Platform

Upload an audio file of any length, get back a transcript and an LLM summary.

- **Frontend:** Next.js (App Router, TypeScript) on Vercel
- **Backend:** FastAPI on Render
- **Database:** Supabase Postgres
- **Storage:** Supabase Storage (private bucket)
- **ASR:** Gnani Prisma v2.5 (`POST /stt/v3`)
- **LLM:** Google Gemini

Long audio is decoded to 16 kHz mono WAV with ffmpeg, split into chunks under
the API's 30-second limit, and transcribed chunk by chunk in a background worker.

See `/architecture` in the deployed app for the full write-up.

## Status

Work in progress.