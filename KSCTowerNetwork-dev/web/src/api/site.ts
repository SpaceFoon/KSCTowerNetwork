import { apiCall } from "../query/hooks";

/**
 * Public site/landing-page metadata. Mirrors the JSON shape returned by
 * `GET /v1/site/info` exactly so downstream renders type-check against the
 * server contract; if a field is added on the backend, add it here too.
 *
 * The endpoint is deliberately unauthenticated and cached aggressively
 * (defaults to 5 minutes via the React Query stale time at the call site)
 * because every byte of it is publicly safe — nothing here is a secret.
 */
export type SiteInfo = {
  ok: true;
  project: {
    displayName: string;
    tagline: string;
    repoUrl: string | null;
    discordUrl: string | null;
  };
  plugin: {
    /** CKAN catalog identifier (e.g. "KSCTowerNetwork"). Drives the install snippet. */
    ckanIdentifier: string | null;
    /** Convenience URL into the public CKAN-meta listing. */
    ckanCatalogUrl: string | null;
    /** Manual fallback download (typically GitHub Releases). */
    downloadUrl: string | null;
    /** In-game radio ◀ / ▶ quick-tune channels (id, label, MHz). */
    radioPresets: { id: string; label: string; frequencyMhz: string }[];
  };
  registration: {
    mode: "closed" | "open" | "invite_only" | "open_or_invite";
    defaultRole: "guest" | "pilot" | "controller" | "mod" | "supermod";
    signupEnabled: boolean;
    inviteRequired: boolean;
    inviteAccepted: boolean;
    passwordMinLength: number;
  };
};

export async function fetchSiteInfo(): Promise<SiteInfo> {
  return apiCall<SiteInfo>("/v1/site/info");
}

export type RegisterRequest = {
  email: string;
  password: string;
  /** Pilot callsign. Same as legacy `displayName` on the API — send either or both. */
  callsign: string;
  displayName?: string;
  inviteCode?: string;
};
