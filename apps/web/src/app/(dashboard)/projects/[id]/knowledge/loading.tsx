import { Skeleton } from "@/components/ui/skeleton";

export default function KnowledgeLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:px-8 sm:py-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
