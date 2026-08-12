import { Skeleton } from "@/components/ui/skeleton";

export default function ReviewLoading() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <Skeleton className="mb-5 h-4 w-96" />
      <div className="space-y-4">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}
