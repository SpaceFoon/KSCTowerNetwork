import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TowerRadarScope } from "../components/TowerRadarScope";
import type { TowerAircraftTrack } from "../components/KerbinTowerMap";
import { KSC_LAT, KSC_LON } from "../tower/airfieldGeometry";
import "../index.css";

function Preview() {
  const [scenario, setScenario] = useState("traffic");
  const [photo, setPhoto] = useState<string>();
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo); }, [photo]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const tracks: TowerAircraftTrack[] = [
    { id: "preview-flightwall", label: "KERBAL-7", isSelf: true, telemetry: { craftName: "Kerbtimize Stack 20", craftType: "Rocket", craftMapIcon: "rocket", pilotName: "Jebediah Kerman", bodyName: "Kerbin", situation: "FLYING", lat: KSC_LAT + .7, lon: KSC_LON - 1.2, heading: 290, aslAlt: 11330, surfaceSpeed: 189, verticalSpeed: 24, sampleUnixMs: scenario === "stale" ? now - 60000 : now } },
    { id: "preview-island", label: "ISLAND-3", telemetry: { craftName: "Island hopper", craftType: "Plane", craftMapIcon: "plane", pilotName: "Valentina Kerman", bodyName: "Kerbin", situation: "FLYING", lat: KSC_LAT - 2.5, lon: KSC_LON + 3.2, heading: 330, aslAlt: 2420, surfaceSpeed: 112, verticalSpeed: -5, onApproach: true, targetRunway: "KSC 27", sampleUnixMs: now } },
    { id: "preview-rescue", label: "RESCUE-2", telemetry: { craftName: "Rescue rover", craftType: "Rover", craftMapIcon: "rover", bodyName: "Kerbin", situation: "LANDED", lat: KSC_LAT + 4, lon: KSC_LON + 1, heading: 0, aslAlt: 64, surfaceSpeed: 0, sampleUnixMs: now } }
  ];
  return <main style={{ maxWidth: 1500, margin: "24px auto", padding: 16 }}>
    <header style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 16 }}><div><h1 style={{ fontSize: 20, margin: 0 }}>KSC flightwall preview</h1><p style={{ color: "var(--muted)", fontSize: 12 }}>Sample telemetry · {photo ? "Local thumbnail preview; no upload" : "thumbnail requests use the real local API"}</p></div><label>Scenario <select value={scenario} onChange={(e) => setScenario(e.target.value)}><option value="traffic">Traffic</option><option value="stale">Stale telemetry</option><option value="empty">No traffic</option></select></label><label style={{ fontSize: 12 }}>Preview saved thumbnail <input type="file" accept="image/png" onChange={(e) => { const file = e.target.files?.[0]; if (file?.type === "image/png" && file.size <= 256 * 1024) setPhoto(URL.createObjectURL(file)); }} /></label></header>
    <div style={{ height: "min(800px, 85vh)", minHeight: 650 }}><TowerRadarScope tracks={scenario === "empty" ? [] : tracks} worldInventory={null} homeBodyName="Kerbin" previewThumbnail={photo ? { sessionId: "preview-flightwall", url: photo } : undefined} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
