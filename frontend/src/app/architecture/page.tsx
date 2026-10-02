import type { Metadata } from "next";

export const metadata: Metadata = { title: "How it works" };

const REPO_URL = "https://github.com/GauravSRC/Gnani-task";

export default function ArchitecturePage() {
  return (
    <article className="space-y-12">
      <header>
        <h1 className="font-serif text-4xl font-semibold tracking-tight">How this works</h1>
        <p className="mt-4 max-w-[68ch] font-serif text-[17px] leading-relaxed">
          You upload a recording. It is stored, split into short parts, transcribed part by part with
          Gnani’s speech recognition, and summarized by an LLM. This page explains how that happens, why
          it is built this way, and where the limits are.
        </p>
        <p className="mt-4 text-sm">
          Source code:{" "}
          <a href={REPO_URL} className="text-signal hover:underline" target="_blank" rel="noreferrer">
            {REPO_URL.replace("https://", "")}
          </a>
        </p>
      </header>

      <Section title="The pieces">
        <Table
          head={["Piece", "What I used", "Why"]}
          rows={[
            ["Frontend", "Next.js on Vercel", "Required by the brief. Pages are client components that poll the API."],
            ["Backend", "FastAPI on Render", "Required by the brief. ffmpeg ships as a Python wheel, so no system install is needed."],
            ["Database", "Supabase Postgres", "Holds recordings, parts, results and the job queue."],
            ["Storage", "Supabase Storage, private bucket", "Holds the original audio. Reachable only through short-lived signed links."],
            ["Background jobs", "A worker loop over the recordings table", "No extra service to host, and no second system that can disagree with the database."],
            ["Speech to text", "Gnani Prisma v2.5, POST /stt/v3", "Required by the brief."],
            ["Summary", "Google Gemini", "Free tier, and good at reading transcripts that have no punctuation."],
          ]}
        />
      </Section>

      <Section title="From upload to transcript">
        <ol className="max-w-[68ch] list-decimal space-y-3 pl-5 font-serif text-[17px] leading-relaxed marker:font-sans marker:text-sm marker:text-graphite">
          <li>
            The browser sends the file and the spoken language to the API. The API checks the extension
            and size while reading the body in one-megabyte pieces, so an oversized file is rejected
            without ever being held in memory whole.
          </li>
          <li>
            The API writes the original to the storage bucket, inserts one row with status{" "}
            <Code>queued</Code>, and answers with that row’s id. Nothing slow happens inside the request.
          </li>
          <li>
            The worker claims the oldest queued row with{" "}
            <Code>SELECT … FOR UPDATE SKIP LOCKED</Code>, which is what guarantees that two workers can
            never pick up the same recording.
          </li>
          <li>
            It downloads the file, decodes it to 16 kHz mono with ffmpeg, and splits it into parts of at
            most 30 seconds. One row is written per part.
          </li>
          <li>
            Each part is sent to Gnani in order, at least 1.1 seconds apart. Every result is saved the
            moment it arrives, so the page can show the transcript filling in.
          </li>
          <li>
            The parts are joined in order into the transcript, saved, and then sent to Gemini for the
            summary. The transcript is saved first on purpose, so a summary failure still leaves
            something useful.
          </li>
          <li>
            Meanwhile the page asks for the recording every two seconds and renders whatever the database
            currently says. You can close the tab and come back to the same place.
          </li>
        </ol>
      </Section>

      <Section title="How long audio is handled">
        <Prose>
          This is the central problem in the task. Gnani’s REST endpoint is for short clips: the
          documentation gives a 60-second maximum and calls 30 seconds the ideal, and their own OpenAPI
          description lists 30 seconds as the maximum. A two-minute recording cannot be sent in one
          request, so the backend splits it.
        </Prose>
        <Prose>
          My first version cut every 30 seconds exactly. Listening to the parts, words were being sliced
          in half at the joins, and the transcripts showed it. The current version measures loudness in
          100-millisecond windows across the ten seconds before each limit and cuts in the quietest one.
          Cuts now land in pauses between phrases rather than inside words.
        </Prose>
        <Table
          head={["Approach", "Parts for one 2:17 recording", "Where the cuts landed"]}
          rows={[
            ["Fixed 30-second cuts", "5", "30.0 s, 60.0 s, 90.0 s, 120.0 s — mid-word"],
            ["Quietest point in the last 10 s (used)", "6", "24.9 s, 49.8 s, 71.5 s, 96.1 s, 121.2 s — in pauses"],
          ]}
        />
        <Prose>
          The irregular spacing is the point: each cut is placed where that recording actually has a
          pause. The cost is one extra part, and therefore one extra API call. Parts are contiguous, so no
          audio is dropped or sent twice, and a part is never allowed to end with a sliver shorter than
          two seconds. Both properties are covered by tests that build synthetic audio with known pauses.
        </Prose>
        <Prose>
          End to end on my machine, a 2 minute 17 second recording finishes in about 16 seconds: roughly
          2 seconds to decode and split, 6 seconds of transcription, and 5 seconds for the summary.
        </Prose>
        <Prose>
          <strong className="font-medium">Why not Gnani’s Batch API.</strong> Batch accepts long files in
          one job and returns timestamps and speaker labels. I chose not to use it for four reasons: it
          reports only coarse job states, so a progress bar would have nothing to show between “queued”
          and “done”; it does not support Inverse Text Normalization, which is what turns spoken numbers
          into digits; it covers eight languages rather than the ten on REST, leaving out Gujarati and
          Punjabi; and direct uploads are capped at 10 MB per file. Splitting the audio myself costs more
          code but buys real progress, retry of a single failed part, and control over where the cuts
          fall. With more time I would add Batch as a second route for recordings over an hour, where
          those trade-offs reverse.
        </Prose>
      </Section>

      <Section title="What runs in the request, and what runs in the background">
        <Table
          head={["Where", "What", "Why there"]}
          rows={[
            [
              "In the API request",
              "Validate, store the file, insert the row, list, detail, retry, delete",
              "Each touches a few rows or one object, and answers in about a second.",
            ],
            [
              "In the background worker",
              "Download, decode, split, transcribe every part, summarize, requeue interrupted jobs",
              "These take seconds to minutes and depend on services that can be slow or fail.",
            ],
          ]}
        />
        <Prose>
          Holding an HTTP connection open for the length of a transcription would mean proxy timeouts, no
          way to show progress, and a lost job if the connection dropped. Accepting the work and returning
          an id separates how long the request takes from how long the job takes.
        </Prose>
        <Prose>
          Render’s free tier bills each service separately, so the worker runs as a second process inside
          the same container as the API rather than as its own paid service. It is ordinary code with no
          web server attached, and the same file runs standalone with{" "}
          <Code>python -m app.worker</Code> when more capacity is needed.
        </Prose>
      </Section>

      <Section title="Where the files and data live">
        <Table
          head={["What", "Where", "For how long"]}
          rows={[
            ["Original audio", "Private Supabase bucket, one folder per recording", "Kept, so it can be played back"],
            ["16 kHz copy and the part files", "A temporary folder on the worker", "Deleted when the job ends, however it ends"],
            ["Parts, transcript, summary, status, errors", "Postgres", "Kept"],
            ["Playback links", "Signed URLs valid for one hour, reused for fifty minutes", "Minted on demand, never stored"],
          ]}
        />
        <Prose>
          The bucket matters more than it first appears. The API process and the worker process do not
          share a filesystem once deployed, and Render’s disk is wiped on every deploy. The bucket is the
          durable handover point between the two, and it is also what makes playback possible later. No
          Supabase credential ever reaches the browser; the API signs a link and hands over only that.
        </Prose>
      </Section>

      <Section title="Progress">
        <Prose>
          The upload bar comes from the browser’s own upload events, so it reflects bytes actually sent.
          After that, progress is the number of finished parts out of the total, which the worker writes
          to Postgres after each one. The page polls every two seconds and stops the moment a recording is
          finished or failed, so an idle page costs nothing.
        </Prose>
        <Prose>
          I chose polling over WebSockets because progress is already durable in the database. A plain
          request every two seconds survives a refresh, a closed tab, a worker restart and a sleeping
          server, none of which a socket would. The bar on the recording page draws the actual parts, each
          as wide as its duration, so what you see is the real shape of how the file was processed.
        </Prose>
      </Section>

      <Section title="When things fail">
        <Table
          head={["Failure", "What the system does", "What you see"]}
          rows={[
            ["Wrong type or too large", "Checked in the browser, then again in the API", "A message before anything is sent"],
            ["Upload interrupted", "The transfer reports the error", "“Upload failed”, with the file still selected to retry"],
            ["Corrupted or non-audio file", "ffmpeg fails before any Gnani call is made", "“Couldn’t decode this file”"],
            ["Silence only", "Every part comes back empty", "“No speech was detected in this recording”"],
            ["Gnani 429, 5xx or timeout", "Up to four attempts, waiting 2 s, 4 s then 8 s", "Progress simply continues"],
            ["Gnani 400 or 403", "Stops at once; retrying cannot fix a bad key or a rejected file", "The reason, and which part it stopped on"],
            ["Summary fails", "The transcript is already saved", "Transcript plus a Retry that only redoes the summary"],
            ["Worker killed mid-job", "The heartbeat goes stale and the job is requeued; finished parts are kept", "Progress pauses, then continues from the next part"],
            ["Backend asleep", "The page keeps checking until it answers", "“Connecting to the server… up to a minute”"],
          ]}
        />
        <Prose>
          Retrying is only ever attempted where it can help. A 429 or a 500 is a moment in time, so it is
          worth waiting out. A 400 means the request itself was wrong and a 403 means the key or the
          credits are, so both fail immediately rather than burning three more attempts. A job that is
          interrupted three times is failed rather than requeued again, so one unprocessable file cannot
          loop forever.
        </Prose>
      </Section>

      <Section title="Limits of this demo">
        <ul className="max-w-[68ch] list-disc space-y-2 pl-5 font-serif text-[17px] leading-relaxed">
          <li>
            Uploads are capped at 50 MB, which is the per-file limit on the storage plan in use. That is
            roughly fifty minutes of MP3.
          </li>
          <li>
            There are no accounts, so everyone sees the same list of recordings. The task did not ask for
            authentication and adding it without a real user model felt like scaffolding.
          </li>
          <li>
            One worker processes one recording at a time. A second upload waits for the first to finish.
          </li>
          <li>The backend sleeps after fifteen idle minutes, so the first request after a quiet spell is slow.</li>
          <li>English transcripts come back without punctuation. They are shown exactly as Gnani returns them.</li>
          <li>Summaries use Gemini’s free tier, where Google may use the content to improve its products.</li>
        </ul>
      </Section>

      <Section title="What I would do with more time">
        <ul className="max-w-[68ch] list-disc space-y-2 pl-5 font-serif text-[17px] leading-relaxed">
          <li>
            Upload straight from the browser to the bucket with a signed link, so large files never pass
            through the API. The row already exists before the bytes arrive, so this is mostly one extra
            state.
          </li>
          <li>Add the Batch API as a second route for recordings over an hour, and for speaker labels.</li>
          <li>
            Transcribe several parts at once, within the rate limit, instead of strictly one at a time.
          </li>
          <li>Run the worker as its own service and scale it by queue depth.</li>
          <li>
            Flag parts that return far fewer words than their length suggests, so a quietly failed part is
            visible rather than silently short.
          </li>
          <li>Accounts, so each person sees only their own recordings, and a lifecycle rule that deletes old audio.</li>
          <li>Alembic migrations. Two tables that never changed shape did not need them; a third would.</li>
        </ul>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="border-b border-rule pb-2 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[68ch] font-serif text-[17px] leading-relaxed">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-white px-1.5 py-0.5 font-sans text-[15px]">{children}</code>;
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-rule">
            {head.map((cell) => (
              <th key={cell} className="py-2 pr-4 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-b border-rule/60 align-top">
              {row.map((cell, index) => (
                <td key={index} className={`py-2.5 pr-4 ${index === 0 ? "font-medium" : "text-graphite"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}