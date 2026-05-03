import { Link } from "wouter";
import { BarChart2 } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
      <BarChart2 className="w-12 h-12 text-muted-foreground opacity-30" />
      <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">This page doesn't exist.</p>
      <Link href="/">
        <a className="text-primary text-sm hover:underline">← Back to Dashboard</a>
      </Link>
    </div>
  );
}
