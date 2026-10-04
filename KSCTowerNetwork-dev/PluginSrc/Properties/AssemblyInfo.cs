using System.Reflection;

// KSP 1.12+ reads file version from plugin DLLs; missing/empty values cause LoadPluginInfo to throw
// and the load can stall on "Loading Part Upgrades". AssemblyFileVersion populates the PE version resource.
[assembly: AssemblyTitle("KSCTowerNetwork")]
[assembly: AssemblyDescription("KSC Tower local-dev plugin")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
