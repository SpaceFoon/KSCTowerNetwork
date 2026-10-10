import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SystemCatalogBody } from "../data/systemCatalog";
import { planetAppearanceFor } from "./SystemArtwork";
import { globeLayersFor } from "../data/globeTextures";
import { apiFetchResponse } from "../api/client";

const vertex = `attribute vec2 position;
varying vec2 uv;
void main() { uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`;
const fragment = `precision highp float;
varying vec2 uv;
uniform sampler2D terrain, cloudMap, ringMap;
uniform float cloudTextured, cloudOpacity, ringed, ringInner, ringOuter;
uniform vec3 cloudTint, airTint;
uniform float textured, zoom, aspect, yaw, pitch, kind, atmosphere, time, clouds, belts;
uniform vec3 base, surface;
float hash(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
float noise(vec3 p) {
  vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p) { float v=0., a=.5; for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec3(3.1);a*=.5;} return v; }
// Schematic toroidal volumes; display dimensions deliberately fit the globe view.
vec4 beltVolume(vec2 p, float limit) {
  vec3 sum=vec3(0.); float alpha=0.;
  for(int i=0;i<32;i++) {
    float z=3.-float(i)*.1875;
    if(z<limit) break;
    vec3 v=vec3(p,z);
    v=vec3(v.x,v.y*cos(pitch)+v.z*sin(pitch),-v.y*sin(pitch)+v.z*cos(pitch));
    v=vec3(v.x*cos(yaw)+v.z*sin(yaw),v.y,-v.x*sin(yaw)+v.z*cos(yaw));
    // Kerbalism's Kerbin magnetic pole: latitude 80.37, longitude -72.62 degrees.
    vec3 axis=vec3(-.160,.986,.050);
    float h=dot(v,axis), radial=sqrt(max(0.,dot(v,v)-h*h));
    float inner=exp(-pow((radial-1.45)/.23,2.)-pow(h/.36,2.));
    float outer=exp(-pow((radial-2.12)/.35,2.)-pow(h/.67,2.));
    float density=(inner+outer*.6)*.012;
    sum+=(1.-alpha)*density*mix(vec3(.32,.66,.78),vec3(.83,.63,.32),inner/(inner+outer+.001));
    alpha+=(1.-alpha)*density;
  }
  return vec4(sum,alpha);
}
vec4 ringLayer(vec2 p, float front) {
  if(ringed<.5 || abs(sin(pitch))<.02) return vec4(0.);
  float z=-p.y*cos(pitch)/sin(pitch);
  if(z<front) return vec4(0.);
  float radius=length(vec3(p,z));
  if(radius<ringInner || radius>ringOuter) return vec4(0.);
  vec4 band=texture2D(ringMap,vec2((radius-ringInner)/(ringOuter-ringInner),.5));
  float shade=.68+.32*smoothstep(-ringOuter,ringOuter,-p.x);
  vec3 point=vec3(p,z), light=normalize(vec3(-.55,.4,1.));
  float distance=-dot(point,light);
  float shadow=distance>0. ? smoothstep(.9,1.05,length(point+light*distance)) : 1.;
  return vec4(pow(band.rgb,vec3(.8))*shade*mix(.3,1.,shadow),band.a);
}
void main() {
  float fit=mix(ringed>.5 ? .39 : .84,.34,belts);
  vec2 p=(uv-.5)*vec2(aspect,1.)*2./(fit*zoom*min(aspect,1.));
  float r=dot(p,p);
  if(r>1.) {
    float air=atmosphere*exp(-(sqrt(r)-1.)*48.)*.22;
    vec4 ring=ringLayer(p,-10.);
    vec4 belt=belts>.5 ? beltVolume(p,-3.) : vec4(0.);
    belt.rgb=ring.rgb*ring.a*(1.-belt.a)+belt.rgb;
    belt.a=ring.a+belt.a*(1.-ring.a);
    float a=air+belt.a*(1.-air);
    if(a<.005) discard;
    gl_FragColor=vec4((airTint*air+belt.rgb*(1.-air))/a,a); return;
  }
  vec3 n=vec3(p,sqrt(1.-r));
  vec3 q=vec3(n.x,n.y*cos(pitch)+n.z*sin(pitch),-n.y*sin(pitch)+n.z*cos(pitch));
  q=vec3(q.x*cos(yaw)+q.z*sin(yaw),q.y,-q.x*sin(yaw)+q.z*cos(yaw));
  vec2 tex=vec2(fract(.5+atan(q.x,q.z)/6.2831853),.5-asin(clamp(q.y,-1.,1.))/3.14159265);
  vec3 color;
  if(textured>.5) color=texture2D(terrain,tex).rgb;
  else {
    float detail=fbm(q*28.);
    if(kind>1.5) {
      float bands=sin(q.y*74.+fbm(q*9.)*8.)*.5+.5;
      color=mix(base,surface,bands*.65+detail*.25);
    } else if(kind>.5) {
      float land=smoothstep(.46,.53,fbm(q*3.5));
      color=mix(base,surface*(.7+detail*.5),land);
      color=mix(color,vec3(.92,.96,.97),smoothstep(.9,.98,abs(q.y)));
    } else {
      color=mix(base*.6,surface,detail);
      vec3 cell=q*38.; vec3 mid=floor(cell)+.5;
      float crater=length(fract(cell)-.5);
      if(hash(mid)>.73) color*=.7+smoothstep(.2,.35,crater)*.3;
    }
  }
  if(clouds>.5) {
    float drift=time*.07;
    vec3 c=vec3(q.x*cos(drift)+q.z*sin(drift),q.y,-q.x*sin(drift)+q.z*cos(drift));
    vec2 cloudUV=vec2(fract(.5+atan(c.x,c.z)/6.2831853),.5-asin(clamp(c.y,-1.,1.))/3.14159265);
    float coverage=cloudTextured>.5 ? texture2D(cloudMap,cloudUV).a*cloudOpacity
      : smoothstep(.52,.69,fbm(c*8.+vec3(fbm(c*3.)*2.)));
    float wisps=smoothstep(.48,.7,fbm(c*24.));
    color*=1.-coverage*.09;
    color=mix(color,cloudTint,coverage*(cloudTextured>.5 ? .95 : (.45+wisps*.3)));
  }
  float light=.3+.7*max(0.,dot(n,normalize(vec3(-.55,.4,1.))));
  color=pow(color,vec3(.82))*light;
  color+=airTint*pow(1.-n.z,4.)*atmosphere*.28;
  vec4 ring=ringLayer(p,n.z);
  color=mix(color,ring.rgb,ring.a);
  if(belts>.5) { vec4 belt=beltVolume(p,n.z); color=color*(1.-belt.a)+belt.rgb; }
  gl_FragColor=vec4(color,1.);
}`;

