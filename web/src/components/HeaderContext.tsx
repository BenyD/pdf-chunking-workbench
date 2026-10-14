"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Crumb = { label: string; href?: string };
type Ctx = { crumbs: Crumb[] | null; setCrumbs: (c: Crumb[] | null) => void };
const HeaderCtx = createContext<Ctx>({ crumbs: null, setCrumbs: () => {} });

export function HeaderProvider({ children }: { children: ReactNode }) {
  const [crumbs, setCrumbs] = useState<Crumb[] | null>(null);
  return <HeaderCtx.Provider value={{ crumbs, setCrumbs }}>{children}</HeaderCtx.Provider>;
}

export function useHeaderCrumbs() { return useContext(HeaderCtx); }

/** Pages call this to put their breadcrumb in the header; it clears on unmount. */
export function useCrumbs(crumbs: Crumb[] | null) {
  const { setCrumbs } = useContext(HeaderCtx);
  const key = JSON.stringify(crumbs);
  useEffect(() => { setCrumbs(crumbs); return () => setCrumbs(null); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setCrumbs]);
}
