import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ACCOUNT_CALLSIGN_HELP } from "../tower/callsignTooltips";
import { setStoredToken } from "../api/client";
import { fetchSiteInfo, type RegisterRequest, type SiteInfo } from "../api/site";
import { authUserFromResponse, setStoredUser, type AuthUser } from "../auth/session";
import { ApiError, apiCall, useApiMutation, useApiQuery, useQueryClient } from "../query/hooks";
import { queryKeys } from "../query/client";

type Props = {
  /**
   * Same callback shape as `LoginPage` so the parent (`App.tsx`) can flip into
   * the authed shell the instant signup or guest-join succeeds, without
   * waiting for the next /v1/auth/me refetch.
   */
  onLogin: (user: AuthUser) => void;
};

type AuthResponse = {
  ok?: boolean;
  token?: string;
  user?: unknown;
};

const FALLBACK_TAGLINE =
  "Real human ATC for Kerbal Space Program. Pilots talk to controllers over LiveKit voice while the in-game plugin streams telemetry to the web tower map (and optional HullCam snapshots when those mods are installed).";

/**
 * Public landing page. Mounted at `/` for unauthenticated users.
 *
 * Three jobs, in order of importance:
 *   1. Sell the project (hero + what-you-get list) so a first-time visitor
 *      knows what they just clicked into.
 *   2. Get them through the door: sign up (or invite-redeem), sign in if they
 *      already have an account, or "join as guest" for read-only lobby access.
 *   3. Hand them the plugin and the setup steps so the in-game half of the
 *      experience actually works after they sign up.
 *
 * Everything visitor-facing comes from `/v1/site/info` so a deployer can
 * rebrand the page (project name, plugin URLs, repo/Discord links, signup
 * mode) by editing env vars without touching this file.
 */
