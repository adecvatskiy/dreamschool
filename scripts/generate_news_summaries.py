#!/usr/bin/env python3
"""Generate static short and detailed summaries for news items."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
from typing import Any
from urllib import error, parse, request

DEFAULT_NEWS_API = (
    "https://script.google.com/macros/s/"
    "AKfycbwzhsf0fq5EMIqeaCElq79EYkTqUdNxHW3SD1KfKMUaDGdCM4iZEkcozbzUql7ToaN5Qg/exec"
)
DEFAULT_MODEL = "google/flan-t5-large"
DEFAULT_OUTPUT = os.path.join("news", "news-summaries.json")

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
URL_RE = re.compile(r"https?://[^\s<>\"]+", re.IGNORECASE)
PIPE_QUOTE_RE = re.compile(r"\|\s*([^|]+?)\s*\|")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
LEADING_LIST_RE = re.compile(r"^\s*(?:[-*•]+|\d+[.)])\s*")
NOISE_LABEL_RE = re.compile(
    r"\b(?:парсинг фото|галерея|как это выглядит в гугл таблице|оформление цитат)\s*:\s*",
    re.IGNORECASE,
)
CONNECTOR_RE = re.compile(
    r"^(сначала|затем|потом|также|кроме того|далее|в итоге|наконец)\b",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate build-time summaries for news/news.html"
    )
    parser.add_argument("--news-api", default=DEFAULT_NEWS_API)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0, help="0 = all records")
    parser.add_argument(
        "--token",
        default=os.environ.get("HF_TOKEN", "").strip(),
        help="HF token (defaults to HF_TOKEN env var)",
    )
    return parser.parse_args()


def fetch_jsonp(news_api: str) -> list[dict[str, Any]]:
    callback_name = f"newsBuildCallback_{int(time.time())}"
    url = f"{news_api}?callback={callback_name}&_={int(time.time())}"
    with request.urlopen(url, timeout=30) as response:
        body_bytes = response.read()
        header_charset = response.headers.get_content_charset()

    candidate_charsets = []
    if header_charset:
        candidate_charsets.append(header_charset)
    candidate_charsets.extend(["utf-8", "cp1251"])

    body = ""
    for charset in candidate_charsets:
        try:
            body = body_bytes.decode(charset, errors="strict")
            break
        except UnicodeDecodeError:
            continue
    else:
        body = body_bytes.decode("utf-8", errors="replace")

    prefix = f"{callback_name}("
    suffix = ");"
    if not body.startswith(prefix) or not body.endswith(suffix):
        raise RuntimeError("Unexpected response format from news API")

    payload = json.loads(body[len(prefix) : -len(suffix)])
    if not isinstance(payload, list):
        raise RuntimeError("News API payload is not a list")
    return [item if isinstance(item, dict) else {} for item in payload]


def to_plain_text(value: Any) -> str:
    text = str(value or "")
    text = html.unescape(text)
    text = TAG_RE.sub(" ", text)
    return SPACE_RE.sub(" ", text).strip()


def clean_summary_source_text(text: str) -> str:
    cleaned = str(text or "")
    cleaned = URL_RE.sub(" ", cleaned)
    cleaned = NOISE_LABEL_RE.sub(" ", cleaned)
    cleaned = PIPE_QUOTE_RE.sub(r"«\1»", cleaned)
    cleaned = cleaned.replace("|", " ")
    cleaned = cleaned.replace("««", "«").replace("»»", "»")
    cleaned = SPACE_RE.sub(" ", cleaned).strip()
    return cleaned


def choose_article_text(item: dict[str, Any]) -> str:
    raw = to_plain_text(
        item.get("content")
        or item.get("preview")
        or item.get("Текст")
        or item.get("description")
        or ""
    )
    return clean_summary_source_text(raw)


def split_sentences(text: str) -> list[str]:
    normalized = SPACE_RE.sub(" ", text).strip()
    if not normalized:
        return []
    parts = [chunk.strip() for chunk in SENTENCE_SPLIT_RE.split(normalized)]
    return [chunk for chunk in parts if chunk]


def normalize_generated_text(text: str) -> str:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    cleaned_lines = [LEADING_LIST_RE.sub("", line).strip() for line in lines]
    return SPACE_RE.sub(" ", " ".join(cleaned_lines)).strip()


def finalize_summary_text(raw_text: str, fallback_text: str = "") -> str:
    text = normalize_generated_text(raw_text)
    if not text:
        text = SPACE_RE.sub(" ", str(fallback_text or "")).strip()
    if not text:
        return ""

    last_stop = max(text.rfind("."), text.rfind("!"), text.rfind("?"))
    if last_stop >= int(len(text) * 0.45):
        text = text[: last_stop + 1].strip()

    if text and text[-1] not in ".!?":
        text = text.rstrip(",:;/- ")
        if text and text[-1] not in ".!?":
            text = f"{text}."
    text = text.replace("««", "«").replace("»»", "»")
    # Remove unmatched trailing quote if needed.
    if text.count("»") > text.count("«") and text.endswith("»."):
        text = text[:-2] + "."
    return text


def count_words(text: str) -> int:
    return len([part for part in SPACE_RE.split(str(text or "").strip()) if part])


def dedupe_sentences(sentences: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for sentence in sentences:
        key = SPACE_RE.sub(" ", sentence).strip().casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        output.append(sentence.strip())
    return output


def sentence_quality(sentence: str) -> float:
    text = sentence.strip()
    if not text:
        return -100.0

    words = count_words(text)
    score = min(words, 18)
    if words < 4:
        score -= 8
    if ":" in text[:40]:
        score -= 3
    if text.count('"') >= 2 or text.count("В«") >= 2:
        score -= 2
    if len(text) > 260:
        score -= 2
    if re.search(r"[A-Za-z]{8,}", text):
        score -= 1
    return score


def choose_fallback_sentences(sentences: list[str], *, detail_level: str) -> list[str]:
    clean_sentences = dedupe_sentences([finalize_summary_text(sentence) for sentence in sentences])
    if not clean_sentences:
        return []

    target_count = 6 if detail_level == "detailed" else 4
    target_positions = (
        [0.0, 0.18, 0.38, 0.58, 0.78, 1.0]
        if detail_level == "detailed"
        else [0.0, 0.33, 0.66, 1.0]
    )

    selected_indexes: list[int] = []
    total = len(clean_sentences)
    for position in target_positions:
        approx = round((total - 1) * position)
        search_order = sorted(
            range(total),
            key=lambda idx: (abs(idx - approx), -sentence_quality(clean_sentences[idx])),
        )
        for idx in search_order:
            if idx in selected_indexes:
                continue
            if sentence_quality(clean_sentences[idx]) < 1:
                continue
            selected_indexes.append(idx)
            break
        if len(selected_indexes) >= target_count:
            break

    if 0 not in selected_indexes:
        selected_indexes.append(0)

    return [clean_sentences[idx] for idx in sorted(set(selected_indexes))][:target_count]


def looks_like_coherent_summary(text: str, *, detail_level: str) -> bool:
    normalized = finalize_summary_text(text)
    if not normalized:
        return False

    sentences = dedupe_sentences(split_sentences(normalized))
    word_count = count_words(normalized)
    min_sentences = 5 if detail_level == "detailed" else 3
    min_words = 55 if detail_level == "detailed" else 24

    if len(sentences) < min_sentences or word_count < min_words:
        return False
    if any(count_words(sentence) < 3 for sentence in sentences[: min(2, len(sentences))]):
        return False
    if sum(1 for sentence in sentences if count_words(sentence) < 5) > max(1, len(sentences) // 2):
        return False
    return True


def pick_positions(total: int, count: int) -> list[int]:
    if total <= 0 or count <= 0:
        return []
    if total <= count:
        return list(range(total))
    result = []
    last = total - 1
    for i in range(count):
        idx = round(i * last / max(count - 1, 1))
        result.append(idx)
    unique = sorted(set(result))
    return unique


def apply_connectors(sentences: list[str]) -> list[str]:
    if not sentences:
        return []
    connectors = ["Затем", "Также", "Кроме того", "В итоге", "Наконец"]
    output = [sentences[0]]
    for idx, sentence in enumerate(sentences[1:], start=1):
        if CONNECTOR_RE.match(sentence):
            output.append(sentence)
            continue
        connector = connectors[min(idx - 1, len(connectors) - 1)]
        output.append(f"{connector} {sentence[:1].lower() + sentence[1:] if len(sentence) > 1 else sentence}")
    return output


def fallback_summary(text: str, *, detail_level: str) -> str:
    normalized = SPACE_RE.sub(" ", text).strip()
    if not normalized:
        return ""

    if detail_level == "detailed":
        max_chars = 920
    else:
        max_chars = 420

    sentences = split_sentences(normalized)
    if not sentences:
        clipped = normalized[:max_chars].rsplit(" ", 1)[0].strip()
        return finalize_summary_text(clipped, normalized)

    selected = choose_fallback_sentences(sentences, detail_level=detail_level)
    if not selected:
        selected = [sentences[i] for i in pick_positions(len(sentences), 6 if detail_level == "detailed" else 4)]
    selected = apply_connectors(selected)
    summary = " ".join(selected).strip()

    if len(summary) > max_chars:
        clipped = summary[:max_chars]
        last_stop = max(clipped.rfind("."), clipped.rfind("!"), clipped.rfind("?"))
        if last_stop > int(len(clipped) * 0.6):
            summary = clipped[: last_stop + 1]
        else:
            summary = clipped.rsplit(" ", 1)[0].strip()

    return finalize_summary_text(summary, normalized)


def call_hf_inference(prompt: str, model: str, token: str, *, max_new_tokens: int) -> str:
    endpoint = f"https://api-inference.huggingface.co/models/{parse.quote(model, safe='')}"
    payload = {
        "inputs": prompt.strip(),
        "parameters": {
            "max_new_tokens": max_new_tokens,
            "temperature": 0.2,
            "return_full_text": False,
        },
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    for _ in range(4):
        req = request.Request(endpoint, data=data, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=60) as response:
                parsed = json.loads(response.read().decode("utf-8", errors="replace"))
        except error.HTTPError as exc:
            parsed = json.loads(exc.read().decode("utf-8", errors="replace"))

        if isinstance(parsed, dict) and parsed.get("error"):
            eta = parsed.get("estimated_time")
            if eta:
                time.sleep(min(float(eta), 15))
                continue
            raise RuntimeError(str(parsed["error"]))

        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            generated = str(parsed[0].get("generated_text", "")).strip()
            if generated:
                return generated
        if isinstance(parsed, dict):
            generated = str(parsed.get("generated_text", "")).strip()
            if generated:
                return generated
        break

    raise RuntimeError("Empty response from Hugging Face inference")


def chunk_text_for_coverage(text: str, target_chunk_chars: int = 1200) -> list[str]:
    sentences = split_sentences(text)
    if not sentences:
        return [text]

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for sentence in sentences:
        sentence_len = len(sentence) + 1
        if current and current_len + sentence_len > target_chunk_chars:
            chunks.append(" ".join(current).strip())
            current = []
            current_len = 0
        current.append(sentence)
        current_len += sentence_len
    if current:
        chunks.append(" ".join(current).strip())
    return [chunk for chunk in chunks if chunk]


def build_coverage_source(text: str, model: str, token: str) -> str:
    chunks = chunk_text_for_coverage(text)
    if len(chunks) == 1 and len(chunks[0]) < 1400:
        return chunks[0]

    partial: list[str] = []
    total_chunks = len(chunks)
    for idx, chunk in enumerate(chunks, start=1):
        prompt = (
            "Retell this fragment of a school news article in Russian using 1-2 connected factual "
            "sentences. Preserve chronology, do not use lists, and do not invent details.\n\n"
            f"Fragment {idx} of {total_chunks}:\n{chunk}\n\nSummary:"
        )
        part = call_hf_inference(prompt, model, token, max_new_tokens=120)
        part = finalize_summary_text(part)
        if part:
            partial.append(f"Фрагмент {idx}: {part}")

    if not partial:
        return text
    return "\n".join(partial)


def generate_hf_summary_pair(text: str, model: str, token: str) -> tuple[str, str]:
    source = build_coverage_source(text, model, token)
    short_fallback = fallback_summary(text, detail_level="short")
    detailed_fallback = fallback_summary(text, detail_level="detailed")

    short_prompt = (
        "Write a coherent retelling in Russian based only on this school news material. Produce "
        "one complete paragraph of 3-4 full sentences. The result must read like a short finished "
        "text, not like notes or separate fragments. Preserve the factual meaning and event order. "
        "Do not use lists, headings, quotes-only lines, or add details that are absent from the source.\n\n"
        f"{source}\n\nShort retelling:"
    )
    detailed_prompt = (
        "Write a coherent detailed retelling in Russian based only on this school news material. "
        "Produce one complete paragraph of 6-8 full sentences. The paragraph must have logical flow, "
        "clear links between sentences, and preserve chronology. Do not use lists, headings, quotes-only "
        "lines, or add details that are absent from the source.\n\n"
        f"{source}\n\nDetailed retelling:"
    )

    short_raw = call_hf_inference(short_prompt, model, token, max_new_tokens=240)
    detailed_raw = call_hf_inference(detailed_prompt, model, token, max_new_tokens=460)

    short = finalize_summary_text(short_raw, short_fallback)
    detailed = finalize_summary_text(detailed_raw, detailed_fallback)
    if not looks_like_coherent_summary(short, detail_level="short"):
        short = short_fallback
    if not looks_like_coherent_summary(detailed, detail_level="detailed"):
        detailed = detailed_fallback
    return short, detailed


def build_summaries(
    items: list[dict[str, Any]], model: str, token: str
) -> dict[str, dict[str, str]]:
    summaries: dict[str, dict[str, str]] = {}
    total = len(items)

    for index, item in enumerate(items):
        title = str(item.get("title") or item.get("Заголовок") or "").strip()
        text = choose_article_text(item)
        if not text:
            summaries[str(index)] = {
                "summary": "",
                "short_summary": "",
                "detailed_summary": "",
                "title": title,
            }
            continue

        short_summary = ""
        detailed_summary = ""
        if token:
            try:
                short_summary, detailed_summary = generate_hf_summary_pair(text, model, token)
            except Exception as err:  # noqa: BLE001
                print(
                    f"[{index + 1}/{total}] HF failed, fallback used: {err}",
                    file=sys.stderr,
                )

        if not short_summary:
            short_summary = fallback_summary(text, detail_level="short")
        if not detailed_summary:
            detailed_summary = fallback_summary(text, detail_level="detailed")

        summaries[str(index)] = {
            "summary": short_summary,
            "short_summary": short_summary,
            "detailed_summary": detailed_summary,
            "title": title,
        }
        print(f"[{index + 1}/{total}] done: {title or 'Без названия'}")

    return summaries


def write_output(
    path: str,
    summaries: dict[str, dict[str, str]],
    model: str,
    news_api: str,
) -> None:
    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "model": model,
        "source_api": news_api,
        "items": summaries,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main() -> int:
    args = parse_args()
    items = fetch_jsonp(args.news_api)
    if args.limit > 0:
        items = items[: args.limit]

    summaries = build_summaries(items, args.model, args.token)
    write_output(args.output, summaries, args.model, args.news_api)
    print(f"Saved {len(summaries)} summaries to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
