import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface City {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

export interface GeoTable {
  cityForIp(ip: string): City | null;
}

// src/features (or dist/features) -> repo root contracts/
export const DEFAULT_GEO_CITIES_PATH = fileURLToPath(new URL("../../../contracts/geo_cities.csv", import.meta.url));

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function parseGeoCsv(csv: string): GeoTable {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const cols = header!.split(",");
  const idx = (name: string) => cols.indexOf(name);
  const byPrefix = new Map<string, City>();
  for (const line of lines) {
    const f = line.split(",");
    byPrefix.set(f[idx("ip_prefix")]!, {
      name: f[idx("city")]!,
      country: f[idx("country")]!,
      lat: Number(f[idx("lat")]),
      lon: Number(f[idx("lon")]),
    });
  }
  return {
    cityForIp(ip) {
      if (!IPV4.test(ip)) return null;
      const [a, b] = ip.split(".");
      return byPrefix.get(`${a}.${b}`) ?? null;
    },
  };
}

export function loadGeoTable(path = DEFAULT_GEO_CITIES_PATH): GeoTable {
  return parseGeoCsv(readFileSync(path, "utf8"));
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371.0;
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
