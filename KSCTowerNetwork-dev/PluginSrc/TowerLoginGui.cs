using System;
using System.Collections;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>IMGUI login window before the Tower panel when no JWT is stored (unless <see cref="TowerModSettings.SkipTowerLogin"/>).</summary>
    /// <remarks>
    /// Intentionally has no <c>[KSPAddon]</c> attribute. The component is created on demand by <see cref="EnsureExists"/>
    /// and marked <c>DontDestroyOnLoad</c>; using <c>[KSPAddon]</c> would also create a per-scene instance that never
    /// registers with <see cref="_instance"/>, leading to duplicate components after a scene change.
    /// </remarks>
    public class TowerLoginGui : MonoBehaviour
    {
        private static TowerLoginGui _instance;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(this);
                return;
            }

            _instance = this;
            _windowId = GetInstanceID() ^ 0x4C4F474E;
        }

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }

        private bool _visible;
        private string _email = "";
        private string _password = "";
        private string _loginCallsign = "";
        private bool _rememberEmail = true;
        private bool _stayLoggedIn = true;
        private string _statusLine = "";
        private bool _busy;
        private Vector2 _loginScrollPos;
        private GUIStyle _hintWrapStyle;
        private Action _onSuccess;
        private Action _onCancel;

        private const float LoginWinW = 440f;
        private const float LoginWinH = 500f;
        private Rect _windowRect;
        private int _windowId;

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerLoginGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerLoginGui>();
        }

        /// <summary>Show modal login on the main thread. <paramref name="onSuccess"/> runs after the session token is stored.</summary>
        public static void Prompt(Action onSuccess, Action onCancel)
        {
            EnsureExists();
            TowerModSettings.EnsureLoaded();
            _instance._onSuccess = onSuccess;
            _instance._onCancel = onCancel;
            _instance._email = TowerModSettings.SavedTowerEmail ?? "";
            _instance._password = "";
            _instance._loginCallsign = string.IsNullOrEmpty(TowerModSettings.PilotCallsign)
                ? ""
                : TowerModSettings.PilotCallsign;
            _instance._rememberEmail = TowerModSettings.RememberTowerEmail;
            _instance._stayLoggedIn = TowerModSettings.PersistSessionToken;
            _instance._statusLine = "";
            _instance._busy = false;
            _instance.            _loginScrollPos = Vector2.zero;
            _instance._windowRect = new Rect(
                (Screen.width - LoginWinW) * 0.5f,
                (Screen.height - LoginWinH) * 0.5f,
                LoginWinW,
                LoginWinH);
            _instance._visible = true;

#if DEV_AUTOFILL
            // Dev build: prefill the pilot dev preset (matches VITE_DEV_LOGIN_PRESETS in
            // KSCTowerNetwork-dev/web/.env.development) and force the login callsign to "fooney"
            // so iterating on tower features doesn't require typing creds every relaunch.
            // NEVER ship this in a release DLL — credentials are hard-coded in plaintext.
            if (string.IsNullOrEmpty(_instance._email))
            {
                _instance._email = "pilot@ksc.local";
            }

            if (string.IsNullOrEmpty(_instance._password))
            {
                _instance._password = "pilot12345";
            }

            _instance._loginCallsign = "fooney";
            _instance._statusLine = "[DEV BUILD] credentials auto-filled.";
#endif
        }

        private void OnGUI()
        {
            if (!_visible)
            {
                return;
            }

            TowerSkin.EnsureBuilt();

            var maxX = Mathf.Max(0f, Screen.width - LoginWinW);
            var maxY = Mathf.Max(0f, Screen.height - LoginWinH);
            _windowRect.x = Mathf.Clamp(_windowRect.x, 0f, maxX);
            _windowRect.y = Mathf.Clamp(_windowRect.y, 0f, maxY);

            _windowRect = TowerClickBlock.GUILayoutWindow(
                _windowId,
                _windowRect,
                DrawLoginWindow,
                GUIContent.none,
                TowerSkin.Panel);
        }

        private void DrawLoginWindow(int id)
        {
            GUILayout.BeginVertical();
            GUILayout.Label("Tower login", HighLogic.Skin.label);
            GUILayout.Space(4);
            if (_hintWrapStyle == null)
            {
                _hintWrapStyle = new GUIStyle(HighLogic.Skin.label) { wordWrap = true };
            }

            GUILayout.Label(
                "Use the same email and password as the Tower web desk. Account callsign is optional; each ship can have its own callsign when the beacon is on (saved per craft).",
                _hintWrapStyle,
                GUILayout.MaxWidth(LoginWinW - 20f));
            GUILayout.Space(6);

            const float headerReserve = 118f;
            _loginScrollPos = GUILayout.BeginScrollView(
                _loginScrollPos,
                GUIStyle.none,
                GUI.skin.verticalScrollbar,
                GUILayout.Width(LoginWinW - 8f),
                GUILayout.Height(Mathf.Max(140f, LoginWinH - headerReserve)));

            GUI.enabled = !_busy;
            GUILayout.Label("Email");
            _email = GUILayout.TextField(_email ?? "", 200, GUILayout.MinHeight(22));
            GUILayout.Label("Password");
            _password = GUILayout.PasswordField(_password ?? "", '*', 200, GUILayout.MinHeight(22));
            GUILayout.Space(4);
            GUILayout.Label("Callsign (optional)");
            _loginCallsign = GUILayout.TextField(_loginCallsign ?? "", 120, GUILayout.MinHeight(22));

            _rememberEmail = GUILayout.Toggle(_rememberEmail, "Remember email (saved in settings.cfg)");
            _stayLoggedIn = GUILayout.Toggle(_stayLoggedIn, "Stay logged in (save session token in settings.cfg)");

            if (!string.IsNullOrEmpty(_statusLine))
            {
                GUILayout.Label(_statusLine, HighLogic.Skin.label);
            }

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Log in", GUILayout.Height(28)))
            {
                StartCoroutine(LoginRoutine());
            }

            if (GUILayout.Button("Cancel", GUILayout.Height(28)))
            {
                CloseCancel();
            }

            GUILayout.EndHorizontal();
            GUI.enabled = true;

            if (_busy)
            {
                GUILayout.Label("Signing in…");
            }

            GUILayout.EndScrollView();
            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, LoginWinW - 8f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, LoginWinW, LoginWinH));
        }

        private void CloseCancel()
        {
            _visible = false;
            _password = "";
            _statusLine = "";
            if (_onCancel != null)
            {
                var c = _onCancel;
                _onCancel = null;
                _onSuccess = null;
                c();
            }
        }

        private IEnumerator LoginRoutine()
        {
            var email = (_email ?? string.Empty).Trim();
            var pwd = _password ?? "";
            if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(pwd))
            {
                _statusLine = "Enter email and password.";
                yield break;
            }

            _busy = true;
            _statusLine = "";
            var url = TowerModSettings.ApiBaseUrl + "/auth/login";
            var pilotName = (_loginCallsign ?? string.Empty).Trim();
            var json =
                "{\"email\":\"" +
                JsonEscape(email) +
                "\",\"password\":\"" +
                JsonEscape(pwd) +
                "\",\"callsign\":\"" +
                JsonEscape(pilotName) +
                "\",\"displayName\":\"" +
                JsonEscape(pilotName) +
                "\"}";
            var body = Encoding.UTF8.GetBytes(json);

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 15;
                yield return req.SendWebRequest();

                _busy = false;

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (req.isNetworkError || req.isHttpError)
                {
                    _statusLine = req.responseCode == 401
                        ? "Invalid email or password."
                        : "Login failed (" + req.responseCode + ").";
                    Debug.LogWarning("[KSCTowerNetwork] login: " + req.error + " " + text);
                    yield break;
                }

                var token = ExtractToken(text);
                if (string.IsNullOrEmpty(token))
                {
                    _statusLine = "Server response missing token.";
                    Debug.LogWarning("[KSCTowerNetwork] login body: " + text);
                    yield break;
                }

                var userEmail = ExtractAccountEmail(text);
                if (string.IsNullOrEmpty(userEmail))
                {
                    userEmail = email;
                }

                // The /auth/login JWT is "tower_web" type — server-side that maps to
                // tokenType:"clerk", which fails the isPluginCaller gate on routes
                // like POST /v1/session/call. The plugin needs a "plugin_session"
                // JWT instead, minted via the two-step exchange. We swap to that
                // token before persisting so every subsequent plugin call (auto-call
                // for room creation, manual-tune room creation, etc.) goes through
                // as a true plugin caller. If the exchange fails for any reason we
                // fall back to the web token so the user is at least logged in.
                string finalToken = token;
                yield return TryExchangeForPluginSessionRoutine(token, exchanged =>
                {
                    if (!string.IsNullOrEmpty(exchanged))
                    {
                        finalToken = exchanged;
                    }
                });

                TowerModSettings.ApplyTowerLoginSuccess(
                    finalToken,
                    userEmail,
                    email,
                    _rememberEmail,
                    _stayLoggedIn,
                    pilotName);

                // Persist the role so role-gated UI (Stream-as-Tower toggle, Park at KSC tower
                // button) can render without an extra round-trip to /auth/me. Role is best-effort
                // — empty string just means "treat as a regular pilot" everywhere.
                TowerModSettings.SetTowerUserRole(ExtractRole(text));

                _password = "";
                _visible = false;
                _statusLine = "";

                if (_onSuccess != null)
                {
                    var ok = _onSuccess;
                    _onSuccess = null;
                    _onCancel = null;
                    ok();
                }
            }
        }

        /// <summary>
        /// Two-step exchange that swaps the freshly-issued tower_web JWT for a
        /// plugin_session JWT. We POST /v1/auth/plugin/exchange-code with the web
        /// bearer to mint a short-lived code, then POST /v1/auth/plugin/exchange
        /// with that code to get back the plugin token. Server-side the difference
        /// is only the token_type claim, but it controls req.auth.tokenType — and
        /// thus whether routes like /session/call treat the caller as a plugin
        /// (allowed to create rooms even at pilot rank) or as a web client
        /// (gated to controller+).
        /// <para/>
        /// All error paths invoke <paramref name="done"/> with null so the caller
        /// keeps using the web token — this codepath must never block login.
        /// </summary>
        private IEnumerator TryExchangeForPluginSessionRoutine(string webToken, Action<string> done)
        {
            if (string.IsNullOrEmpty(webToken))
            {
                done(null);
                yield break;
            }

            string code = null;
            yield return RequestExchangeCodeRoutine(webToken, c => code = c);
            if (string.IsNullOrEmpty(code))
            {
                done(null);
                yield break;
            }

            string pluginToken = null;
            yield return RedeemExchangeCodeRoutine(code, t => pluginToken = t);
            done(pluginToken);
        }

        private IEnumerator RequestExchangeCodeRoutine(string webToken, Action<string> done)
        {
            var url = TowerModSettings.ApiBaseUrl + "/auth/plugin/exchange-code";
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes("{}"));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.SetRequestHeader("Authorization", "Bearer " + webToken);
                req.timeout = 10;
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] plugin exchange-code: HTTP "
                        + req.responseCode + " " + req.error);
                    done(null);
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                var m = Regex.Match(text, "\"code\"\\s*:\\s*\"([^\"]+)\"");
                done(m.Success ? m.Groups[1].Value : null);
            }
        }

        private IEnumerator RedeemExchangeCodeRoutine(string code, Action<string> done)
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
                    Debug.LogWarning("[KSCTowerNetwork] plugin exchange: HTTP "
                        + req.responseCode + " " + req.error);
                    done(null);
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                done(ExtractToken(text));
            }
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return "";
            }

            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "");
        }

        private static string ExtractToken(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return "";
            }

            var m = Regex.Match(json, "\"token\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : "";
        }

        private static string ExtractAccountEmail(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return "";
            }

            var matches = Regex.Matches(json, "\"email\"\\s*:\\s*\"([^\\\"]*)\"");
            if (matches.Count > 0)
            {
                return matches[matches.Count - 1].Groups[1].Value;
            }

            return "";
        }

        /// <summary>
        /// Pulls the server-issued role string out of the login JSON. Backend currently embeds it
        /// as either a top-level <c>"role":"..."</c> or nested under <c>"user":{"role":"..."}</c>;
        /// both shapes use the same key so a tolerant regex covers both.
        /// </summary>
        private static string ExtractRole(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return "";
            }

            var m = Regex.Match(json, "\"role\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : "";
        }
    }
}