type View = { yaw: number; pitch: number; zoom: number };
const INITIAL: View = { yaw: -1.28, pitch: 0.1, zoom: 1 };
const radians = Math.PI / 180;

export function PlanetGlobe({ body, textureUrl, worldId }: { body: SystemCatalogBody; textureUrl?: string; worldId?: string }) {
  const layers = globeLayersFor(body, worldId ?? "");
  const initial = { ...INITIAL, pitch: layers.ring ? .42 : INITIAL.pitch };
  const canvas = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const view = useRef<View>(initial);
  const redraw = useRef<() => void>(() => {});
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState("Illustrated surface");
  const [cloudStatus, setCloudStatus] = useState("Illustrated cloud layer");
  const [ringStatus, setRingStatus] = useState("Loading OPM rings…");
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [clouds, setClouds] = useState(body.hasAtmosphere);
  const [belts, setBelts] = useState(false);
  const elapsed = useRef(0);
  const effects = useRef({ playing, clouds, belts });
  effects.current = { playing, clouds, belts };
  const beltAvailable = body.name.toLowerCase() === "kerbin" && ["kerbin-stock", "kerbin-opm"].includes(worldId ?? "");
  useEffect(() => { redraw.current(); }, [playing, clouds, belts]);

  const changeZoom = (factor: number) => {
    view.current.zoom = Math.max(1, Math.min(8, view.current.zoom * factor));
    setZoom(view.current.zoom);
    redraw.current();
  };
  const reset = () => {
    view.current = { ...initial };
    setZoom(1);
    redraw.current();
  };

  useEffect(() => {
    if (!expanded) return;
    dialog.current?.showModal();
    return () => { expandButton.current?.focus(); };
  }, [expanded]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const gl = element.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) { setFailed(true); return; }
    let disposed = false;
    let frame = 0;
    const shaders: WebGLShader[] = [];
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      shaders.push(s);
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Globe shader unavailable");
      return s;
    };
    const program = gl.createProgram()!;
    const buffer = gl.createBuffer()!;
    const texture = gl.createTexture()!;
    const cloudTexture = gl.createTexture()!;
    const ringTexture = gl.createTexture()!;
    try {
      gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Globe renderer unavailable");
    } catch {
      shaders.forEach(s => gl.deleteShader(s)); gl.deleteProgram(program);
      gl.deleteTexture(texture); gl.deleteTexture(cloudTexture); gl.deleteTexture(ringTexture); gl.deleteBuffer(buffer); setFailed(true); return;
    }
    setFailed(false);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(["terrain", "textured", "zoom", "aspect", "yaw", "pitch", "kind", "atmosphere", "base", "surface", "time", "clouds", "belts", "cloudMap", "ringMap", "cloudTextured", "cloudTint", "cloudOpacity", "ringed", "ringInner", "ringOuter", "airTint"]
      .map(name => [name, gl.getUniformLocation(program, name)]));
    const look = planetAppearanceFor(body);
    const rgb = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
    const base = rgb(look.base), surface = rgb(look.surface);
    gl.uniform3f(uniforms.base!, base[0]!, base[1]!, base[2]!);
    gl.uniform3f(uniforms.surface!, surface[0]!, surface[1]!, surface[2]!);
    gl.uniform1f(uniforms.kind!, look.kind === "gas" ? 2 : look.kind === "ocean" ? 1 : 0);
    gl.uniform1f(uniforms.atmosphere!, body.hasAtmosphere ? 1 : 0);
    const cloudTint = rgb(layers.cloud?.tint ?? "#eef5ff");
    const airTint = rgb(({ eve: "#ad72e6", duna: "#cf8e69", jool: "#80b954", tekto: "#86ba73", sarnus: "#ce9c84" } as Record<string, string>)[body.name.toLowerCase()] ?? "#529efa");
    gl.uniform3f(uniforms.cloudTint!, cloudTint[0]!, cloudTint[1]!, cloudTint[2]!);
    gl.uniform3f(uniforms.airTint!, airTint[0]!, airTint[1]!, airTint[2]!);
    gl.uniform1f(uniforms.cloudOpacity!, layers.cloud?.opacity ?? 1);
    gl.uniform1f(uniforms.ringInner!, layers.ring?.inner ?? 1.25);
    gl.uniform1f(uniforms.ringOuter!, layers.ring?.outer ?? 2.4);
    gl.uniform1f(uniforms.cloudTextured!, 0); gl.uniform1f(uniforms.ringed!, 0);
    for (const [unit, tex] of [texture, cloudTexture, ringTexture].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.uniform1i(uniforms.terrain!, 0);
    gl.uniform1i(uniforms.cloudMap!, 1); gl.uniform1i(uniforms.ringMap!, 2);
    gl.uniform1f(uniforms.textured!, 0);
    let previousTime = 0, visible = true;
    const render = (timestamp: number) => {
      frame = 0;
      if (disposed) return;
      const delta = previousTime ? Math.min((timestamp-previousTime)/1000,.1) : 0;
      previousTime = timestamp;
      if (effects.current.playing && visible && !document.hidden && !pointers.current.size) {
        view.current.yaw += delta*.025;
        elapsed.current += delta / 8;
      }
      const rect = element.getBoundingClientRect();
      const dpi = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpi)), h = Math.max(1, Math.round(rect.height * dpi));
      if (element.width !== w || element.height !== h) { element.width = w; element.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform1f(uniforms.aspect!, w / h);
      gl.uniform1f(uniforms.zoom!, view.current.zoom);
      gl.uniform1f(uniforms.yaw!, view.current.yaw);
      gl.uniform1f(uniforms.pitch!, view.current.pitch);
      gl.uniform1f(uniforms.time!, elapsed.current);
      gl.uniform1f(uniforms.clouds!, effects.current.clouds ? 1 : 0);
      gl.uniform1f(uniforms.belts!, effects.current.belts ? 1 : 0);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (effects.current.playing && visible && !document.hidden) frame=requestAnimationFrame(render);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redraw.current = schedule;
    const resize = new ResizeObserver(schedule); resize.observe(element);
    const intersection = new IntersectionObserver(entries => { visible=entries[0]?.isIntersecting ?? false; previousTime=0; schedule(); });
    intersection.observe(element);
    const visibility = () => { previousTime=0; schedule(); };
    document.addEventListener("visibilitychange", visibility);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduceMotion = () => { if (motion.matches) setPlaying(false); };
    motion.addEventListener("change", reduceMotion);
    const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(Math.exp(-event.deltaY * .002)); };
    element.addEventListener("wheel", wheel, { passive: false });
    const abort = new AbortController();
    const images: HTMLImageElement[] = [];
    const objectUrls: string[] = [];
    const loadLayer = (url: string, tex: WebGLTexture, unit: number, flag: string, onLoaded: (w: number, h: number) => void, onFailed: () => void) => {
      const image = new Image(); images.push(image);
      image.onload = () => {
        if (disposed) return;
        try {
          const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
          let source: TexImageSource = image;
          let w = image.width, h = image.height;
          if (w > max || h > max) {
            const resized = document.createElement("canvas");
            const ratio = max / Math.max(w, h);
            resized.width = Math.round(w * ratio); resized.height = Math.round(h * ratio);
            resized.getContext("2d")!.drawImage(image, 0, 0, resized.width, resized.height); source = resized;
            w = resized.width; h = resized.height;
          }
          gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          gl.uniform1f(uniforms[flag]!, 1);
          onLoaded(w, h); schedule();
        } catch { onFailed(); }
      };
      image.onerror = () => { if (!disposed) onFailed(); };
      void (async () => {
        try {
          if (url.startsWith("/v1/")) {
            const result = await apiFetchResponse(url, { method: "GET", signal: abort.signal });
            if (!result.ok) throw new Error("Texture unavailable");
            const blob = await result.response.blob();
            if (disposed) return;
            const objectUrl = URL.createObjectURL(blob); objectUrls.push(objectUrl); image.src = objectUrl;
          } else image.src = url;
        } catch { if (!disposed) onFailed(); }
      })();
    };
    if (textureUrl) {
      setStatus("Loading terrain…");
      const source = textureUrl === layers.surface?.url ? layers.surface.source : "KSP terrain";
      loadLayer(textureUrl, texture, 0, "textured", (w, h) => setStatus(`${source} · ${w} × ${h}`),
        () => setStatus("Illustrated surface · terrain unavailable"));
    } else setStatus("Illustrated surface");
    if (layers.cloud) {
      setCloudStatus("Loading AVP clouds…");
      loadLayer(layers.cloud.url, cloudTexture, 1, "cloudTextured", () => setCloudStatus("AVP cloud map · separate drifting layer"),
        () => setCloudStatus("Illustrated cloud layer · AVP map unavailable"));
    } else setCloudStatus("Illustrated cloud layer");
    if (layers.ring) {
      setRingStatus("Loading OPM rings…");
      loadLayer(layers.ring.url, ringTexture, 2, "ringed", () => setRingStatus("OPM ring map · equatorial plane"), () => setRingStatus("OPM ring map unavailable"));
    }
    schedule();
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect();
      intersection.disconnect(); document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", reduceMotion);
      element.removeEventListener("wheel", wheel);
      images.forEach(image => { image.onload = null; image.onerror = null; image.src = ""; });
      abort.abort(); objectUrls.forEach(url => URL.revokeObjectURL(url));
      redraw.current = () => {}; pointers.current.clear();
      gl.deleteTexture(texture); gl.deleteTexture(cloudTexture); gl.deleteTexture(ringTexture); gl.deleteBuffer(buffer); gl.deleteProgram(program); shaders.forEach(s => gl.deleteShader(s));
    };
  }, [body, textureUrl, worldId, expanded]);

  const content = <div className="planet-globe">
    {failed ? <p className="planet-globe-error">3D graphics are unavailable in this browser.</p> : <canvas
      ref={canvas} className="planet-globe-canvas" tabIndex={0} role="img"
      aria-label={`${body.displayName} globe. Drag or use arrow keys to rotate; scroll or use plus and minus to zoom.`}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); }}
      onPointerMove={e => {
        const previous = pointers.current.get(e.pointerId);
        if (!previous) return;
        const next = { x: e.clientX, y: e.clientY };
        if (pointers.current.size === 2) {
          const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
          if (other) {
            const before = Math.hypot(previous.x - other.x, previous.y - other.y);
            const after = Math.hypot(next.x - other.x, next.y - other.y);
            if (before > 0) changeZoom(after / before);
          }
        } else {
          view.current.yaw -= (next.x - previous.x) * .008 / view.current.zoom;
          view.current.pitch = Math.max(-1.5, Math.min(1.5, view.current.pitch + (next.y - previous.y) * .008 / view.current.zoom));
          redraw.current();
        }
        pointers.current.set(e.pointerId, next);
      }}
      onPointerUp={e => { pointers.current.delete(e.pointerId); }}
      onPointerCancel={e => { pointers.current.delete(e.pointerId); }}
      onLostPointerCapture={e => { pointers.current.delete(e.pointerId); }}
      onKeyDown={e => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0"].includes(e.key)) {
          e.preventDefault(); e.stopPropagation();
          if (e.key === "+" || e.key === "=") changeZoom(1.3);
          else if (e.key === "-") changeZoom(1 / 1.3);
          else if (e.key === "0") reset();
          else {
            view.current.yaw += (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0) * 10 * radians;
            view.current.pitch = Math.max(-1.5, Math.min(1.5, view.current.pitch + (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0) * 10 * radians));
            redraw.current();
          }
        }
      }}
    />}
    <div className="planet-globe-controls" aria-label="Globe controls">
      <button type="button" onClick={() => changeZoom(1.4)} aria-label="Zoom into globe" disabled={failed || zoom >= 8}>+</button>
      <button type="button" onClick={() => changeZoom(1 / 1.4)} aria-label="Zoom out of globe" disabled={failed || zoom <= 1}>−</button>
      <button type="button" onClick={reset} disabled={failed}>Reset</button>
      <span>{zoom.toFixed(1)}×</span>
      {!expanded && <button type="button" ref={expandButton} onClick={() => setExpanded(true)} disabled={failed}>Expand</button>}
    </div>
    <div className="planet-globe-controls" aria-label="Globe layers and animation">
      <button type="button" aria-pressed={playing} onClick={() => setPlaying(!playing)} disabled={failed}>{playing ? "Pause" : "Play"}</button>
      {body.hasAtmosphere && <button type="button" aria-pressed={clouds} onClick={() => setClouds(!clouds)} disabled={failed}>Clouds</button>}
      {beltAvailable && <button type="button" aria-pressed={belts} onClick={() => setBelts(!belts)} disabled={failed}>Radiation belts</button>}
    </div>
    <p className="planet-globe-hint">Drag to rotate · scroll / pinch to zoom</p>
    <p className="planet-globe-source">{status}</p>
    {clouds && body.hasAtmosphere && <p className="planet-globe-source">{cloudStatus} · accelerated rotation</p>}
    {layers.ring && <p className="planet-globe-source">{ringStatus}</p>}
    {belts && <p className="planet-globe-source">Faint inner / outer volumes · schematic scale<br /><a href="https://kerbalism.github.io/Kerbalism/tech-guide/radiation/" target="_blank" rel="noreferrer">Kerbalism reference</a> · illustrative, not live radiation</p>}
  </div>;

  return expanded ? <>
    <button className="planet-globe-return" type="button" onClick={() => setExpanded(false)}>Return to globe</button>
    {createPortal(<dialog ref={dialog} className="planet-globe-dialog" onCancel={() => setExpanded(false)}
      onKeyDown={e => { if (e.key === "Escape") e.stopPropagation(); }}>
      <header><h3>{body.displayName}</h3><button type="button" onClick={() => setExpanded(false)} aria-label="Close expanded globe">×</button></header>
      {content}
    </dialog>, document.body)}
  </> : content;
}
