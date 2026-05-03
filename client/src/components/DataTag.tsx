import { cn } from "@/lib/utils";

interface DataTagProps {
  freshness: string | undefined;
}

export default function DataTag({ freshness }: DataTagProps) {
  if (!freshness) return null;

  const labels: Record<string, { text: string; cls: string }> = {
    realtime: { text: "RT", cls: "bg-green-500/10 text-green-500 border-green-500/20" },
    delayed: { text: "15m delay", cls: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
    eod: { text: "EOD", cls: "bg-muted text-muted-foreground border-border" },
    unknown: { text: "?", cls: "bg-muted text-muted-foreground border-border" },
  };

  const { text, cls } = labels[freshness] || labels.unknown;
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono font-medium rounded border", cls)}>
      {text}
    </span>
  );
}
