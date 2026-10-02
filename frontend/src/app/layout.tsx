import type { Metadata } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import ServerStatus from "@/components/ServerStatus";

import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Audio Notes", template: "%s | Audio Notes" },
  description: "Upload a recording and get its transcript and a summary.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${plexSans.variable} ${sourceSerif.variable} bg-paper font-sans text-ink antialiased`}
      >
        <header className="border-b border-rule">
          <nav className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              Audio Notes
            </Link>
            <div className="flex gap-5 text-sm text-graphite">
              <Link href="/" className="hover:text-ink">
                Recordings
              </Link>
              <Link href="/architecture" className="hover:text-ink">
                Architecture
              </Link>
            </div>
          </nav>
        </header>
        <ServerStatus />
        <main className="mx-auto max-w-3xl px-5 py-10">{children}</main>
        <footer className="mx-auto max-w-3xl px-5 pb-10 text-sm text-graphite">
          Speech recognition by Gnani Prisma v2.5. Summaries by Google Gemini.
        </footer>
      </body>
    </html>
  );
}