using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>Attaches <c>Authorization: Bearer</c> for Tower HTTP API when a session token is present.</summary>
    public static class TowerApiAuth
    {
        public static void ApplyBearer(UnityWebRequest request)
        {
            if (request == null)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            if (TowerModSettings.SkipTowerLogin)
            {
                return;
            }

            var t = TowerModSettings.TowerAuthToken;
            if (string.IsNullOrEmpty(t))
            {
                return;
            }

            request.SetRequestHeader("Authorization", "Bearer " + t);
        }
    }
}
