from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Account:
    """One public account, holding only what its owner published on it."""

    platform: str
    handle: str
    url: str
    name: str = ""
    bio: str = ""
    location: str = ""
    company: str = ""
    email: str = ""
    avatar: str = ""
    created: str = ""  # ISO 8601, UTC
    links: list[str] = field(default_factory=list)
    stats: dict[str, object] = field(default_factory=dict)
    languages: dict[str, int] = field(default_factory=dict)
    topics: list[str] = field(default_factory=list)
    highlights: list[dict[str, str]] = field(default_factory=list)
    activity: list[str] = field(default_factory=list)  # ISO timestamps
    proofs: list[tuple[str, str]] = field(default_factory=list)  # verified (platform, handle)
    origin: str = "username"  # username | asserted | pivot:<platform>
    confidence: str = "unverified"
    evidence: list[str] = field(default_factory=list)

    @property
    def key(self) -> tuple[str, str]:
        return (self.platform, self.handle.lower())


@dataclass
class Attempt:
    platform: str
    handle: str
    status: str  # found | not found | unavailable
    detail: str = ""


@dataclass
class Dossier:
    subject: str
    generated: str
    accounts: list[Account]
    attempts: list[Attempt]
    summary: dict[str, object]
