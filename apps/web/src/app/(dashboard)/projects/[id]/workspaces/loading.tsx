import { Skeleton } from "@/components/ui/skeleton";

export default function WorkspacesLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-4 sm:px-8 sm:py-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className="h-44" />
      <Skeleton className="h-44" />
    </div>
  );
}
