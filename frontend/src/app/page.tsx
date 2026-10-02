import RecordingList from "@/components/RecordingList";

export default function HomePage() {
  return (
    <section>
      <h1 className="font-serif text-4xl font-semibold tracking-tight">Recordings</h1>
      <div className="mt-6">
        <RecordingList />
      </div>
    </section>
  );
}