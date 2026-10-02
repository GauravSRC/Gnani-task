import type { Metadata } from "next";

import RecordingView from "@/components/RecordingView";

export const metadata: Metadata = { title: "Recording" };

// The page is a thin server component: it reads the URL parameter and hands
// over to a client component, because polling needs the browser.
export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecordingView id={id} />;
}