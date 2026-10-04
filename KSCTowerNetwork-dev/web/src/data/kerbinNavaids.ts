/**
 * Kerbin radio navaids from MOARdV AvionicsSystems `MAS_NavAid.cfg` (game lat/lon).
 * Tower map pins use the same numbers. Regenerate: `web/scripts/gen_kerbin_navaids.py`.
 *
 * Supplemental morse, antenna heights, service volumes, aerodrome data, and reception-range
 * tables live in `kerbinAeroCharts.ts`, keyed off the same `id` field below.
 */
export type KerbinNavAidKind = "VOR" | "ILS" | "NDB";

export type KerbinNavAid = {
  id: string;
  name: string;
  kind: KerbinNavAidKind;
  /** Value from cfg `frequency` (MHz for VOR/ILS; NDB uses cfg kHz-style values as in MAS). */
  frequency: number;
  lat: number;
  lon: number;
};

export const KERBIN_NAVAIDS: KerbinNavAid[] = [
  { id: 'KST', name: 'CENTER', kind: 'VOR', frequency: 113.3, lat: -0.06301651539, lon: -74.63320905499 },
  { id: 'IFT', name: 'AIRFIELD', kind: 'VOR', frequency: 114.2, lat: -1.52327719495, lon: -71.9111728162 },
  { id: 'ESI', name: 'EASTERN', kind: 'VOR', frequency: 116.4, lat: 5.62382602616, lon: -61.2651389301 },
  { id: 'ID04', name: 'NAME 04', kind: 'VOR', frequency: 112.1, lat: 62.66611111, lon: -62.80388889 },
  { id: 'Id05', name: 'NAME 05', kind: 'VOR', frequency: 113.5, lat: -18.32527778, lon: -37.04583333 },
  { id: 'Id06', name: 'NAME 06', kind: 'VOR', frequency: 115.1, lat: 29.02583333, lon: 99.75583333 },
  { id: 'Id07', name: 'NAME 07', kind: 'VOR', frequency: 114.7, lat: -0.483333333, lon: -136.56 },
  { id: 'Id08', name: 'NAME 08', kind: 'VOR', frequency: 116.7, lat: -43.00055556, lon: -120.3222222 },
  { id: 'Id09', name: 'NAME 09', kind: 'VOR', frequency: 113.8, lat: 30.08055556, lon: -151.4575 },
  { id: 'Id10', name: 'NAME 10', kind: 'VOR', frequency: 115.2, lat: -64.81916667, lon: -19.24805556 },
  { id: 'Id11', name: 'NAME 11', kind: 'VOR', frequency: 117.1, lat: -31.55277778, lon: 21.79694444 },
  { id: 'Id12', name: 'NAME 12', kind: 'VOR', frequency: 114.3, lat: 12.15083333, lon: 39.88027778 },
  { id: 'Id13', name: 'NAME 13', kind: 'VOR', frequency: 117.6, lat: -44.83583333, lon: 78.59611111 },
  { id: 'Id14', name: 'NAME 14', kind: 'VOR', frequency: 113.1, lat: 70.37833333, lon: 41.41861111 },
  { id: 'Id15', name: 'NAME 15', kind: 'VOR', frequency: 116.6, lat: 54.29444444, lon: 99.71194444 },
  { id: 'Id16', name: 'NAME 16', kind: 'VOR', frequency: 115.3, lat: -1.318333333, lon: 121.7725 },
  { id: 'Id17', name: 'NAME 17', kind: 'VOR', frequency: 117.2, lat: -46.76027778, lon: 139.365 },
  { id: 'Id18', name: 'NAME 18', kind: 'VOR', frequency: 115.4, lat: -10.15166667, lon: 176.5063889 },
  { id: 'Id19', name: 'NAME 19', kind: 'VOR', frequency: 114.8, lat: 49.39444444, lon: 156.4013889 },
  { id: 'Id20', name: 'NAME 20', kind: 'VOR', frequency: 113.9, lat: -70.19138889, lon: -155.8961111 },
  { id: 'SCE', name: 'BAKOR', kind: 'NDB', frequency: 197.0, lat: -0.048611111, lon: -77.565 },
  { id: 'IRW', name: 'BASE WEST', kind: 'NDB', frequency: 191.0, lat: -1.516111111, lon: -71.98138889 },
  { id: 'IRE', name: 'BASE EAST', kind: 'NDB', frequency: 194.0, lat: -1.516111111, lon: -71.83833333 },
  { id: 'Id03', name: 'NAME 03', kind: 'NDB', frequency: 192.0, lat: -20.69833333, lon: -28.78416667 },
  { id: 'Id04', name: 'NAME 04', kind: 'NDB', frequency: 201.0, lat: 0.768888888, lon: -10.415 },
  { id: 'Id05', name: 'NAME 05', kind: 'NDB', frequency: 208.0, lat: 32.40972222, lon: 12.56833333 },
  { id: 'Id06', name: 'NAME 06', kind: 'NDB', frequency: 211.0, lat: -59.37, lon: -52.185 },
  { id: 'Id07', name: 'NAME 07', kind: 'NDB', frequency: 209.0, lat: -64.38, lon: 31.59666667 },
  { id: 'Id08', name: 'NAME 08', kind: 'NDB', frequency: 195.0, lat: -60.016111111, lon: 106.3916667 },
  { id: 'Id09', name: 'NAME 09', kind: 'NDB', frequency: 198.0, lat: 4.043055556, lon: 85.73722222 },
  { id: 'Id10', name: 'NAME 10', kind: 'NDB', frequency: 202.0, lat: 0.263611111, lon: -108.6327778 },
  { id: 'Id11', name: 'NAME 11', kind: 'NDB', frequency: 203.0, lat: -51.96527778, lon: -159.4555556 },
  { id: 'Id12', name: 'NAME 12', kind: 'NDB', frequency: 210.0, lat: 68.42277778, lon: -108.4788889 },
  { id: 'IKW', name: 'KKSC ILS 09', kind: 'ILS', frequency: 108.5, lat: -0.04874294553, lon: -74.69916667 },
  { id: 'IWE', name: 'KKSC ILS 27', kind: 'ILS', frequency: 110.1, lat: -0.05023564553, lon: -74.5175 },
];
