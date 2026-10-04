using System;

namespace KSCTowerNetwork
{
    internal static class TowerRadioState
    {
        private static bool _busy;
        private static bool _blocked;
        private static double _freqMhz;
        private static bool _hasFreq;
        private static string _message;
        private static long _updatedAtMs;
        private static long _expiresAtMs;
        private static long _blockedAtMs;

        public static bool Busy
        {
            get
            {
                Refresh();
                return _busy;
            }
        }

        public static bool Blocked
        {
            get
            {
                Refresh();
                return _blocked;
            }
        }

        public static bool TryGetFreqMhz(out double freqMhz)
        {
            Refresh();
            freqMhz = _freqMhz;
            return _hasFreq;
        }

        public static string Message
        {
            get
            {
                Refresh();
                return _message;
            }
        }

        public static void Apply(bool busy, bool blocked, double freqMhz, bool hasFreq, string message, long updatedAtMs, long expiresAtMs, long blockedAtMs)
        {
            _busy = busy;
            _blocked = blocked;
            _freqMhz = freqMhz;
            _hasFreq = hasFreq;
            _message = message ?? string.Empty;
            _updatedAtMs = updatedAtMs;
            _expiresAtMs = expiresAtMs;
            _blockedAtMs = blockedAtMs;
        }

        public static void Clear()
        {
            _busy = false;
            _blocked = false;
            _freqMhz = 0.0;
            _hasFreq = false;
            _message = string.Empty;
            _updatedAtMs = 0L;
            _expiresAtMs = 0L;
            _blockedAtMs = 0L;
        }

        private static void Refresh()
        {
            var now = UnixNowMs();
            if (_blocked && _blockedAtMs > 0L && now - _blockedAtMs > 6000L)
            {
                _blocked = false;
            }

            if (_busy && _expiresAtMs > 0L && now > _expiresAtMs)
            {
                _busy = false;
            }

            if (!_busy && !_blocked)
            {
                _message = string.Empty;
            }
        }

        private static long UnixNowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }
}
