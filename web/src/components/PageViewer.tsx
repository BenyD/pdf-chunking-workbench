"use client";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { BBox } from "@/lib/types";
import { TYPE_STYLE } from "@/lib/ui";
import { cn } from "@/lib/utils";

export interface Overlay { id: string; type: keyof typeof TYPE_STYLE; box: BBox; label?: string; selected?: boolean }

/** A rendered page with boxes on top. Boxes are fractions of the page, so CSS percentages scale them to any width. */
export function PageViewer({ imageUrl, overlays, onSelect, children, className }: {
  imageUrl: string; overlays: Overlay[]; onSelect?: (id: string) => void; children?: React.ReactNode; className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={cn("relative overflow-hidden rounded-xl border bg-white shadow-sm select-none", className)}>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="page" className={cn("block w-full transition-opacity", loaded ? "opacity-100" : "opacity-0")} draggable={false} onLoad={() => setLoaded(true)} style={loaded ? undefined : { aspectRatio: "1 / 1.41" }} />
      {loaded && overlays.map((o) => {
        const s = TYPE_STYLE[o.type] ?? TYPE_STYLE.text;
        return (
          <button key={o.id} type="button" title={o.label} onClick={() => onSelect?.(o.id)}
            className={cn("absolute border transition", s.box, o.selected && "z-10 ring-2 ring-foreground ring-offset-1")}
            style={{ left: `${o.box.x0 * 100}%`, top: `${o.box.y0 * 100}%`, width: `${(o.box.x1 - o.box.x0) * 100}%`, height: `${(o.box.y1 - o.box.y0) * 100}%` }} />
        );
      })}
      {children}
    </div>
  );
}
