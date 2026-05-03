import { cn } from "@/lib/utils";

interface SignalBadgeProps {
  signal: string | null | undefined;
  size?: "sm" | "md";
}

export default function SignalBadge({ signal, size = "sm" }: SignalBadgeProps) {
  if (!signal) return <span className="text-muted-foreground text-xs">—</span>;

  const label = signal.toUpperCase();
  const cls = signal === "buy" ? "signal-buy" : signal === "avoid" ? "signal-avoid" : "signal-watch";

  return (
    <span
      className={cn(
        "inline-flex items-center font-semibold rounded-sm font-mono",
        cls,
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs"
      )}
    >
      {label}
    </span>
  );
}
