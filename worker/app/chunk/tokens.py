"""Token counting. tiktoken's cl100k encoder is a close enough proxy for sizing
chunks; exact counts differ per model and only matter at the margins."""
from __future__ import annotations

import tiktoken

_enc = tiktoken.get_encoding("cl100k_base")


def count(text: str) -> int:
    return len(_enc.encode(text, disallowed_special=()))
