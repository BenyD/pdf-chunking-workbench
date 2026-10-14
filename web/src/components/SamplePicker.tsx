"use client";
import { useEffect, useMemo, useState } from "react";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemStatus, ItemTitle } from "@/components/quartz/ui/item";
import { SAMPLES } from "@/lib/samples";

/** Pick which sample documents to load, with the first page of the one last ticked beside the list. */
export function SamplePicker({ open, onOpenChange, loaded, onLoad }: {
  open: boolean; onOpenChange: (open: boolean) => void; loaded: Set<string>; onLoad: (keys: string[]) => Promise<void>;
}) {
  const available = useMemo(() => SAMPLES.filter((s) => !loaded.has(s.key)), [loaded]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string>(SAMPLES[0].key);

  useEffect(() => { if (open) { setSelected(new Set(available.map((s) => s.key))); setPreview(available[0]?.key ?? SAMPLES[0].key); } }, [open, available]);

  const current = SAMPLES.find((s) => s.key === preview) ?? SAMPLES[0];
  const name = (n: string) => n.replace(/\.pdf$/i, "");
  const toggle = (key: string) => {
    setPreview(key);
    setSelected((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Load sample documents</DialogTitle>
          <DialogDescription>Each one is processed in the background and appears in the list as it finishes.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4 md:grid-cols-2">
            <ItemGroup>
              <ul>
                {SAMPLES.map((s) => {
                  const isLoaded = loaded.has(s.key);
                  return (
                    <li key={s.key}>
                      <Item render={isLoaded ? undefined : <label />}>
                        {!isLoaded && <Checkbox checked={selected.has(s.key)} onCheckedChange={() => toggle(s.key)} />}
                        <ItemContent>
                          <ItemTitle>{name(s.name)}</ItemTitle>
                          <ItemDescription>{s.pages} {s.pages === 1 ? "page" : "pages"}. {s.blurb}</ItemDescription>
                        </ItemContent>
                        {isLoaded && <ItemStatus status="ok">Loaded</ItemStatus>}
                      </Item>
                    </li>
                  );
                })}
              </ul>
            </ItemGroup>
            <figure className="min-w-0">
              <div className="frame overflow-hidden bg-paper">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img key={current.key} src={`/samples/previews/${current.key}.png`} alt={`First page of ${name(current.name)}`} className="block h-48 w-full object-cover object-top md:h-96" />
              </div>
              <figcaption className="mt-2 type-body-sm text-text-2">First page of {name(current.name)}</figcaption>
            </figure>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <DialogAction disabled={selected.size === 0} pendingLabel="Loading" onAction={async () => { await onLoad([...selected]); }}>
            Load {selected.size} {selected.size === 1 ? "document" : "documents"}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
