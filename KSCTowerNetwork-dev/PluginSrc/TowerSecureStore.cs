using System;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Best-effort encryption-at-rest for tokens persisted to <c>auth.cfg</c>.
    ///
    /// On Windows we wrap the value with DPAPI (<c>ProtectedData.Protect</c>, current-user scope)
    /// so anyone who copies the file off disk cannot read the JWT or email without that user
    /// account's keychain. On Linux/macOS or when DPAPI is unavailable we fall back to plaintext
    /// — the previous behavior — and log a one-time warning.
    ///
    /// Stored values are tagged with a textual prefix so the loader can tell DPAPI ciphertext
    /// apart from a legacy plaintext value migrated from older auth.cfg files.
    /// </summary>
    public static class TowerSecureStore
    {
        private const string DpapiPrefix = "dpapi:v1:";
        private static MethodInfo _protect;
        private static MethodInfo _unprotect;
        private static object _scopeCurrentUser;
        private static bool _resolved;
        private static bool _warnedNoDpapi;

        private static void EnsureResolved()
        {
            if (_resolved)
            {
                return;
            }
            _resolved = true;

            try
            {
                // Reflect into System.Security so the build does not have to take a hard
                // reference to System.Security.dll on platforms that don't ship it.
                var asm = AppDomain.CurrentDomain.Load("System.Security");
                var protectedData = asm.GetType("System.Security.Cryptography.ProtectedData");
                var scopeType = asm.GetType("System.Security.Cryptography.DataProtectionScope");
                if (protectedData == null || scopeType == null)
                {
                    return;
                }

                _protect = protectedData.GetMethod(
                    "Protect",
                    new[] { typeof(byte[]), typeof(byte[]), scopeType });
                _unprotect = protectedData.GetMethod(
                    "Unprotect",
                    new[] { typeof(byte[]), typeof(byte[]), scopeType });
                _scopeCurrentUser = Enum.Parse(scopeType, "CurrentUser");
            }
            catch (Exception ex)
            {
                // Swallow — fallback path will run.
                Debug.LogWarning("[KSCTowerNetwork] DPAPI not available: " + ex.Message);
            }
        }

        private static bool DpapiAvailable
        {
            get
            {
                EnsureResolved();
                return _protect != null
                    && _unprotect != null
                    && _scopeCurrentUser != null
                    && Environment.OSVersion.Platform == PlatformID.Win32NT;
            }
        }

        /// <summary>
        /// Returns a ConfigNode-safe string suitable for writing to disk. On Windows this is
        /// DPAPI ciphertext base64-encoded; elsewhere it's the original plaintext (with a
        /// one-time warning).
        /// </summary>
        public static string Protect(string plaintext)
        {
            if (string.IsNullOrEmpty(plaintext))
            {
                return string.Empty;
            }

            if (!DpapiAvailable)
            {
                if (!_warnedNoDpapi)
                {
                    _warnedNoDpapi = true;
                    Debug.LogWarning(
                        "[KSCTowerNetwork] Persisting auth.cfg in plaintext: DPAPI is only available on Windows. " +
                        "Set persistTowerSessionToken=False to avoid storing the JWT on disk.");
                }
                return plaintext;
            }

            try
            {
                var bytes = Encoding.UTF8.GetBytes(plaintext);
                var encrypted = (byte[])_protect.Invoke(null, new object[] { bytes, null, _scopeCurrentUser });
                return DpapiPrefix + Convert.ToBase64String(encrypted);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] DPAPI Protect failed; falling back to plaintext: " + ex.Message);
                return plaintext;
            }
        }

        /// <summary>
        /// Inverse of <see cref="Protect"/>. Accepts both DPAPI ciphertext (with the prefix)
        /// and legacy plaintext (returned unchanged) so existing auth.cfg files keep working.
        /// </summary>
        public static string Unprotect(string stored)
        {
            if (string.IsNullOrEmpty(stored))
            {
                return string.Empty;
            }

            if (!stored.StartsWith(DpapiPrefix, StringComparison.Ordinal))
            {
                // Legacy plaintext entry. Loaded as-is; it will be re-encrypted next save.
                return stored;
            }

            if (!DpapiAvailable)
            {
                Debug.LogWarning(
                    "[KSCTowerNetwork] auth.cfg contains DPAPI-encrypted value but DPAPI is unavailable on this " +
                    "platform; the user will need to log in again.");
                return string.Empty;
            }

            try
            {
                var b64 = stored.Substring(DpapiPrefix.Length);
                var encrypted = Convert.FromBase64String(b64);
                var clear = (byte[])_unprotect.Invoke(null, new object[] { encrypted, null, _scopeCurrentUser });
                return Encoding.UTF8.GetString(clear);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] DPAPI Unprotect failed; treating value as missing: " + ex.Message);
                return string.Empty;
            }
        }
    }
}
