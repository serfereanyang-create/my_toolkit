import argparse
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

import jieba

from main import run_pipeline
from visualize_network import render_static_graph


BASE_DIR = Path(__file__).resolve().parent
USER_MEMORY_FILE = BASE_DIR / "user_memories.json"
NETWORK_OUTPUT_FILE = BASE_DIR / "memory_network_output.json"
STATIC_IMAGE_FILE = BASE_DIR / "memory_network_static.png"
STOPWORDS = {
    "的", "了", "和", "是", "就", "都", "而", "及", "与", "着", "或", "一个", "一种", "这个", "那个",
    "这样", "那样", "我们", "你们", "他们", "自己", "已经", "还是", "因为", "所以", "如果", "然后",
    "可以", "应该", "不会", "会", "要", "想", "觉得", "一下", "一下子", "今天", "明天", "昨天",
    "现在", "时候", "东西", "问题", "系统", "需要", "通过", "进行", "这样做", "这里", "那里",
    "突然", "想到", "一条", "一句", "一下", "之后", "最好", "确认", "希望", "只", "输入", "提交",
    "自动", "根据", "频率", "出现", "重复", "然后", "页面", "浏览器",
}
PRIORITY_TERMS = {
    "记忆", "长期", "短期", "节点", "网络", "主题", "标签", "静态图", "可视化", "概率", "区块", "增强",
    "强化", "刷新", "网页", "面板", "提交", "测试", "embedding", "模型",
}


def load_user_memories() -> list[dict]:
    if not USER_MEMORY_FILE.exists():
        return []
    return json.loads(USER_MEMORY_FILE.read_text(encoding="utf-8"))


def save_user_memories(memories: list[dict]) -> None:
    USER_MEMORY_FILE.write_text(json.dumps(memories, ensure_ascii=False, indent=2), encoding="utf-8")


def next_memory_id(memories: list[dict]) -> str:
    used = {
        int(item["id"][1:])
        for item in memories
        if isinstance(item.get("id"), str) and item["id"].startswith("u") and item["id"][1:].isdigit()
    }
    current = 1
    while current in used:
        current += 1
    return f"u{current}"


def split_tags(raw_tags: str | None) -> list[str]:
    if not raw_tags:
        return []
    normalized = raw_tags.replace("，", ",")
    return [tag.strip() for tag in normalized.split(",") if tag.strip()]


def is_tag_candidate(token: str) -> bool:
    stripped = token.strip()
    if not stripped or stripped in STOPWORDS:
        return False
    if len(stripped) == 1 and not stripped.isascii():
        return False
    if stripped.isdigit():
        return False
    if all(not char.isalnum() and not ('一' <= char <= '鿿') for char in stripped):
        return False
    return True


def auto_tags_from_text(text: str, limit: int = 4) -> list[str]:
    tokens = [token.strip() for token in jieba.lcut(text) if is_tag_candidate(token)]
    counts = Counter(tokens)
    ranked = sorted(
        counts.items(),
        key=lambda item: (
            -(2 if item[0] in PRIORITY_TERMS else 0),
            -item[1],
            -len(item[0]),
            text.find(item[0]),
        ),
    )
    tags = [token for token, _ in ranked[:limit]]

    if len(tags) < 2:
        compact = text.replace("，", " ").replace("。", " ").replace("：", " ").replace(",", " ")
        for part in compact.split():
            if is_tag_candidate(part) and part not in tags:
                tags.append(part)
            if len(tags) >= limit:
                break

    return tags[:limit]


def build_memory_record(
    text: str,
    memories: list[dict],
    importance: float = 0.7,
    raw_tags: str | None = None,
    created_at: str | None = None,
) -> dict:
    tags = split_tags(raw_tags)
    if not tags:
        tags = auto_tags_from_text(text)
    return {
        "id": next_memory_id(memories),
        "text": text,
        "created_at": created_at or datetime.now().replace(microsecond=0).isoformat(),
        "importance_hint": max(0.0, min(1.0, importance)),
        "tags": tags,
    }


def rebuild_outputs() -> tuple[Path, Path]:
    run_pipeline(output_path=NETWORK_OUTPUT_FILE)
    render_static_graph(input_path=NETWORK_OUTPUT_FILE, output_path=STATIC_IMAGE_FILE)
    return NETWORK_OUTPUT_FILE, STATIC_IMAGE_FILE


def add_memory(
    text: str,
    importance: float = 0.7,
    raw_tags: str | None = None,
    created_at: str | None = None,
) -> dict:
    memories = load_user_memories()
    memory = build_memory_record(
        text=text,
        memories=memories,
        importance=importance,
        raw_tags=raw_tags,
        created_at=created_at,
    )
    memories.append(memory)
    save_user_memories(memories)
    rebuild_outputs()
    return memory


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="自然语言添加一条记忆，并自动重算网络与静态图")
    parser.add_argument("text", help="记忆内容，自然语言一句话即可")
    parser.add_argument("--tags", help="逗号分隔的标签，例如 记忆,长期,测试")
    parser.add_argument("--importance", type=float, default=0.7, help="重要度提示，0 到 1，默认 0.7")
    parser.add_argument("--time", help="ISO 时间，如 2026-04-24T12:30:00；默认使用当前时间")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    memory = add_memory(
        text=args.text,
        importance=args.importance,
        raw_tags=args.tags,
        created_at=args.time,
    )

    print("已添加记忆:")
    print(json.dumps(memory, ensure_ascii=False, indent=2))
    print(f"用户记忆文件: {USER_MEMORY_FILE}")
    print(f"网络结果: {NETWORK_OUTPUT_FILE}")
    print(f"静态图: {STATIC_IMAGE_FILE}")


if __name__ == "__main__":
    main()
