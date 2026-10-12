"""City table shared with the scoring service (contracts/geo_cities.csv).

Each city owns a synthetic /16 in 100.64.0.0/10 (shared address space), which
lets the scoring service resolve IP -> city as a stand-in for a real IP
geolocation database.
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from functools import cache
from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parents[3] / "contracts"
GEO_CITIES_CSV = CONTRACTS_DIR / "geo_cities.csv"
HOME_COUNTRY = "US"


@dataclass(frozen=True)
class City:
    name: str
    region: str
    country: str
    postal_code: str
    lat: float
    lon: float
    ip_prefix: str  # e.g. "100.64"

    @property
    def is_domestic(self) -> bool:
        return self.country == HOME_COUNTRY


@cache
def load_cities(path: Path = GEO_CITIES_CSV) -> tuple[City, ...]:
    with path.open(newline="") as f:
        return tuple(
            City(
                name=row["city"],
                region=row["region"],
                country=row["country"],
                postal_code=row["postal_code"],
                lat=float(row["lat"]),
                lon=float(row["lon"]),
                ip_prefix=row["ip_prefix"],
            )
            for row in csv.DictReader(f)
        )


def city_for_ip(ip: str) -> City | None:
    prefix = ".".join(ip.split(".")[:2])
    return next((c for c in load_cities() if c.ip_prefix == prefix), None)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
