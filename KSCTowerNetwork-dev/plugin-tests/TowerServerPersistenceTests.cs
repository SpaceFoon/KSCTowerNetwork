using System;
using System.IO;
using System.Reflection;
using KSCTowerNetwork;

class TowerServerPersistenceTests
{
    static int checks;

    static void Main(string[] args)
    {
        // Resolve the installed game's assemblies in place; never copy or redistribute them.
        AppDomain.CurrentDomain.AssemblyResolve += (sender, e) =>
        {
            var name = new AssemblyName(e.Name).Name + ".dll";
            foreach (var dir in new[] { Path.GetDirectoryName(args[0]), args[1] })
            {
                var file = Path.Combine(dir, name);
                if (File.Exists(file)) return Assembly.LoadFrom(file);
            }
            return null;
        };
        Run(args[2]);
        Console.WriteLine("OK: " + checks + " real KSP ConfigNode server persistence checks");
    }

    static void Check(bool ok, string message)
    {
        checks++;
        if (!ok) throw new Exception(message);
    }

    static bool Read(MethodInfo reader, ConfigNode node, bool api, out string address)
    {
        var args = new object[] { node, api, null };
        var ok = (bool)reader.Invoke(null, args);
        address = (string)args[2];
        return ok;
    }

    static void Run(string path)
    {
        var flags = BindingFlags.Static | BindingFlags.NonPublic;
        var writer = typeof(TowerModSettings).GetMethod("WriteServerUrl", flags);
        var reader = typeof(TowerModSettings).GetMethod("TryReadServerUrl", flags);
        try
        {
            foreach (var address in new[] { "https://tower.example.com/v1", "http://192.168.1.12:48787/v1",
                "http://[::1]:48787/v1", "https://tower.example.com/tower/v1",
                "https://tower.example.com/proxy//v1", "https://tower.example.com/space%20name/v1" })
            {
                var config = new ConfigNode();
                var server = config.AddNode("KSCTOWERNETWORK_AUTH").AddNode("SERVER");
                writer.Invoke(null, new object[] { server.AddNode("API"), address });
                writer.Invoke(null, new object[] { server.AddNode("WEB"), "https://desk.example.com" });
                Check(config.Save(path), "Save failed");
                var saved = ConfigNode.Load(path).GetNode("KSCTOWERNETWORK_AUTH").GetNode("SERVER");
                string actual;
                Check(Read(reader, saved.GetNode("API"), true, out actual) && new Uri(actual).Equals(new Uri(address)), "API round trip: " + address);
                Check(Read(reader, saved.GetNode("WEB"), false, out actual) && actual == "https://desk.example.com", "Separate website round trip");
                Check(!File.ReadAllText(path).Contains("://"), "URLs must not be truncated by ConfigNode comments");
            }

            foreach (var key in new[] { "scheme", "host", "port" })
            {
                var node = new ConfigNode();
                writer.Invoke(null, new object[] { node, "https://tower.example.com/v1" });
                node.RemoveValue(key);
                string actual;
                Check(!Read(reader, node, true, out actual), "Accepted missing " + key);
            }

            foreach (var port in new[] { "0", "65536", "not-a-port" })
            {
                var node = new ConfigNode();
                writer.Invoke(null, new object[] { node, "https://tower.example.com/v1" });
                node.SetValue("port", port);
                string actual;
                Check(!Read(reader, node, true, out actual), "Accepted invalid port " + port);
            }

            var invalid = new ConfigNode();
            writer.Invoke(null, new object[] { invalid, "https://tower.example.com/v1" });
            invalid.SetValue("scheme", "ftp");
            string ignored;
            Check(!Read(reader, invalid, true, out ignored), "Accepted non-HTTP scheme");
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}
