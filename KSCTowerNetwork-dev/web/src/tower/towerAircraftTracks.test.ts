import { describe, it, expect } from "vitest";
import { activeRowToTelemetry, buildTowerAircraftTracks, trimmedPilotCallsign } from "./towerAircraftTracks";
import type { Telemetry } from "../components/KerbinTowerMap";

describe("buildTowerAircraftTracks", () => {
  it("includes self and excludes duplicate session id from active list", () => {
    const self: Telemetry = {
      bodyName: "Kerbin",
      lat: -0.05,
      lon: -74.6,
      craftName: "Alpha",
      heading: 90
    };
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: self,
      selfCallsign: "ALPHA-1",
      active: [
        {
          sessionId: "room-a",
          bodyName: "Kerbin",
          lat: -0.051,
          lon: -74.61,
          craftName: "Dup"
        },
        {
          sessionId: "room-b",
          bodyName: "Kerbin",
          lat: -0.052,
          lon: -74.62,
          callsign: "BRAVO",
          heading: 91,
          surfaceSpeed: 55,
          verticalSpeed: -2,
          aslAlt: 1200,
          radarAlt: 800
        }
      ]
    });
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.isSelf).toBe(true);
    expect(tracks[0]!.label).toBe("ALPHA-1");
    expect(tracks[1]!.id).toBe("room-b");
  });

  it("prefers session selfCallsign over telemetry.callsign for self track label (telemetry may be radio facility)", () => {
    const self: Telemetry = {
      bodyName: "Kerbin",
      lat: -0.05,
      lon: -74.6,
      callsign: "KSC-TWR",
      craftName: "Alpha"
    };
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: self,
      selfCallsign: "ALPHA-1",
      active: []
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.label).toBe("ALPHA-1");
  });

  it("falls back to telemetry.callsign for self label when session selfCallsign is empty", () => {
    const self: Telemetry = {
      bodyName: "Kerbin",
      lat: -0.05,
      lon: -74.6,
      callsign: "ECHO-9",
      craftName: "Alpha"
    };
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: self,
      selfCallsign: "",
      active: []
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.label).toBe("ECHO-9");
  });

  it("includes other aircraft from active list when only smoothed lat/lon are present", () => {
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: null,
      active: [
        {
          sessionId: "room-b",
          bodyName: "Kerbin",
          smoothedPositionValid: true,
          smoothedLat: -0.052,
          smoothedLon: -74.62,
          callsign: "SMOOTH"
        }
      ]
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.telemetry.lat).toBe(-0.052);
    expect(tracks[0]!.telemetry.lon).toBe(-74.62);
  });

  it("plots smoothed lat/lon on the map when the plugin marks smoothed samples valid", () => {
    const self: Telemetry = {
      bodyName: "Kerbin",
      lat: -0.05,
      lon: -74.6,
      smoothedPositionValid: true,
      smoothedLat: -0.051,
      smoothedLon: -74.601,
      smoothedAslAlt: 500,
      craftName: "Alpha"
    };
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: self,
      active: []
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.telemetry.lat).toBe(-0.051);
    expect(tracks[0]!.telemetry.lon).toBe(-74.601);
    expect(tracks[0]!.telemetry.aslAlt).toBe(500);
  });

  it("includes self when bodyName is omitted (plugin often omits it for the session vessel)", () => {
    const self: Telemetry = {
      lat: -0.05,
      lon: -74.6,
      craftName: "NoBodyField"
    };
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: self,
      active: []
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.telemetry.bodyName).toBe("Kerbin");
  });

  it("filters active rows not on the home body", () => {
    const tracks = buildTowerAircraftTracks({
      homeBodyName: "Kerbin",
      sessionId: "room-a",
      telemetry: null,
      active: [
        {
          sessionId: "x",
          bodyName: "Mun",
          lat: 1,
          lon: 2,
          craftName: "Lander"
        }
      ]
    });
    expect(tracks).toHaveLength(0);
  });
});

describe("trimmedPilotCallsign", () => {
  it("returns undefined for blank and nullish", () => {
    expect(trimmedPilotCallsign(undefined)).toBeUndefined();
    expect(trimmedPilotCallsign(null)).toBeUndefined();
    expect(trimmedPilotCallsign("")).toBeUndefined();
    expect(trimmedPilotCallsign("  ")).toBeUndefined();
  });

  it("accepts finite numbers without throwing", () => {
    expect(trimmedPilotCallsign(42)).toBe("42");
  });
});

describe("activeRowToTelemetry", () => {
  it("maps craftMapIcon strings to the union", () => {
    const t = activeRowToTelemetry({ sessionId: "x", craftMapIcon: "plane", lat: 0, lon: 0 });
    expect(t.craftMapIcon).toBe("plane");
  });
});
