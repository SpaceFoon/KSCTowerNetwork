using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Pilot-side auto-call. Once the plugin has a tower auth token (either loaded from
    /// auth.cfg at startup or freshly minted by <see cref="TowerLoginGui"/>), this addon
    /// makes sure the player actually has a server-side radio channel: it first checks
    /// <c>GET /v1/me/active-room</c> to honor any room the pilot is already in, and
    /// otherwise POSTs <c>/v1/session/call</c> for the canonical tower frequency so
    /// the backend can pull the next queued controller via <c>claimNextTowerForSession</c>.
    /// </summary>
    /// <remarks>
    /// Without this, opening KSP did nothing on the backend until the player explicitly
    /// requested a launch — meaning a controller who joined the queue from the web
    /// would sit forever with "1 waiting" because no pilot session ever existed for
    /// the queue to be drained into. The addon persists across scenes; a fresh login
    /// cancels old requests and restarts room adoption for the selected server.
    ///
    /// <para>
    /// Dev / <see cref="TowerModSettings.SkipTowerLogin"/> mode also runs this addon
    /// (it used to short-circuit). The token wait is skipped and the request goes
    /// out unauthenticated — the backend's <c>DEV_OPEN_AUTH</c> path accepts that
    /// and stamps the dev principal (<c>DEV_USER_ID</c>, default role <c>owner</c>),
    /// which passes the controller-rank gate on <c>/session/call</c>. The resulting
    /// real room appears in the lobby instead of the bridge squatting on the
    /// hidden <c>dev-shared</c> bootstrap session.
    /// </para>
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.FlightAndKSC, true)]
    public class TowerSessionAutoCall : MonoBehaviour
    {
        private static bool _done;
        private static TowerSessionAutoCall _instance;
        private bool _started;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            DontDestroyOnLoad(gameObject);
        }

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }

        public static void RestartForLogin()
        {
            _done = false;
            if (_instance != null && _instance._started)
            {
                // Cancel old-server requests before a new login can claim its room.
                _instance.StopAllCoroutines();
                _instance.StartCoroutine(_instance.EnsurePilotSessionRoutine());
            }
        }

        // How long to wait for a token to appear before giving up. Covers the case where
        // the player loads in, then takes a minute to type their credentials into the
        // login window. After this we just exit quietly; the next launch will try again.
        private const float TokenWaitSeconds = 300f;
        private const float PollIntervalSeconds = 1f;

        // Network retry budget for transient 5xx / connection refused. The backend may
        // not be up yet when KSP starts (esp. on dev where both are launched together).
        private const int MaxAttempts = 5;
        private const float RetryBackoffSeconds = 3f;

        private void Start()
        {
            _started = true;
            if (_done)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();

            StartCoroutine(EnsurePilotSessionRoutine());
        }

        private IEnumerator EnsurePilotSessionRoutine()
        {
            // SkipTowerLogin (dev / open-auth mode) means no token will ever appear —
            // skip the token wait and let the request go out unauthenticated. The
            // backend's `requireAuth` middleware accepts anonymous callers in dev
            // (DEV_OPEN_AUTH) and stamps them as the dev principal (DEV_USER_ID,
            // role DEV_USER_ROLE — default `owner`), which passes /session/call's
            // controller-rank gate. End result: a real tower room exists in the
            // lobby instead of the bridge sitting forever on the `dev-shared`
            // bootstrap session that's hidden from /v1/lobby/rooms.
            if (!TowerModSettings.SkipTowerLogin)
            {
                var waited = 0f;
                while (string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
                {
                    if (waited >= TokenWaitSeconds)
                    {
                        Debug.Log("[KSCTowerNetwork] Auto-call: no auth token within "
                            + TokenWaitSeconds + "s, skipping room creation.");
                        yield break;
                    }

                    yield return new WaitForSeconds(PollIntervalSeconds);
                    waited += PollIntervalSeconds;
                }
            }
            else
            {
                Debug.Log("[KSCTowerNetwork] Auto-call: SkipTowerLogin=true; calling "
                    + "backend anonymously — dev open-auth will mint a real room as "
                    + "the dev principal.");
            }

            // Self-heal stale tower_web tokens. Older logins (or logins where the
            // exchange step in TowerLoginGui failed silently) leave auth.cfg with a
            // `tower_web` JWT, which the backend stamps as tokenType:"clerk" — and
            // /v1/session/call's pilot exemption only fires for tokenType:"plugin"
            // (see api.ts: `isPluginCaller = req.auth?.tokenType === "plugin"`).
            // Without this self-heal, every game start with such a token gets a 403
            // on /session/call and the player sits forever on `dev-shared`.
            yield return EnsurePluginTokenRoutine();

            // Don't claim a room if the player is already in one (e.g. the controller
            // assigned to them on a prior call hasn't released yet, or the pilot
            // spectated into someone else's room from the web). Joining vs creating a
            // duplicate would orphan the existing session and confuse the lobby.
            // Coroutines can't return values, so the routine writes through the
            // `_existingRoomIdScratch` static; we read & clear it here.
            _existingRoomIdScratch = null;
            yield return CheckExistingRoomRoutine();
            var existingRoomId = _existingRoomIdScratch;
            _existingRoomIdScratch = null;

            if (!string.IsNullOrEmpty(existingRoomId))
            {
                Debug.Log("[KSCTowerNetwork] Auto-call: pilot already in room "
                    + existingRoomId + ", reusing it.");
                AdoptSessionId(existingRoomId);
                yield return TrySelfServeClaimRoutine(existingRoomId);
                _done = true;
                yield break;
            }

            // Self-heal: TowerModSettings.SessionId is the room we *thought* we owned
            // (persisted to auth.cfg from the last play session). The /me/active-room
            // probe above said we are not the pilot of any room. Two common reasons:
            //   1. The backend was restarted and our in-memory room is gone;
            //   2. Someone else took pilot while we were offline (e.g. via web takeover).
            //
            // Before minting a brand-new room with a different freq/name, ask the new
            // claim-pilot endpoint to *reclaim* our prior room if it still exists. That
            // keeps the player on the same lobby card / freq / chat history they expect.
            //
            // On 404/410 the helper falls through to the freq-only path, then up to the
            // outer create loop. So a stale id never blocks creating a fresh room.
            var staleSessionId = TowerModSettings.SessionId;
            if (!string.IsNullOrEmpty(staleSessionId))
            {
                string reclaimed = null;
                bool reclaimFatal = false;
                yield return ClaimPilotByIdRoutine(
                    staleSessionId,
                    (id, isFatal) => { reclaimed = id; reclaimFatal = isFatal; });

                if (!string.IsNullOrEmpty(reclaimed))
                {
                    Debug.Log("[KSCTowerNetwork] Auto-call: reclaimed pilot of room "
                        + reclaimed + " via claim-pilot self-heal.");
                    AdoptSessionId(reclaimed);
                    yield return TrySelfServeClaimRoutine(reclaimed);
                    _done = true;
                    yield break;
                }

                if (reclaimFatal)
                {
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call: claim-pilot self-heal "
                        + "refused (fatal); falling through to /session/call.");
                    // Fall through — the create-room path below has its own 4xx handling.
                }
            }

            for (var attempt = 1; attempt <= MaxAttempts; attempt++)
            {
                string newRoomId = null;
                bool fatal = false;
                yield return PostSessionCallRoutine(
                    (id, isFatal) => { newRoomId = id; fatal = isFatal; });

                if (!string.IsNullOrEmpty(newRoomId))
                {
                    Debug.Log("[KSCTowerNetwork] Auto-call: joined tower frequency session "
                        + newRoomId + " — queued controllers will be auto-assigned.");
                    AdoptSessionId(newRoomId);
                    yield return TrySelfServeClaimRoutine(newRoomId);
                    _done = true;
                    yield break;
                }

                if (fatal)
                {
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call: backend refused "
                        + "tower frequency join; not retrying.");
                    _done = true;
                    yield break;
                }

                if (attempt < MaxAttempts)
                {
                    yield return new WaitForSeconds(RetryBackoffSeconds);
                }
            }

            Debug.LogWarning("[KSCTowerNetwork] Auto-call: gave up after "
                + MaxAttempts + " attempts; no pilot session created.");
        }

        // ------- tower_web -> plugin_session self-heal --------------------------------

        /// <summary>
        /// If the persisted token is already a <c>plugin_session</c> JWT (or there's no
        /// token at all because <see cref="TowerModSettings.SkipTowerLogin"/> is on),
        /// this is a no-op. Otherwise we run the same two-step exchange that
        /// <see cref="TowerLoginGui"/> does on fresh logins
        /// (<c>POST /v1/auth/plugin/exchange-code</c> then <c>POST /v1/auth/plugin/exchange</c>),
        /// and persist the resulting plugin_session JWT back to auth.cfg via
        /// <see cref="TowerModSettings.SetTowerAuthToken"/>.
        /// <para/>
        /// Failure is non-fatal: if the exchange 4xx/5xx's, we keep the existing token
        /// and let <see cref="PostSessionCallRoutine"/> hit the 403 with the same
        /// message it would have without this routine — better than blocking the
        /// player on a flaky exchange endpoint.
        /// </summary>
        private IEnumerator EnsurePluginTokenRoutine()
        {
            if (TowerModSettings.SkipTowerLogin)
            {
                yield break;
            }

            var current = TowerModSettings.TowerAuthToken;
            if (string.IsNullOrEmpty(current))
            {
                yield break;
            }

            var currentType = ExtractJwtTokenType(current);
            if (string.Equals(currentType, "plugin_session", System.StringComparison.Ordinal))
            {
                // Already the right shape — nothing to do.
                yield break;
            }

            Debug.Log("[KSCTowerNetwork] Auto-call: persisted token type=\""
                + (currentType ?? "?")
                + "\" — exchanging for plugin_session so /session/call's pilot exemption fires.");

            string code = null;
            yield return RequestPluginExchangeCodeRoutine(current, c => code = c);
            if (string.IsNullOrEmpty(code))
            {
                Debug.LogWarning("[KSCTowerNetwork] Auto-call: exchange-code failed; "
                    + "keeping existing token (next /session/call will likely 403).");
                yield break;
            }

            string pluginToken = null;
            yield return RedeemPluginExchangeCodeRoutine(code, t => pluginToken = t);
            if (string.IsNullOrEmpty(pluginToken))
            {
                Debug.LogWarning("[KSCTowerNetwork] Auto-call: exchange redeem failed; "
                    + "keeping existing token (next /session/call will likely 403).");
                yield break;
            }

            TowerModSettings.SetTowerAuthToken(pluginToken);
            Debug.Log("[KSCTowerNetwork] Auto-call: persisted plugin_session token — "
                + "subsequent calls will pass /session/call's plugin gate.");
        }

        private IEnumerator RequestPluginExchangeCodeRoutine(string webToken, System.Action<string> done)
        {
            var url = TowerModSettings.ApiBaseUrl + "/auth/plugin/exchange-code";
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes("{}"));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                // Don't go through TowerApiAuth.ApplyBearer here — we deliberately want
                // to send the *current* token (which may not be the one ApplyBearer would
                // pick once we persist the new one mid-exchange).
                req.SetRequestHeader("Authorization", "Bearer " + webToken);
                req.timeout = 10;
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] exchange-code: HTTP "
                        + req.responseCode + " " + req.error);
                    done(null);
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                done(ExtractFirst(text, "\"code\"\\s*:\\s*\"([^\"]+)\""));
            }
        }

        private IEnumerator RedeemPluginExchangeCodeRoutine(string code, System.Action<string> done)
        {
            var url = TowerModSettings.ApiBaseUrl + "/auth/plugin/exchange";
            var bodyJson = "{\"code\":\"" + JsonEscape(code) + "\"}";
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(bodyJson));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 10;
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] exchange: HTTP "
                        + req.responseCode + " " + req.error);
                    done(null);
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                done(ExtractFirst(text, "\"token\"\\s*:\\s*\"([^\"]+)\""));
            }
        }

        /// <summary>
        /// Best-effort JWT payload sniff for the `token_type` claim. Returns null
        /// when the input isn't a parseable three-segment JWT or the payload doesn't
        /// contain a token_type — caller treats null as "not plugin_session, exchange".
        /// We deliberately do NOT verify the signature: this only decides whether to
        /// run the exchange round-trip, and an attacker who can forge a token_type
        /// claim already controls the plugin process anyway.
        /// </summary>
        private static string ExtractJwtTokenType(string jwt)
        {
            if (string.IsNullOrEmpty(jwt))
            {
                return null;
            }

            var parts = jwt.Split('.');
            if (parts.Length < 2)
            {
                return null;
            }

            try
            {
                var payload = Base64UrlDecode(parts[1]);
                if (payload == null)
                {
                    return null;
                }

                var json = Encoding.UTF8.GetString(payload);
                return ExtractFirst(json, "\"token_type\"\\s*:\\s*\"([^\"]+)\"");
            }
            catch
            {
                return null;
            }
        }

        private static byte[] Base64UrlDecode(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return null;
            }

            var t = s.Replace('-', '+').Replace('_', '/');
            switch (t.Length % 4)
            {
                case 2: t += "=="; break;
                case 3: t += "="; break;
                case 0: break;
                default: return null;
            }

            try
            {
                return System.Convert.FromBase64String(t);
            }
            catch
            {
                return null;
            }
        }

        // ------- self-serve tower claim ----------------------------------------------

        /// <summary>
        /// "Self-serve" mode (<see cref="TowerModSettings.SelfServeTower"/>): after we've
        /// either adopted an existing pilot room or created a new one, also POST
        /// <c>/v1/session/:id/claim-tower</c> so the same account holds the controller
        /// seat. Lets a solo / dev player be both pilot and tower for their own room
        /// without going through the queue dance.
        /// <para/>
        /// Failure modes are all soft: 403 (caller doesn't have controller+ rank), 409
        /// (someone else already grabbed the seat between our /session/call and this
        /// claim), 410 (room got closed), or any network error all just log and bail —
        /// the player still has the room as a regular pilot, the queue still works
        /// normally. Skipping silently when <c>SelfServeTower=false</c> preserves the
        /// pre-existing "pilot creates room, queue assigns controller" flow.
        /// </summary>
        private IEnumerator TrySelfServeClaimRoutine(string sessionId)
        {
            if (!TowerModSettings.SelfServeTower)
            {
                yield break;
            }

            if (string.IsNullOrEmpty(sessionId))
            {
                yield break;
            }

            // Token presence already checked by the outer routine, but the auth state
            // could have been cleared between then and now (e.g. user logged out from
            // the radio panel). Bail quietly so we don't 401 the backend log.
            if (string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                yield break;
            }

            var url = TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId)
                + "/claim-tower";

            using (var req = new UnityWebRequest(url, "POST"))
            {
                // Empty JSON body — endpoint takes no params, but Express's body parser is happier
                // with a real Content-Type than a zero-length POST that some proxies strip.
                var body = Encoding.UTF8.GetBytes("{}");
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 10;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    Debug.Log("[KSCTowerNetwork] Self-serve claim: network error ("
                        + req.error + ") — pilot session continues without self-tower.");
                    yield break;
                }

                if (req.isHttpError)
                {
                    var code = req.responseCode;
                    var text = req.downloadHandler != null ? Trim(req.downloadHandler.text, 200) : string.Empty;
                    if (code == 403)
                    {
                        Debug.Log("[KSCTowerNetwork] Self-serve claim: HTTP 403 — "
                            + "account lacks controller:assume capability. "
                            + "Pilot session continues; queue will assign a controller normally.");
                    }
                    else if (code == 409)
                    {
                        // Race: someone else (or the queue auto-claim from claimNextTowerForSession)
                        // grabbed the seat in the same window. Not a failure — the room has a
                        // controller, just not us.
                        Debug.Log("[KSCTowerNetwork] Self-serve claim: HTTP 409 — "
                            + "seat already taken: " + text);
                    }
                    else
                    {
                        Debug.LogWarning("[KSCTowerNetwork] Self-serve claim: HTTP "
                            + code + " — " + text);
                    }

                    yield break;
                }

                Debug.Log("[KSCTowerNetwork] Self-serve claim: now controlling own pilot session "
                    + sessionId + ".");
            }
        }

        // ------- existing-room probe ---------------------------------------------------

        // Coroutines can't have `out` parameters, so the routine writes through this
        // scratch field. Cleared by the caller after read. Kept here (not on the stack)
        // because the callback-style alternative would allocate a closure per poll.
        private static string _existingRoomIdScratch;

        private IEnumerator CheckExistingRoomRoutine()
        {
            var url = TowerModSettings.ApiBaseUrl + "/me/active-room";
            using (var req = UnityWebRequest.Get(url))
            {
                req.downloadHandler = new DownloadHandlerBuffer();
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    // Treat as "no existing room" — the POST below will surface real auth
                    // problems with a clearer status code.
                    Debug.Log("[KSCTowerNetwork] Auto-call: /me/active-room probe failed ("
                        + req.responseCode + "), continuing.");
                    yield break;
                }

                var body = req.downloadHandler != null ? req.downloadHandler.text : "";
                if (string.IsNullOrEmpty(body))
                {
                    yield break;
                }

                // Only adopt the existing room when the caller is the pilot of it. If they
                // are merely a spectator there, we still want to spin up their own pilot
                // session so the queued controller gets work.
                var role = ExtractFirst(body, "\"myRole\"\\s*:\\s*\"([^\"]+)\"");
                if (!string.Equals(role, "pilot", System.StringComparison.Ordinal))
                {
                    yield break;
                }

                var rid = ExtractFirst(body, "\"roomId\"\\s*:\\s*\"([^\"]+)\"");
                if (!string.IsNullOrEmpty(rid))
                {
                    _existingRoomIdScratch = rid;
                }
            }
        }

        // ------- POST /v1/session/claim-pilot (reclaim by sessionId) -----------------

        /// <summary>
        /// Try to (re)claim pilot of <paramref name="sessionId"/>. Used by the auto-call
        /// self-heal: when /me/active-room says we're not the pilot of anything but our
        /// auth.cfg still names a room, give that room one shot before creating a new one.
        /// <para/>
        /// Callback: <c>(reclaimed-id-on-success, fatal-on-failure)</c>. 404/410 are
        /// non-fatal "no such room / closed" — the outer routine falls through to the
        /// normal create path. 4xx other than 404/410 is fatal (auth problem; retrying
        /// won't help).
        /// </summary>
        private IEnumerator ClaimPilotByIdRoutine(string sessionId, System.Action<string, bool> done)
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                done(null, false);
                yield break;
            }

            var url = TowerModSettings.ApiBaseUrl + "/session/claim-pilot";
            var jsonBody = "{\"sessionId\":\"" + JsonEscape(sessionId) + "\"}";
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(jsonBody));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 10;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    Debug.Log("[KSCTowerNetwork] Auto-call claim-pilot network: " + req.error);
                    done(null, false);
                    yield break;
                }

                if (req.isHttpError)
                {
                    var code = req.responseCode;
                    var text = req.downloadHandler != null ? req.downloadHandler.text : "";
                    if (code == 404 || code == 410)
                    {
                        Debug.Log("[KSCTowerNetwork] Auto-call claim-pilot HTTP " + code
                            + " (room missing/closed) — falling through to /session/call.");
                        done(null, false);
                        yield break;
                    }
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call claim-pilot HTTP " + code
                        + ": " + Trim(text, 240));
                    var fatal = code >= 400 && code < 500;
                    done(null, fatal);
                    yield break;
                }

                var text2 = req.downloadHandler != null ? req.downloadHandler.text : "";
                var sid = ExtractFirst(text2, "\"sessionId\"\\s*:\\s*\"([^\"]+)\"");
                if (string.IsNullOrEmpty(sid))
                {
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call claim-pilot: response missing "
                        + "sessionId — body=" + Trim(text2, 240));
                    done(null, true);
                    yield break;
                }

                done(sid, false);
            }
        }

        // ------- POST /v1/session/call ------------------------------------------------

        // Callback signature: (sessionId-on-success, fatal-on-failure). A fatal failure
        // is one that won't get better on retry (4xx, malformed response). Network /
        // 5xx flips fatal=false so the outer loop retries.
        private IEnumerator PostSessionCallRoutine(System.Action<string, bool> done)
        {
            var url = TowerModSettings.ApiBaseUrl + "/session/call";

            // Default tuned channel by craft category:
            // - Plane: TWR (122.000)
            // - Rocket/rover/other: GND (121.700)
            var jsonBody = "{\"frequencyMhz\":\"" + DefaultAutoCallFrequencyMhz() + "\"}";
            var body = Encoding.UTF8.GetBytes(jsonBody);

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 15;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                var text = req.downloadHandler != null ? req.downloadHandler.text : "";

                if (req.isNetworkError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call POST network error: "
                        + req.error);
                    done(null, false);
                    yield break;
                }

                if (req.isHttpError)
                {
                    var code = req.responseCode;
                    // 401/403/404 are caller / config problems — retrying just spams the
                    // backend log. 5xx is treated as transient.
                    var fatal = code >= 400 && code < 500;
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call POST failed (HTTP "
                        + code + "): " + Trim(text, 240));
                    done(null, fatal);
                    yield break;
                }

                var sessionId = ExtractFirst(text, "\"sessionId\"\\s*:\\s*\"([^\"]+)\"");
                if (string.IsNullOrEmpty(sessionId))
                {
                    Debug.LogWarning("[KSCTowerNetwork] Auto-call POST: response missing "
                        + "sessionId — body=" + Trim(text, 240));
                    done(null, true);
                    yield break;
                }

                done(sessionId, false);
            }
        }

        // ------- helpers --------------------------------------------------------------

        /// <summary>
        /// Switch the in-game radio to the freshly-claimed room. Going through
        /// <see cref="TowerModSettings.SetActiveChannel"/> (instead of writing
        /// <c>SessionId</c> directly) makes sure the voice bridge respawns with the
        /// right <c>SESSION_ID</c> env so audio follows the new room.
        /// </summary>
        private static void AdoptSessionId(string sessionId)
        {
            if (string.IsNullOrEmpty(sessionId))
            {
                return;
            }

            // No-op if we somehow already happen to be on this id (e.g. SetActiveChannel
            // was called by something else between the probe and the POST).
            if (string.Equals(sessionId, TowerModSettings.SessionId, System.StringComparison.Ordinal))
            {
                return;
            }

            try
            {
                TowerModSettings.SetActiveChannel(sessionId);
            }
            catch (System.Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Auto-call: SetActiveChannel threw — "
                    + ex.Message);
            }
        }

        private static string ExtractFirst(string json, string pattern)
        {
            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            var m = Regex.Match(json, pattern);
            return m.Success ? m.Groups[1].Value : null;
        }

        private static string Trim(string s, int max)
        {
            if (string.IsNullOrEmpty(s))
            {
                return "";
            }

            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        /// <summary>
        /// Default startup frequency when creating/reclaiming a pilot room.
        /// Planes call tower; everything else starts on ground.
        /// </summary>
        private static string DefaultAutoCallFrequencyMhz()
        {
            return TowerCraftMode.Current == CraftMode.Plane ? "122.000" : "121.700";
        }

        // ------- planet-pack detection -----------------------------------------------

        /// <summary>
        /// (assemblyOrFolderToken, friendlyRoomName). Tokens are matched
        /// case-insensitively against loaded assembly names AND top-level
        /// GameData/* folder names — most planet packs ship configs without a
        /// dll. Anything not on this list (including unknown Kopernicus
        /// packs) falls through to the generic "Unknown Pack" fallback so we
        /// don't have to keep this table exhaustive.
        /// </summary>
        private static readonly KeyValuePair<string, string>[] KnownPlanetPacks = new[]
        {
            new KeyValuePair<string, string>("RealSolarSystem",     "RSS"),
            new KeyValuePair<string, string>("JNSQ",                "JNSQ"),
            new KeyValuePair<string, string>("GalileosPlanetPack",  "GPP"),
            new KeyValuePair<string, string>("GPP",                 "GPP"),
            // CKAN installs to GameData/OuterPlanetsMod — that path does not contain the substring "opm",
            // so we must list it explicitly. Token "OPM" alone is unsafe with fuzzy matching: it matches
            // inside "RasterPropMonitor" (…r**opM**onitor).
            new KeyValuePair<string, string>("OuterPlanetsMod",     "OPM"),
            new KeyValuePair<string, string>("OPM",                 "OPM"),
            new KeyValuePair<string, string>("BeyondHome",          "Beyond Home"),
            new KeyValuePair<string, string>("WhirligigWorld",      "Whirligig World"),
            new KeyValuePair<string, string>("Kcalbeloh",           "Kcalbeloh"),
            new KeyValuePair<string, string>("GEP",                 "Grannus"),
            new KeyValuePair<string, string>("AlternisKerbol",      "Alternis Kerbol"),
            new KeyValuePair<string, string>("MPE",                 "MPE"),
            new KeyValuePair<string, string>("Quack",               "Quack Pack")
        };

        /// <summary>
        /// Returns the friendly name of the planet pack currently loaded
        /// (e.g. "JNSQ", "RSS", "OPM"), "KSP Stock" if no Kopernicus / planet
        /// pack is installed at all, or "Unknown Pack" if Kopernicus is
        /// loaded with a pack we don't have on the recognised list. Keeping
        /// the fallback simple means we don't have to chase every new planet
        /// pack release — unrecognised packs still get a sensible room name.
        /// </summary>
        private static string DetectPlanetPackName()
        {
            var assemblies = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
            try
            {
                var asms = System.AppDomain.CurrentDomain.GetAssemblies();
                for (int i = 0; i < asms.Length; i++)
                {
                    var n = asms[i] != null ? asms[i].GetName().Name : null;
                    if (!string.IsNullOrEmpty(n)) assemblies.Add(n);
                }
            }
            catch { /* ignore — fall through to GameData scan */ }

            var folders = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
            try
            {
                var gd = Path.Combine(KSPUtil.ApplicationRootPath, "GameData");
                if (Directory.Exists(gd))
                {
                    foreach (var d in Directory.GetDirectories(gd))
                    {
                        var nm = Path.GetFileName(d);
                        if (!string.IsNullOrEmpty(nm)) folders.Add(nm);
                    }
                }
            }
            catch { /* ignore — best-effort detection */ }

            for (int i = 0; i < KnownPlanetPacks.Length; i++)
            {
                var entry = KnownPlanetPacks[i];
                if (ContainsTokenIgnoreCase(assemblies, entry.Key)
                    || ContainsTokenIgnoreCase(folders, entry.Key))
                {
                    return entry.Value;
                }
            }

            // Kopernicus loaded but we didn't recognise the pack on top of it
            // → some pack we don't have on the list. Use the generic fallback
            // rather than mislabeling the room "KSP Stock". Anything else
            // (no Kopernicus at all) is genuinely stock.
            var hasKopernicus = ContainsTokenIgnoreCase(assemblies, "Kopernicus")
                || ContainsTokenIgnoreCase(folders, "Kopernicus");
            return hasKopernicus ? "Unknown Pack" : "KSP Stock";
        }

        private static bool ContainsTokenIgnoreCase(HashSet<string> set, string token)
        {
            if (set == null || string.IsNullOrEmpty(token))
            {
                return false;
            }

            if (set.Contains(token))
            {
                return true;
            }

            // Very short tokens are substring hazards ("OPM" matches "RasterPropMonitor").
            if (token.Length <= 3)
            {
                return false;
            }

            // Fuzzy fallback: e.g. "Kopernicus" should still match the GameData
            // folder named "Kopernicus.Components" or an assembly called
            // "RealSolarSystem.Patches".
            foreach (var s in set)
            {
                if (!string.IsNullOrEmpty(s) && s.IndexOf(token, System.StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Minimal JSON string escaper — covers backslash, double-quote, and
        /// the C0 control range so a planet-pack name with weird characters
        /// (shouldn't happen, but the GameData folder list is user-supplied)
        /// can't break the request body. Not a general-purpose JSON encoder.
        /// </summary>
        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 4);
            for (int i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
