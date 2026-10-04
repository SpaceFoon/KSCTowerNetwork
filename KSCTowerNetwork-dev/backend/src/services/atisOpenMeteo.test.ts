import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapOpenMeteoCurrentToWeather, observationIsoFromOpenMeteoTime } from "./atisOpenMeteo";

describe("observationIsoFromOpenMeteoTime", () => {
  it("treats bare Open-Meteo timestamps as UTC", () => {
    const iso = observationIsoFromOpenMeteoTime("2026-04-23T10:15");
    assert.match(iso, /^2026-04-23T10:15:00\.000Z$/);
  });
});

describe("mapOpenMeteoCurrentToWeather", () => {
  it("maps a typical Open-Meteo current block (wind already in knots)", () => {
    const w = mapOpenMeteoCurrentToWeather({
      time: "2026-04-23T10:15",
      interval: 900,
      temperature_2m: 16.1,
      dew_point_2m: 11.4,
      wind_speed_10m: 2.8,
      wind_direction_10m: 321,
      surface_pressure: 1018.4,
      cloud_cover: 63,
      weather_code: 2,
      visibility: 20800
    });
    assert.equal(w.windDirDeg, 321);
    assert.equal(w.windKt, 3);
    assert.equal(w.tempC, 16.1);
    assert.equal(w.dewpointC, 11.4);
    assert.ok(w.altimeterInHg > 29 && w.altimeterInHg < 31);
    assert.equal(w.visibilitySm, 12.9);
    assert.match(w.skyConditions, /broken|cloud/i);
  });
});
