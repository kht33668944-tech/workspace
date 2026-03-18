export default function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse bg-[var(--bg-elevated)] rounded ${className ?? "h-5 w-16"}`}
    />
  );
}
