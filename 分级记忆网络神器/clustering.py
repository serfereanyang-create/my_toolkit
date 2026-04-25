from collections import defaultdict
from typing import Dict, List

import numpy as np
from sklearn.cluster import AgglomerativeClustering


def cluster_embeddings(embeddings: np.ndarray) -> List[int]:
    if len(embeddings) <= 2:
        return list(range(len(embeddings)))

    n_clusters = max(2, min(4, len(embeddings) // 3))
    model = AgglomerativeClustering(n_clusters=n_clusters, metric="cosine", linkage="average")
    return model.fit_predict(embeddings).tolist()


def summarize_clusters(texts: List[str], labels: List[int], tags_list: List[List[str]]) -> Dict[int, Dict[str, object]]:
    grouped_texts: Dict[int, List[str]] = defaultdict(list)
    grouped_tags: Dict[int, List[str]] = defaultdict(list)

    for text, label, tags in zip(texts, labels, tags_list):
        grouped_texts[label].append(text)
        grouped_tags[label].extend(tags)

    summaries: Dict[int, Dict[str, object]] = {}
    for label in sorted(grouped_texts):
        tags = grouped_tags[label]
        top_tags = [tag for tag, _ in sorted(((tag, tags.count(tag)) for tag in set(tags)), key=lambda item: (-item[1], item[0]))[:3]]
        summaries[label] = {
            "label": label,
            "size": len(grouped_texts[label]),
            "top_tags": top_tags,
            "preview_text": grouped_texts[label][0],
        }

    return summaries
