import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { setStoredToken } from "../api/client";
import { authUserFromResponse, type AuthUser, setStoredUser } from "../auth/session";
import { ApiError, apiCall, useApiMutation } from "../query/hooks";

type Props = {
  onLogin: (user: AuthUser) => void;
};

type AuthResponse = {
  ok?: boolean;
  token?: string;
  user?: unknown;
};

type DevLoginPreset = {
  id: string;
  label: string;
  email: string;
  password: string;
};

/**
 * Dev-only quick-fill presets, read from VITE_DEV_LOGIN_PRESETS in
 * web/.env.development. Kept out of source so the credential list lives next
 * to the backend's WEB_LOGIN_USERS_JSON in env files instead of being
 * hardcoded in two places.
 *
 * Parsed once at module load. Bad/missing JSON returns an empty list and
 * the dropdown simply doesn't render — we don't want a typo here to break
 * the login form for everyone.
 */
function parseDevLoginPresets(): ReadonlyArray<DevLoginPreset> {
  const raw = import.meta.env.VITE_DEV_LOGIN_PRESETS;
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[LoginPage] VITE_DEV_LOGIN_PRESETS is not valid JSON; dropdown disabled.", err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DevLoginPreset[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const label = typeof e.label === "string" ? e.label : "";
    const email = typeof e.email === "string" ? e.email : "";
    const password = typeof e.password === "string" ? e.password : "";
    if (!id || !label || !email || !password) continue;
    out.push({ id, label, email, password });
  }
  return out;
}

const DEV_LOGIN_PRESETS = parseDevLoginPresets();

export function LoginPage({ onLogin }: Props): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState(DEV_LOGIN_PRESETS[0]?.email ?? "");
  const [password, setPassword] = useState(DEV_LOGIN_PRESETS[0]?.password ?? "");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState(false);

  function applyAuthResponse(token: string, payload: unknown): boolean {
    const user = authUserFromResponse(payload);
    if (!user) {
      setErr(true);
      setStatus("Server response was missing required user fields.");
      return false;
    }
    setStoredToken(token);
    setStoredUser(user);
    onLogin(user);
    navigate("/lobby", { replace: true });
    return true;
  }

  // Distinct mutations for password vs guest so each button has its own
  // isPending state — the form should disable both buttons whenever either
  // is in flight, but only the in-flight one shows the spinner label.
  const loginMutation = useApiMutation<AuthResponse, { email: string; password: string }>({
    mutationFn: (vars) =>
      apiCall<AuthResponse>("/v1/auth/login", { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: (data) => {
      if (typeof data.token !== "string" || !data.token) {
        setErr(true);
        setStatus("Login response was missing token.");
        return;
      }
      applyAuthResponse(data.token, data.user);
    },
    onError: (e) => {
      setErr(true);
      setStatus(e instanceof ApiError ? e.message : (e as Error).message);
    }
  });
  const guestMutation = useApiMutation<AuthResponse, void>({
    mutationFn: () =>
      apiCall<AuthResponse>("/v1/auth/guest", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (data) => {
      if (typeof data.token !== "string" || !data.token) {
        setErr(true);
        setStatus("Guest response was missing token.");
        return;
      }
      applyAuthResponse(data.token, data.user);
    },
    onError: (e) => {
      setErr(true);
      setStatus(e instanceof ApiError ? e.message : (e as Error).message);
    }
  });

  const busy = loginMutation.isPending;
  const guestBusy = guestMutation.isPending;

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!email.trim() || !password) {
      setErr(true);
      setStatus("Email and password are required.");
      return;
    }
    setStatus("");
    setErr(false);
    loginMutation.mutate({
      email: email.trim(),
      password
    });
  }

  function joinAsGuest(): void {
    setStatus("");
    setErr(false);
    guestMutation.mutate();
  }


  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>KSC Tower</h1>
        <p className="auth-subtitle">Sign in with email and password to enter tower operations.</p>
        <form onSubmit={(e) => void onSubmit(e)}>
          {import.meta.env.DEV && DEV_LOGIN_PRESETS.length > 0 ? (
            <>
              <label htmlFor="login-dev-preset">
                Dev quick-fill <span style={{ opacity: 0.6, fontWeight: "normal" }}>(local only)</span>
              </label>
              <select
                id="login-dev-preset"
                defaultValue=""
                onChange={(e) => {
                  const preset = DEV_LOGIN_PRESETS.find((p) => p.id === e.target.value);
                  if (!preset) return;
                  setEmail(preset.email);
                  setPassword(preset.password);
                  e.target.value = "";
                }}
                style={{ marginBottom: "0.75rem" }}
              >
                <option value="" disabled>
                  Pick a test account...
                </option>
                {DEV_LOGIN_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.email}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />

          <label htmlFor="login-password" style={{ marginTop: "0.75rem" }}>
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="********"
          />

          <button type="submit" style={{ marginTop: "1rem", width: "100%" }} disabled={busy || guestBusy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div className="auth-divider" role="separator" aria-label="or">
          <span>or</span>
        </div>

        <button
          type="button"
          className="auth-guest-btn"
          style={{ width: "100%" }}
          onClick={joinAsGuest}
          disabled={busy || guestBusy}
          title="Lobby text chat only. No voice, no game plugin. Banned by IP if abusive."
        >
          {guestBusy ? "Joining as guest..." : "Join as guest (text only)"}
        </button>
        <p className="auth-guest-note">
          Guests can read and post in the lobby chat only. Voice and the KSP plugin require a signed-in account.
        </p>

        {status ? <pre className={`msg ${err ? "error" : "ok"}`}>{status}</pre> : null}
      </div>
    </div>
  );
}
