from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Dict, Optional


@dataclass
class MemoryPoint:
    id: str
    text: str
    created_at: datetime
    importance_hint: float = 0.5
    tags: List[str] = field(default_factory=list)


@dataclass
class MemoryEdge:
    source: str
    target: str
    semantic_similarity: float
    tag_overlap: float
    time_proximity: float
    weight: float
    edge_type: str


@dataclass
class MemoryNodeState:
    id: str
    text: str
    created_at: str
    tags: List[str]
    importance_hint: float
    embedding: List[float]
    cluster_id: int
    importance_score: float
    confidence_score: float
    intensity: float
    size: float
    time_tier: str
    centrality: float
    stability_score: float


@dataclass
class MemoryNetworkResult:
    nodes: List[MemoryNodeState]
    edges: List[MemoryEdge]
    clusters: Dict[int, Dict[str, object]]
    generated_at: str
    metadata: Dict[str, object]
