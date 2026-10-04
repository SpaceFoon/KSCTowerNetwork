import { useEffect, useRef, useState } from "react";
import { loadSystemCatalog, type SystemCatalog } from "./systemCatalog";

export type SystemCatalogState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; catalog: SystemCatalog }
  | { kind: "missing" }; // No catalog bundled for this worldId — caller falls back to home-only UI.

/**
 * Loads the static system catalog matching `worldId`. Stays in `missing` for unknown packs (or
 * when worldId is null / starts with `unknown-`); the rest of the UI should treat that as "no
 * solar-system features available, render the existing single-body view".
 *
 * Cached by worldId — re-mounts and worldId churn don't refetch.
 */
export function useSystemCatalog(worldId: string | null | undefined): SystemCatalogState {
  const [state, setState] = useState<SystemCatalogState>({ kind: "idle" });
  const seqRef = useRef(0);

  useEffect(() => {
    const id = (worldId ?? "").trim();
    if (!id || id.startsWith("unknown-")) {
      setState({ kind: "missing" });
      return;
    }

    const seq = ++seqRef.current;
    setState({ kind: "loading" });

    let cancelled = false;
    loadSystemCatalog(id)
      .then((cat) => {
        if (cancelled || seq !== seqRef.current) return;
        if (!cat) {
          setState({ kind: "missing" });
          return;
        }
        setState({ kind: "ready", catalog: cat });
      })
      .catch(() => {
        if (cancelled || seq !== seqRef.current) return;
        setState({ kind: "missing" });
      });

    return () => {
      cancelled = true;
    };
  }, [worldId]);

  return state;
}
