using System;
using System.IO;
using KSCTowerNetwork;

class TowerCraftThumbnailPathsTests
{
    static void Check(bool ok) { if (!ok) throw new Exception("Thumbnail path test failed"); }
    static void Main()
    {
        string root = Path.Combine(Path.GetTempPath(), "tower-thumbnail-test-" + Guid.NewGuid());
        string thumbs = Path.Combine(root, "thumbs");
        Directory.CreateDirectory(thumbs);
        try
        {
            string path = Path.Combine(thumbs, "Career_SPH_Test craft.png");
            File.WriteAllText(path, "fixture");
            Check(TowerCraftThumbnailPaths.Find(root, "Career", "Test craft") == path);
            Check(TowerCraftThumbnailPaths.Find(root, "Other save", "Test craft") == null);
            Check(TowerCraftThumbnailPaths.Find(root, "Career", "Renamed") == null);
            Check(TowerCraftThumbnailPaths.Find(root, "../Career", "Test craft") == null);
            Check(TowerCraftThumbnailPaths.Find(root, "Career", "../Test craft") == null);
            string newer = Path.Combine(thumbs, "saves_Career_Ships_VAB_Rocket.png");
            File.WriteAllText(newer, "fixture");
            Check(TowerCraftThumbnailPaths.Find(root, "Career", "Rocket") == newer);
            Console.WriteLine("OK: thumbnail lookup, save isolation, missing names and traversal");
        }
        finally { Directory.Delete(root, true); }
    }
}
