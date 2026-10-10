using System;
using System.IO;

namespace KSCTowerNetwork
{
    public static class TowerCraftThumbnailPaths
    {
        private static bool SafeName(string name)
        {
            return !string.IsNullOrWhiteSpace(name) && name != "." && name != ".."
                && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0
                && name.IndexOf('/') < 0 && name.IndexOf('\\') < 0;
        }

        // Exact names only: never use an autosave or another save's similarly named vessel.
        public static string Find(string root, string save, string craft)
        {
            if (!SafeName(save) || !SafeName(craft)) return null;
            string thumbs = Path.GetFullPath(Path.Combine(root, "thumbs"));
            string[] facilities = { "SPH", "VAB" };
            foreach (string facility in facilities)
            {
                string[] names = {
                    save + "_" + facility + "_" + craft + ".png",
                    "saves_" + save + "_Ships_" + facility + "_" + craft + ".png",
                    save + "_Ships_" + facility + "_" + craft + ".png"
                };
                foreach (string name in names)
                {
                    string candidate = Path.GetFullPath(Path.Combine(thumbs, name));
                    if (candidate.StartsWith(thumbs + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        && File.Exists(candidate)) return candidate;
                }
            }
            return null;
        }
    }
}
