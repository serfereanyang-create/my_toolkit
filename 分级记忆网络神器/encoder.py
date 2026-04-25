from pathlib import Path
from typing import List

import jieba
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

from memory_types import MemoryPoint

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None


class MemoryEncoder:
    def __init__(
        self,
        model_name: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        models_dir: Path | None = None,
    ) -> None:
        self.model_name = model_name
        self.models_dir = models_dir or Path(__file__).with_name("models")
        self.model_path = self._resolve_local_model_path(model_name)
        self.model = self._load_local_model()
        self.backend = "sentence-transformers" if self.model is not None else "local-token-embedding"
        self.vectorizer = TfidfVectorizer(tokenizer=self._tokenize, token_pattern=None, ngram_range=(1, 2))

    def encode(self, memories: List[MemoryPoint]) -> np.ndarray:
        corpus = [self._build_text(memory) for memory in memories]
        if self.model is not None:
            embeddings = self.model.encode(corpus, normalize_embeddings=True)
            return np.asarray(embeddings, dtype=float)
        matrix = self.vectorizer.fit_transform(corpus)
        embeddings = matrix.toarray().astype(float)
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        return np.divide(embeddings, norms, out=np.zeros_like(embeddings), where=norms != 0)

    @staticmethod
    def _build_text(memory: MemoryPoint) -> str:
        tags = " ".join(memory.tags)
        return f"{memory.text} {tags}".strip()

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        return [token.strip() for token in jieba.lcut(text) if token.strip()]

    def _resolve_local_model_path(self, model_name: str) -> Path:
        model_leaf = model_name.split("/")[-1]
        return self.models_dir / model_leaf

    def _load_local_model(self):
        if SentenceTransformer is None:
            return None
        if not self.model_path.exists():
            return None
        try:
            return SentenceTransformer(str(self.model_path))
        except Exception:
            return None
