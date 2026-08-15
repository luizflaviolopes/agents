import { Skeleton } from "@/components/ui/skeleton";

export default function ActivityLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-4 sm:px-8 sm:py-6">
      <Skeleton className="h-4 w-64" />
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  );
}
