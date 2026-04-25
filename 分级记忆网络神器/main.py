import json
from datetime import UTC, datetime
from pathlib import Path
from typing import List

from clustering import cluster_embeddings, summarize_clusters
from encoder import MemoryEncoder
from memory_types import MemoryNetworkResult, MemoryNodeState
from network_builder import build_memory_graph
from ranking import compute_node_scores
from sample_data import NOW, load_all_memories


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
OUTPUT_FILE = BASE_DIR / "memory_network_output.json"


def build_result(model_name: str = DEFAULT_MODEL) -> MemoryNetworkResult:
    memories = load_all_memories()
    encoder = MemoryEncoder(model_name=model_name)
    embeddings = encoder.encode(memories)
    cluster_labels = cluster_embeddings(embeddings)
    graph, edges = build_memory_graph(memories, embeddings)
    scores = compute_node_scores(memories, graph, cluster_labels, NOW)
    clusters = summarize_clusters(
        texts=[memory.text for memory in memories],
        labels=cluster_labels,
        tags_list=[memory.tags for memory in memories],
    )

    nodes: List[MemoryNodeState] = []
    for index, memory in enumerate(memories):
        score = scores[memory.id]
        nodes.append(
            MemoryNodeState(
                id=memory.id,
                text=memory.text,
                created_at=memory.created_at.isoformat(),
                tags=memory.tags,
                importance_hint=memory.importance_hint,
                embedding=[round(value, 4) for value in embeddings[index].tolist()],
                cluster_id=int(score["cluster_id"]),
                importance_score=float(score["importance_score"]),
                confidence_score=float(score["confidence_score"]),
                intensity=float(score["intensity"]),
                size=float(score["size"]),
                time_tier=str(score["time_tier"]),
                centrality=float(score["centrality"]),
                stability_score=float(score["stability_score"]),
            )
        )

    metadata = {
        "memory_count": len(memories),
        "edge_count": len(edges),
        "cluster_count": len(clusters),
        "threshold": 0.24,
        "encoder": encoder.backend,
        "encoder_model": encoder.model_name if encoder.backend == "sentence-transformers" else "jieba-tfidf-normalized",
        "local_model_path": str(encoder.model_path) if encoder.backend == "sentence-transformers" else None,
    }

    return MemoryNetworkResult(
        nodes=nodes,
        edges=edges,
        clusters=clusters,
        generated_at=datetime.now(UTC).isoformat(),
        metadata=metadata,
    )


def save_result(result: MemoryNetworkResult, output_path: Path = OUTPUT_FILE) -> Path:
    payload = {
        "generated_at": result.generated_at,
        "metadata": result.metadata,
        "clusters": result.clusters,
        "nodes": [node.__dict__ for node in result.nodes],
        "edges": [edge.__dict__ for edge in result.edges],
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return output_path


def run_pipeline(model_name: str = DEFAULT_MODEL, output_path: Path = OUTPUT_FILE) -> tuple[MemoryNetworkResult, Path]:
    result = build_result(model_name=model_name)
    saved_path = save_result(result, output_path=output_path)
    return result, saved_path


def print_summary(result: MemoryNetworkResult) -> None:
    print("分级记忆网络已生成")
    print(f"节点数: {result.metadata['memory_count']}")
    print(f"边数: {result.metadata['edge_count']}")
    print(f"主题区块数: {result.metadata['cluster_count']}")
    print()
    print("重要度 Top 5")
    for node in sorted(result.nodes, key=lambda item: item.importance_score, reverse=True)[:5]:
        print(
            f"- {node.id} | 层级={node.time_tier} | 主题={node.cluster_id} | "
            f"importance={node.importance_score:.3f} | confidence={node.confidence_score:.3f} | text={node.text}"
        )


if __name__ == "__main__":
    result, output_path = run_pipeline()
    print_summary(result)
    print()
    print(f"JSON 输出: {output_path.resolve()}")
