import { Skeleton } from "@/components/ui/skeleton";

export default function ReviewLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:px-8 sm:py-6">
      <Skeleton className="mb-5 h-4 w-96" />
      <div className="space-y-4">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}
