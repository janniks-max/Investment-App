import { cn } from "@/lib/utils";

interface ScoreBarProps {
  score: number | null | undefined;
  label?: string;
  showValue?: boolean;
  size?: "xs" | "sm";
}

function getScoreColor(score: number): string {
  if (score >= 62) return "bg-green-500/80";
  if (score >= 50) return "bg-yellow-500/70";
  if (score >= 38) return "bg-orange-500/70";
  return "bg-red-500/70";
}

export default function ScoreBar({ score, label, showValue = true, size = "sm" }: ScoreBarProps) {
  if (score === null || score === undefined) {
    return (
      <div className="flex items-center gap-2">
        {label && <span className="text-xs text-muted-foreground w-20 flex-shrink-0">{label}</span>}
        <span className="text-xs text-muted-foreground">—</span>
      </div>
    );
  }

  const pct = Math.min(100, Math.max(0, score));
  const color = getScoreColor(pct);
  const height = size === "xs" ? "h-1" : "h-1.5";

  return (
    <div className="flex items-center gap-2 w-full">
      {label && <span className="text-xs text-muted-foreground w-20 flex-shrink-0">{label}</span>}
      <div className={cn("flex-1 bg-secondary rounded-full overflow-hidden", height)}>
        <div
          className={cn("score-bar-fill h-full rounded-full", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showValue && (
        <span className="text-xs font-mono text-muted-foreground w-7 text-right">{Math.round(pct)}</span>
      )}
    </div>
  );
}
