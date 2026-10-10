import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemSchematic } from "../components/SystemSchematic";
import { PlanetGlobe } from "../components/PlanetGlobe";
import { globeTextureFor } from "../data/globeTextures";
import { loadSystemCatalog, type SystemCatalog } from "../data/systemCatalog";
import "../index.css";

function Preview() {
  const [catalog, setCatalog] = useState<SystemCatalog | null>(null);
  const [focus, setFocus] = useState("Kerbin");
  useEffect(() => { void loadSystemCatalog("kerbin-opm").then(setCatalog); }, []);
  const selected = catalog?.bodies.find(body => body.name === focus);
  return <main style={{ maxWidth: 1100, margin: "20px auto", padding: "16px" }}>
    <h1 style={{ fontSize: "20px", marginBottom: "16px" }}>Planet globe preview</h1>
    <p style={{ color: "#95a6be", fontSize: "0.8rem" }}>Explore every planet and moon. Drag to rotate, scroll to zoom, or expand for a closer look.</p>
    {catalog && <section className="globe-preview-gallery" aria-label="Planet and moon explorer">
      <label>Planet or moon <select value={focus} onChange={event => setFocus(event.target.value)}>
        {catalog.bodies.filter(body => !body.isStar).map(body => <option key={body.name} value={body.name}>{body.displayName} · {body.parent}</option>)}
      </select></label>
      {selected && <PlanetGlobe key={selected.name} body={selected} worldId={catalog.worldId} textureUrl={globeTextureFor(selected, catalog.worldId)} />}
    </section>}
    {catalog && <SystemSchematic catalog={catalog} vesselCounts={new Map()} focusedBodyName={focus} onFocusBody={setFocus} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Preview /></QueryClientProvider>);
