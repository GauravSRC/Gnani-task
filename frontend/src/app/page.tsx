import RecordingList from "@/components/RecordingList";
import UploadForm from "@/components/UploadForm";

const MAX_MB = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB ?? "50";

export default function HomePage() {
  return (
    <div className="space-y-14">
      <section>
        <h1 className="font-serif text-4xl font-semibold tracking-tight">
          Transcribe and summarize a recording
        </h1>
        <p className="mt-3 max-w-[60ch] text-graphite">
          Upload audio up to {MAX_MB} MB in any of ten Indian languages. It’s split into short parts,
          transcribed with Gnani’s speech recognition, then summarized. You can leave this page while it
          works; progress is saved.
        </p>
        <div className="mt-8">
          <UploadForm />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Recordings</h2>
        <div className="mt-4">
          <RecordingList />
        </div>
      </section>
    </div>
  );
}