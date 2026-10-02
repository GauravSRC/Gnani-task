import type { Status } from "@/lib/api";

/** One vocabulary for job stages, shared by the badge and the stage list. */
export const STATUS_LABELS: Record<Status, string> = {
  queued: "Queued",
  converting: "Preparing audio",
  transcribing: "Transcribing",
  summarizing: "Writing summary",
  completed: "Done",
  failed: "Failed",
};

const STYLES: Record<Status, { badge: string; dot: string }> = {
  queued: { badge: "bg-white text-graphite ring-rule", dot: "bg-graphite" },
  converting: { badge: "bg-meter-soft text-ink ring-meter/40", dot: "bg-meter" },
  transcribing: { badge: "bg-meter-soft text-ink ring-meter/40", dot: "bg-meter" },
  summarizing: { badge: "bg-meter-soft text-ink ring-meter/40", dot: "bg-meter" },
  completed: { badge: "bg-signal-soft text-ink ring-signal/30", dot: "bg-signal" },
  failed: { badge: "bg-alarm-soft text-alarm ring-alarm/30", dot: "bg-alarm" },
};

export default function StatusBadge({ status }: { status: Status }) {
  const style = STYLES[status] ?? STYLES.queued;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${style.badge}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${style.dot}`} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}