using System;
using KSCTowerNetwork;

class TowerServerAddressTests
{
    static int checks;
    static void Check(bool ok, string message)
    {
        checks++;
        if (!ok) throw new Exception(message);
    }

    static void Address(string input, string expected)
    {
        string address;
        string error;
        Check(TowerServerAddress.TryNormalize(input, true, out address, out error), "Rejected: " + input);
        Check(address == new Uri(expected).AbsoluteUri.TrimEnd('/') && error == null, "Unexpected address: " + address);
    }

    static void Main()
    {
        Address("tower.example.com", "https://tower.example.com/v1");
        Address("  https://TOWER.example.com/  ", "https://tower.example.com/v1");
        Address("203.0.113.5", "https://203.0.113.5/v1");
        Address("tower.example.com:8443", "https://tower.example.com:8443/v1");
        Address("http://192.168.1.12:48787", "http://192.168.1.12:48787/v1");
        Address("http://localhost:48787/v1/", "http://localhost:48787/v1");
        Address("https://tower.example.com:443/v1", "https://tower.example.com/v1");
        Address("https://tower.example.com/tower/v1/", "https://tower.example.com/tower/v1");
        Address("http://[::1]:48787", "http://[::1]:48787/v1");
        Address("https://tower.example.com/custom-api", "https://tower.example.com/custom-api");

        foreach (var input in new[] { "", " ", "http://", "ftp://tower.example.com", "https://user:password@tower.example.com",
            "https://tower.example.com?token=abc", "https://tower.example.com/#login", "https://tower.example.com:99999", "http://tower.example.com:0",
            "two hosts.example.com", "https://tower.example.com\n/v1", "https:\\tower.example.com", new string('x', 2049) })
        {
            string address;
            string error;
            Check(!TowerServerAddress.TryNormalize(input, true, out address, out error) && address == null
                && !string.IsNullOrEmpty(error), "Accepted invalid address: " + input);
        }

        Check(TowerServerAddress.WebBaseForApi("https://tower.example.com/v1") == "https://tower.example.com", "Same-origin web base");
        Check(TowerServerAddress.WebBaseForApi("https://tower.example.com/tower/v1") == "https://tower.example.com/tower", "Proxy prefix");
        Check(TowerServerAddress.WebBaseForApi("bad config ://") == string.Empty, "Malformed defaults must not prevent opening login");
        string web;
        string webError;
        Check(TowerServerAddress.TryNormalize("https://desk.example.com/", false, out web, out webError)
            && web == "https://desk.example.com", "Separate web origin must not gain /v1");
        Console.WriteLine("OK: " + checks + " server address checks");
    }
}
