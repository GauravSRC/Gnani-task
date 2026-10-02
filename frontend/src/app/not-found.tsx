import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3">
      <h1 className="font-serif text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-graphite">There’s nothing at this address.</p>
      <Link href="/" className="text-signal hover:underline">
        Go to recordings
      </Link>
    </div>
  );
}