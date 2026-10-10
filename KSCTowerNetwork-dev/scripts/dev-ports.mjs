import { readFileSync } from "node:fs";

export const defaultDevPorts = Object.freeze({ webPort: 45173, pcmPort: 47372, ctlPort: 47373 });
export const localDevPortsPath = new URL("../dev-ports.local.json", import.meta.url);

export function readDevPorts(configPath = localDevPortsPath) {
  let overrides = {};
  try {
    overrides = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read local dev ports: ${error.message}`);
  }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Local dev ports must be a JSON object.");
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaultDevPorts, key)) throw new Error(`Unknown local dev port: ${key}`);
  }
  const ports = { ...defaultDevPorts, ...overrides };
  for (const [key, value] of Object.entries(ports)) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new Error(`${key} must be an integer between 1024 and 65535.`);
    }
  }
  if (new Set([48787, 48788, ...Object.values(ports)]).size !== 5) {
    throw new Error("Local dev ports must be distinct from each other and backend ports 48787/48788.");
  }
  return Object.freeze(ports);
}
