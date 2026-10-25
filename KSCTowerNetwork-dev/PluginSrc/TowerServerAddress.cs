using System;

namespace KSCTowerNetwork
{
    public static class TowerServerAddress
    {
        public static bool TryNormalize(string input, bool api, out string address, out string error)
        {
            address = null;
            error = "Enter a server hostname, IP address or HTTP(S) URL.";
            var raw = (input ?? string.Empty).Trim();
            if (raw.Length == 0 || raw.Length > 2048 || raw.IndexOf('\\') >= 0)
            {
                return false;
            }

            foreach (var c in raw)
            {
                if (char.IsWhiteSpace(c) || char.IsControl(c))
                {
                    return false;
                }
            }

            if (raw.IndexOf("://", StringComparison.Ordinal) < 0)
            {
                raw = "https://" + raw;
            }

            Uri uri;
            if (!Uri.TryCreate(raw, UriKind.Absolute, out uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || string.IsNullOrEmpty(uri.Host) || uri.Port < 1 || !uri.IsWellFormedOriginalString()
                || !string.IsNullOrEmpty(uri.UserInfo)
                || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            {
                return false;
            }

            var builder = new UriBuilder(uri);
            if (api && (uri.AbsolutePath == "/" || uri.AbsolutePath.Length == 0))
            {
                builder.Path = "/v1";
            }

            address = builder.Uri.AbsoluteUri.TrimEnd('/');
            error = null;
            return true;
        }

        public static string WebBaseForApi(string apiAddress)
        {
            string normalized;
            string error;
            if (!TryNormalize(apiAddress, true, out normalized, out error))
            {
                return string.Empty;
            }

            var uri = new Uri(normalized);
            var path = uri.AbsolutePath.TrimEnd('/');
            var builder = new UriBuilder(uri);
            builder.Path = path.EndsWith("/v1", StringComparison.Ordinal)
                ? path.Substring(0, path.Length - 3)
                : "/";
            return builder.Uri.AbsoluteUri.TrimEnd('/');
        }
    }
}
