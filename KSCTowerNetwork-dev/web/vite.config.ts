import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readDevPorts } from "../scripts/dev-ports.mjs";

/**
 * Inject defence-in-depth security headers on every dev/preview response.
 * Production deployments are expected to terminate TLS at a reverse proxy
 * (nginx, Cloudflare, etc.) which will emit equivalent headers; this plugin
 * makes sure the same posture applies during local development too. The CSP
 * here mirrors the <meta http-equiv> in index.html so dev exercises the same
 * policy that ships to prod.
 */
function securityHeadersPlugin(): Plugin {
  // Production-equivalent CSP for `vite preview`. The `vite` dev server gets a
  // relaxed variant below because @vitejs/plugin-react injects an inline
  // <script> for the React Refresh preamble that strict CSP would block.
  const baseCsp =
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' ws: wss: https:; " +
    "media-src 'self' blob:; " +
    "worker-src 'self' blob:; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none'";
  const prodCsp = `script-src 'self'; ${baseCsp}`;
  // Dev needs 'unsafe-inline' for the React Refresh preamble. ws: covers HMR.
  const devCsp = `script-src 'self' 'unsafe-inline'; ${baseCsp}`;
  const apply = (res: { setHeader(name: string, value: string): void }, csp: string) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  };
  return {
    name: "ksc-security-headers",
    // Rewrite the <meta> CSP in index.html when serving via `vite` dev so the
    // browser-enforced policy matches the dev HTTP header. Production builds
    // (`vite build`) skip this branch and ship the strict meta tag untouched.
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!ctx.server) return html;
        return html.replace(/script-src 'self';/, "script-src 'self' 'unsafe-inline';");
      }
    },
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        apply(res, devCsp);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        apply(res, prodCsp);
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), securityHeadersPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  },
  server: {
    host: "127.0.0.1",
    port: readDevPorts().webPort,
    strictPort: true,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:48787",
        changeOrigin: true
      }
    }
  }
});
