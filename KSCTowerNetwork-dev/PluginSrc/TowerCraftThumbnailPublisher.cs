using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerCraftThumbnailPublisher : MonoBehaviour
    {
        private string _sentKey;
        private float _nextUpload;

        private void Start()
        {
            TowerModSettings.EnsureLoaded();
            StartCoroutine(PublishLoop());
        }

        private IEnumerator PublishLoop()
        {
            while (true)
            {
                yield return new WaitForSecondsRealtime(5f);
                var vessel = FlightGlobals.ActiveVessel;
                if (!FlightGlobals.ready || vessel == null || vessel.state == Vessel.State.DEAD
                    || TowerModSettings.StreamAsTower || !TowerModSettings.BeaconActive
                    || string.IsNullOrEmpty(TowerModSettings.SessionId)
                    || string.IsNullOrEmpty(TowerModSettings.TowerAuthToken)) continue;

                string craft = vessel.vesselName;
                string session = TowerModSettings.SessionId;
                string key = session + ":" + vessel.persistentId + ":" + craft;
                if (key == _sentKey && Time.unscaledTime < _nextUpload) continue;
                // A missing thumbnail is normal for renamed, staged, or unsaved craft.
                byte[] bytes = ReadThumbnail(craft);
                if (bytes == null) { _sentKey = key; _nextUpload = Time.unscaledTime + 30f; continue; }
                using (var request = new UnityWebRequest(TowerModSettings.ApiBaseUrl + "/craft-thumbnail/" + Uri.EscapeDataString(session), "POST"))
                {
                    request.uploadHandler = new UploadHandlerRaw(bytes);
                    request.downloadHandler = new DownloadHandlerBuffer();
                    request.SetRequestHeader("Content-Type", "image/png");
                    request.SetRequestHeader("x-craft-name", Uri.EscapeDataString(craft));
                    TowerApiAuth.ApplyBearer(request);
                    request.timeout = 8;
                    yield return request.SendWebRequest();
                    _sentKey = key;
                    _nextUpload = Time.unscaledTime + (request.isNetworkError || request.isHttpError ? 30f : 60f);
                }
            }
        }

        private static byte[] ReadThumbnail(string craft)
        {
            try
            {
                string path = TowerCraftThumbnailPaths.Find(KSPUtil.ApplicationRootPath, HighLogic.SaveFolder, craft);
                if (path == null) return null;
                // Bound file IO on Unity's thread to a small existing PNG; never scan saves or capture a camera.
                using (var stream = File.OpenRead(path))
                {
                    if (stream.Length <= 0 || stream.Length > 256 * 1024) return null;
                    byte[] bytes = new byte[(int)stream.Length];
                    int offset = 0;
                    while (offset < bytes.Length)
                    {
                        int read = stream.Read(bytes, offset, bytes.Length - offset);
                        if (read == 0) return null;
                        offset += read;
                    }
                    return bytes;
                }
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
            catch (ArgumentException) { return null; }
        }
    }
}
