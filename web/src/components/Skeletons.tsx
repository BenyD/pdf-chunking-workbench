import { Skeleton } from "@/components/ui/skeleton";

/** Loading states that mirror the real layout so nothing jumps when data lands. */

export function DocumentsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-6 py-3 sm:px-0">
          <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-2/3 max-w-xs" /><Skeleton className="h-3 w-12" /></div>
          <Skeleton className="hidden h-4 w-10 sm:block" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="hidden h-4 w-24 md:block" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

export function ExplorerSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3"><Skeleton className="h-7 w-24" /><Skeleton className="h-7 w-72" /><Skeleton className="h-5 w-16 rounded-full" /></div>
      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-[1.25rem] bg-card p-4 ring-1 ring-black/5"><div className="flex justify-between"><Skeleton className="h-4 w-20" /><Skeleton className="h-3 w-24" /></div><div className="flex gap-1"><Skeleton className="h-5 w-14 rounded-full" /><Skeleton className="h-5 w-14 rounded-full" /><Skeleton className="h-5 w-16 rounded-full" /></div></div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2"><Skeleton className="h-8 w-56" /><Skeleton className="aspect-[1/1.41] w-full rounded-xl" /></div>
        <ChunkListSkeleton />
      </div>
    </div>
  );
}

export function ChunkListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-[1.25rem] bg-card p-3 ring-1 ring-black/5">
          <div className="flex gap-2"><Skeleton className="h-5 w-14 rounded-full" /><Skeleton className="h-4 w-8" /><Skeleton className="h-4 w-10" /><Skeleton className="ml-auto h-4 w-12" /></div>
          <Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-5/6" />
        </div>
      ))}
    </div>
  );
}

export function ResultsSkeleton({ columns = 3, perColumn = 3 }: { columns?: number; perColumn?: number }) {
  return (
    <div className={`grid gap-3 ${columns === 2 ? "md:grid-cols-2" : columns === 3 ? "lg:grid-cols-3" : ""}`}>
      {Array.from({ length: columns }).map((_, c) => (
        <div key={c} className="space-y-2">
          <Skeleton className="h-5 w-28 rounded-full" />
          <ChunkListSkeleton count={perColumn} />
        </div>
      ))}
    </div>
  );
}

export function EvalSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-[1.25rem] bg-card p-4 ring-1 ring-black/5"><Skeleton className="h-5 w-24 rounded-full" /><Skeleton className="h-9 w-20" /><Skeleton className="h-3 w-40" /></div>
      ))}
    </div>
  );
}
