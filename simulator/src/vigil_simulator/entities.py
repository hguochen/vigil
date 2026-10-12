"""World entities: catalog, customers, cards, devices."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from .geo import City, load_cities

FIRST_NAMES = [
    "James", "Mary", "Wei", "Priya", "Carlos", "Fatima", "Liam", "Olivia", "Noah", "Ava",
    "Mateo", "Sofia", "Hiro", "Yuna", "Kwame", "Amara", "Lucas", "Emma", "Arjun", "Mei",
    "Daniel", "Grace", "Omar", "Leila", "Ethan", "Chloe", "Diego", "Isabel", "Sam", "Nora",
]
LAST_NAMES = [
    "Smith", "Johnson", "Chen", "Patel", "Garcia", "Khan", "Brown", "Nguyen", "Kim", "Lopez",
    "Williams", "Okafor", "Tanaka", "Silva", "Müller", "Rossi", "Martin", "Davis", "Singh", "Lee",
]
MAIL_DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "icloud.com", "proton.me"]
DISPOSABLE_DOMAINS = ["quickinbox.io", "tmpbox.net", "mailnow.xyz", "burnr.email"]
STREETS = ["Main St", "Oak Ave", "Pine Rd", "Maple Dr", "Cedar Ln", "Elm St", "Lake Blvd", "Hill Way"]
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36",
    "VigilShopApp/4.2 (iOS 18.0)",
    "VigilShopApp/4.2 (Android 15)",
]
HEADLESS_USER_AGENTS = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/129.0 Safari/537.36",
    "python-requests/2.32",
]

# category -> (min, max) unit price in cents, SKU count
CATEGORIES: dict[str, tuple[int, int, int]] = {
    "books": (800, 4_000, 40),
    "apparel": (1_500, 12_000, 40),
    "home": (2_000, 20_000, 30),
    "beauty": (800, 6_000, 30),
    "grocery": (500, 8_000, 30),
    "toys": (1_000, 8_000, 20),
    "sports": (1_500, 25_000, 20),
    "electronics": (3_000, 150_000, 30),
    "gift_cards": (2_500, 50_000, 6),
    "digital_goods": (99, 2_999, 20),
}
EVERYDAY_CATEGORIES = ["books", "apparel", "home", "beauty", "grocery", "toys", "sports"]


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    category: str
    unit_price_minor: int


@dataclass(frozen=True)
class Card:
    token: str
    bin: str
    last4: str
    country: str


@dataclass(frozen=True)
class Device:
    id: str
    user_agent: str


@dataclass
class Customer:
    id: str
    email: str
    name: str
    account_created_at: datetime
    home: City
    street: str
    cards: list[Card]
    devices: list[Device]
    preferred_categories: list[str]
    purchases_per_day: float
    spend_scale: float  # multiplies basket size; >1 means bigger spender
    ip_host: int = field(default=0)  # stable home IP host part

    def home_ip(self) -> str:
        return ip_in(self.home, self.ip_host)


def ip_in(city: City, host: int) -> str:
    return f"{city.ip_prefix}.{(host >> 8) & 0xFF}.{host & 0xFF}"


def build_catalog(rng: np.random.Generator) -> list[Product]:
    catalog = []
    for category, (lo, hi, count) in CATEGORIES.items():
        # Log-uniform prices so each category has many cheap and a few expensive SKUs.
        prices = np.exp(rng.uniform(np.log(lo), np.log(hi), size=count)).astype(int)
        for i, price in enumerate(sorted(prices)):
            sku = f"{category[:3].upper()}-{i:04d}"
            catalog.append(Product(sku, f"{category.replace('_', ' ').title()} item {i}", category,
                                   int(price)))
    return catalog


class IdFactory:
    def __init__(self, rng: np.random.Generator):
        self.rng = rng
        self.counters: dict[str, int] = {}

    def next(self, prefix: str) -> str:
        n = self.counters.get(prefix, 0) + 1
        self.counters[prefix] = n
        return f"{prefix}_{n:06d}"

    def card(self, country: str) -> Card:
        bin_ = str(int(self.rng.choice([4, 5]))) + "".join(str(d) for d in self.rng.integers(0, 10, 5))
        last4 = "".join(str(d) for d in self.rng.integers(0, 10, 4))
        return Card(self.next("tok"), bin_, last4, country)

    def device(self, headless: bool = False) -> Device:
        agents = HEADLESS_USER_AGENTS if headless else USER_AGENTS
        return Device(self.next("dev"), str(self.rng.choice(agents)))

    def ip_host(self) -> int:
        return int(self.rng.integers(1, 65_535))


def make_name(rng: np.random.Generator) -> str:
    return f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"


def email_for(name: str, rng: np.random.Generator) -> str:
    first, last = name.lower().replace("ü", "u").split(" ", 1)
    style = rng.integers(0, 3)
    local = [f"{first}.{last}", f"{first[0]}{last}", f"{first}{last}"][style]
    if rng.random() < 0.5:
        local += str(rng.integers(1, 99))
    return f"{local}@{rng.choice(MAIL_DOMAINS)}"


def disposable_email(rng: np.random.Generator) -> str:
    letters = "abcdefghijklmnopqrstuvwxyz0123456789"
    local = "".join(rng.choice(list(letters), size=int(rng.integers(8, 13))))
    return f"{local}@{rng.choice(DISPOSABLE_DOMAINS)}"


def build_customers(
    rng: np.random.Generator, ids: IdFactory, n: int, start: datetime
) -> list[Customer]:
    cities = load_cities()
    domestic = [c for c in cities if c.is_domestic]
    foreign = [c for c in cities if not c.is_domestic]
    customers = []
    for _ in range(n):
        home = rng.choice(domestic) if rng.random() < 0.88 else rng.choice(foreign)
        name = make_name(rng)
        n_cards = 1 if rng.random() < 0.75 else 2
        n_devices = int(rng.choice([1, 2, 3], p=[0.55, 0.35, 0.10]))
        # Account ages from a few days to ~6 years before the simulation starts.
        age_days = float(rng.exponential(500)) + 3
        customers.append(
            Customer(
                id=ids.next("cust"),
                email=email_for(name, rng),
                name=name,
                account_created_at=start - timedelta(days=age_days),
                home=home,
                street=f"{rng.integers(10, 9999)} {rng.choice(STREETS)}",
                cards=[ids.card(home.country) for _ in range(n_cards)],
                devices=[ids.device() for _ in range(n_devices)],
                preferred_categories=list(
                    rng.choice(EVERYDAY_CATEGORIES + ["electronics"], size=3, replace=False)
                ),
                purchases_per_day=float(rng.lognormal(np.log(0.12), 0.6)),
                spend_scale=float(rng.lognormal(0, 0.4)),
                ip_host=ids.ip_host(),
            )
        )
    return customers