export function LandingPage({ onLogin }: Props): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const siteQuery = useApiQuery<SiteInfo>({
    queryKey: queryKeys.site.info,
    queryFn: fetchSiteInfo,
    // Site info is effectively static between deploys; cache hard so navigating
    // away and back doesn't re-hit the backend.
    staleTime: 5 * 60 * 1000
  });
  const site = siteQuery.data;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [callsign, setCallsign] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"ok" | "error" | "">("");

  function applyAuthResponse(token: string, payload: unknown): boolean {
    const user = authUserFromResponse(payload);
    if (!user) {
      setStatusKind("error");
      setStatus("Server response was missing required user fields.");
      return false;
    }
    setStoredToken(token);
    setStoredUser(user);
    onLogin(user);
    navigate("/lobby", { replace: true });
    return true;
  }

  const registerMutation = useApiMutation<AuthResponse, RegisterRequest>({
    mutationFn: (vars) =>
      apiCall<AuthResponse>("/v1/auth/register", { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: (data) => {
      if (typeof data.token !== "string" || !data.token) {
        setStatusKind("error");
        setStatus("Signup response was missing token.");
        return;
      }
      // Force /auth/me to refetch immediately so capabilities are live before
      // the user lands on /lobby.
      void qc.invalidateQueries({ queryKey: queryKeys.auth.me });
      applyAuthResponse(data.token, data.user);
    },
    onError: (e) => {
      setStatusKind("error");
      setStatus(e instanceof ApiError ? e.message : (e as Error).message);
    }
  });

  const guestMutation = useApiMutation<AuthResponse, void>({
    mutationFn: () =>
      apiCall<AuthResponse>("/v1/auth/guest", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (data) => {
      if (typeof data.token !== "string" || !data.token) {
        setStatusKind("error");
        setStatus("Guest response was missing token.");
        return;
      }
      void qc.invalidateQueries({ queryKey: queryKeys.auth.me });
      applyAuthResponse(data.token, data.user);
    },
    onError: (e) => {
      setStatusKind("error");
      setStatus(e instanceof ApiError ? e.message : (e as Error).message);
    }
  });

  const registration = site?.registration;
  const signupEnabled = registration?.signupEnabled === true;
  const inviteRequired = registration?.inviteRequired === true;
  const inviteAccepted = registration?.inviteAccepted === true;
  const minPasswordLen = registration?.passwordMinLength ?? 8;

  const busy = registerMutation.isPending || guestMutation.isPending;

  function onSignupSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setStatus("");
    setStatusKind("");
    if (!email.trim() || !password || !callsign.trim()) {
      setStatusKind("error");
      setStatus("Email, callsign, and password are all required.");
      return;
    }
    if (password.length < minPasswordLen) {
      setStatusKind("error");
      setStatus(`Password must be at least ${minPasswordLen} characters.`);
      return;
    }
    if (inviteRequired && !inviteCode.trim()) {
      setStatusKind("error");
      setStatus("This server is invite-only. Paste your invite code above.");
      return;
    }
    registerMutation.mutate({
      email: email.trim(),
      password,
      callsign: callsign.trim(),
      displayName: callsign.trim(),
      inviteCode: inviteCode.trim() || undefined
    });
  }

  function joinAsGuest(): void {
    setStatus("");
    setStatusKind("");
    guestMutation.mutate();
  }

  const projectName = site?.project.displayName ?? "KSC Tower Network";
  const tagline = site?.project.tagline ?? FALLBACK_TAGLINE;
  const ckanId = site?.plugin.ckanIdentifier ?? null;
  const downloadUrl = site?.plugin.downloadUrl ?? null;
  const repoUrl = site?.project.repoUrl ?? null;
  const discordUrl = site?.project.discordUrl ?? null;

  return (
    <div className="landing">
      <header className="landing-hero">
        <div className="landing-hero-inner">
          <div className="landing-hero-copy">
            <div className="landing-brand">
              <span className="landing-brand-mark" aria-hidden>KSC</span>
              <span className="landing-brand-name">{projectName}</span>
            </div>
            <h1 className="landing-hero-title">Real human ATC for Kerbal Space Program.</h1>
            <p className="landing-hero-tagline">{tagline}</p>
            <div className="landing-hero-cta">
              <a href="#get-started" className="landing-cta landing-cta-primary">
                {signupEnabled ? "Sign up" : "Sign in"}
              </a>
              <a href="#download" className="landing-cta landing-cta-secondary">
                Get the plugin
              </a>
              <button
                type="button"
                className="landing-cta landing-cta-ghost"
                onClick={joinAsGuest}
                disabled={busy}
                title="Lobby text chat only. No voice, no plugin. Banned by IP if abusive."
              >
                {guestMutation.isPending ? "Joining..." : "Try as guest"}
              </button>
            </div>
          </div>
          <figure className="landing-hero-art">
            <img
              src="/ksc-tower-social-preview.jpg"
              alt="KSC Tower overlooking a Kerbal launch complex, with nearby aircraft on radar."
              decoding="async"
            />
          </figure>
        </div>
      </header>

      <section className="landing-features">
        <h2 className="landing-section-title">What you get</h2>
        <ul className="landing-feature-grid">
          <li className="landing-feature">
            <h3>Live ATC voice</h3>
            <p>
              Push-to-talk on a real radio prop in your cockpit, routed through LiveKit to a
              human controller in the web tower. Per-frequency channels, squelch tail, and
              optional Kerbalizer DSP.
            </p>
          </li>
          <li className="landing-feature">
            <h3>Tower view & ghost fleet</h3>
            <p>
              The plugin streams telemetry every few seconds. Other pilots show up as ghost
              aircraft in your scene and as live blips on the tower controller's map.
            </p>
          </li>
          <li className="landing-feature">
            <h3>Clearances, map, and roleplay workflow</h3>
            <p>
              Controllers set structured clearance states (takeoff, landing, taxi, and
              more) that sync to the strip and the pilot HUD. The tower map shows traffic,
              airfields, and simplified final-approach cues for supported Kerbin layouts.
              Voice, shared checklists, and ACARS fit whatever level of procedure your
              session wants.
            </p>
          </li>
          <li className="landing-feature">
            <h3>Mods supported</h3>
            <p>
              ASET / RPM / MAS cockpits with auto-synced COMM radio; Hullcam VDS Continued
              plus JRTI HullCam to stream camera snapshots to the tower; kOS terminal mirror;
              Kerbalism radiation telemetry.
            </p>
          </li>
        </ul>
      </section>

      <section id="get-started" className="landing-getstarted">
        <h2 className="landing-section-title">Get started</h2>
        <div className="landing-getstarted-grid">
          {/* Sign-up panel: render the actual form OR an explanation if signup is closed. */}
          <div className="landing-card landing-signup-card">
            <h3 className="landing-card-title">
              {signupEnabled ? "Create an account" : "Accounts on this server"}
            </h3>
            {!siteQuery.data && siteQuery.isLoading ? (
              <p className="landing-muted">Loading server settings...</p>
            ) : !signupEnabled ? (
              <>
                <p className="landing-muted">
                  This server is closed to public signup. Ask the server owner for an invite
                  or for an account to be created for you.
                </p>
                <p className="landing-muted">
                  If you already have credentials, sign in below.
                </p>
                <Link to="/login" className="landing-cta landing-cta-primary landing-cta-block">
                  Sign in
                </Link>
              </>
            ) : (
              <form onSubmit={onSignupSubmit}>
                <p className="landing-muted landing-signup-blurb">
                  These same credentials log you into the web tower AND into the KSP plugin
                  in-game. {inviteRequired ? "An invite code is required." : null}
                </p>

                <label htmlFor="signup-callsign" title={ACCOUNT_CALLSIGN_HELP}>
                  Callsign
                </label>
                <input
                  id="signup-callsign"
                  type="text"
                  autoComplete="nickname"
                  value={callsign}
                  onChange={(e) => setCallsign(e.target.value)}
                  placeholder="How tower and pilots see you"
                  maxLength={120}
                  title={ACCOUNT_CALLSIGN_HELP}
                />

                <label htmlFor="signup-email" style={{ marginTop: "0.6rem" }}>
                  Email
                </label>
                <input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />

                <label htmlFor="signup-password" style={{ marginTop: "0.6rem" }}>
                  Password <span className="landing-muted-inline">({minPasswordLen}+ characters)</span>
                </label>
                <input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={minPasswordLen}
                  placeholder="********"
                />

                {inviteAccepted ? (
                  <>
                    <label htmlFor="signup-invite" style={{ marginTop: "0.6rem" }}>
                      Invite code{" "}
                      <span className="landing-muted-inline">
                        ({inviteRequired ? "required" : "optional"})
                      </span>
                    </label>
                    <input
                      id="signup-invite"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value.trim())}
                      placeholder="paste code here"
                      maxLength={64}
                    />
                  </>
                ) : null}

                <button
                  type="submit"
                  className="landing-cta landing-cta-primary landing-cta-block"
                  style={{ marginTop: "1rem" }}
                  disabled={busy}
                >
                  {registerMutation.isPending ? "Creating account..." : "Create account"}
                </button>

                <p className="landing-signin-aside">
                  Already have an account? <Link to="/login">Sign in</Link>.
                </p>

                {status ? (
                  <pre className={`msg ${statusKind === "error" ? "error" : "ok"}`}>{status}</pre>
                ) : null}
              </form>
            )}
          </div>

          {/* Setup steps: walk a brand-new player from "I just signed up" to "I'm on a runway talking to ATC." */}
          <div className="landing-card landing-steps-card">
            <h3 className="landing-card-title">After you sign up</h3>
            <ol className="landing-steps">
              <li>
                <strong>Install the plugin</strong> — see the install snippet below. It
                drops a few DLLs into <code>GameData/KSCTowerNetwork/</code>.
              </li>
              <li>
                <strong>Launch KSP</strong> — open the in-game settings panel
                (<em>Tower → Settings</em>) and paste the same email + password you used
                here. The plugin verifies the credentials against this server on first use.
              </li>
              <li>
                <strong>Hop in the cockpit</strong> — find the COMM radio prop on the
                panel (or the floating PTT window if your IVA doesn't have one), tune to
                ground / tower / approach, and key the mic.
              </li>
              <li>
                <strong>Open the lobby here</strong> — once you're signed in on this site
                you'll see other pilots in flight, queue for a controller slot if you want
                to work tower yourself, and watch tower-view feeds.
              </li>
            </ol>
            <p className="landing-muted">
              Stuck? The full operator runbook lives in the project README — link in the
              footer below.
            </p>
          </div>
        </div>
      </section>

      <section id="download" className="landing-download">
        <h2 className="landing-section-title">Get the plugin</h2>
        <div className="landing-download-grid">
          <div className="landing-card">
            <h3 className="landing-card-title">CKAN (recommended)</h3>
            <p className="landing-muted">
              CKAN handles dependencies (ModuleManager, ClickThroughBlocker, RasterPropMonitor,
              etc.) automatically and updates the mod for you when there's a new release.
            </p>
            {ckanId ? (
              <>
                <ol className="landing-install">
                  <li>
                    Install the{" "}
                    <a href="https://github.com/KSP-CKAN/CKAN/releases/latest" target="_blank" rel="noreferrer">
                      CKAN client
                    </a>{" "}
                    if you don't already have it.
                  </li>
                  <li>Open CKAN and point it at your KSP install.</li>
                  <li>
                    Search for{" "}
                    <code className="landing-code">{ckanId}</code>, tick it, and apply.
                  </li>
                  <li>
                    Recommended dependencies (PTT prop, hull cams, kOS terminal mirror,
                    etc.) will be offered in the same install pass — accept them all unless
                    you have a reason not to.
                  </li>
                </ol>
                {site?.plugin.ckanCatalogUrl ? (
                  <a
                    href={site.plugin.ckanCatalogUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="landing-cta landing-cta-secondary landing-cta-block"
                  >
                    View in CKAN-meta
                  </a>
                ) : null}
              </>
            ) : (
              <p className="landing-muted">
                CKAN identifier hasn't been set on this server yet. Use the manual download
                on the right.
              </p>
            )}
          </div>

          <div className="landing-card">
            <h3 className="landing-card-title">Manual install</h3>
            <p className="landing-muted">
              For players who don't use CKAN, or who want a specific release pinned in
              place. You'll need to install ModuleManager and (recommended)
              ClickThroughBlocker separately.
            </p>
            <ol className="landing-install">
              <li>Download the latest release ZIP.</li>
              <li>
                Extract the <code>GameData/</code> folder from the ZIP into your KSP root
                (so you end up with <code>KSP/GameData/KSCTowerNetwork/</code>).
              </li>
              <li>Launch KSP and confirm the plugin loads on the main menu.</li>
            </ol>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="landing-cta landing-cta-primary landing-cta-block"
              >
                Download release ZIP
              </a>
            ) : (
              <p className="landing-muted">
                The deployer of this server hasn't pinned a download URL yet. Ask them for
                a release link, or grab the source from the project repo.
              </p>
            )}
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <span className="landing-footer-brand">{projectName}</span>
          <nav className="landing-footer-links">
            <Link to="/login">Sign in</Link>
            <button
              type="button"
              className="landing-footer-link-btn"
              onClick={joinAsGuest}
              disabled={busy}
            >
              Join as guest
            </button>
            {repoUrl ? (
              <a href={repoUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            ) : null}
            {discordUrl ? (
              <a href={discordUrl} target="_blank" rel="noreferrer">
                Discord
              </a>
            ) : null}
          </nav>
        </div>
      </footer>
    </div>
  );
}
