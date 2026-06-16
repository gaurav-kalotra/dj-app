"""Camelot wheel: key name → (number, letter) and harmonic distance."""

# Maps librosa key strings to Camelot positions.
# librosa returns keys like "C major", "A minor", "F# major", etc.
_KEY_TO_CAMELOT: dict[str, tuple[int, str]] = {
    # Major keys (B wheel)
    "B major":  (1,  "B"),
    "F# major": (2,  "B"),
    "Db major": (3,  "B"),
    "Ab major": (4,  "B"),
    "Eb major": (5,  "B"),
    "Bb major": (6,  "B"),
    "F major":  (7,  "B"),
    "C major":  (8,  "B"),
    "G major":  (9,  "B"),
    "D major":  (10, "B"),
    "A major":  (11, "B"),
    "E major":  (12, "B"),
    # Minor keys (A wheel)
    "Ab minor": (1,  "A"),
    "Eb minor": (2,  "A"),
    "Bb minor": (3,  "A"),
    "F minor":  (4,  "A"),
    "C minor":  (5,  "A"),
    "G minor":  (6,  "A"),
    "D minor":  (7,  "A"),
    "A minor":  (8,  "A"),
    "E minor":  (9,  "A"),
    "B minor":  (10, "A"),
    "F# minor": (11, "A"),
    "C# minor": (12, "A"),
    # Enharmonic aliases
    "C# major": (3,  "B"),
    "G# major": (4,  "B"),
    "D# major": (5,  "B"),
    "A# major": (6,  "B"),
    "G# minor": (1,  "A"),
    "D# minor": (2,  "A"),
    "A# minor": (3,  "A"),
}


def to_camelot(key: str) -> tuple[int, str] | None:
    """Return (number, letter) for a key string, or None if unknown."""
    return _KEY_TO_CAMELOT.get(key)


def camelot_distance(a: str, b: str) -> int | None:
    """
    Minimum Camelot wheel steps between two keys.
    Returns None if either key is unmappable.
    Compatible keys for long_blend: distance <= 1.
    """
    ca = to_camelot(a)
    cb = to_camelot(b)
    if ca is None or cb is None:
        return None

    num_a, let_a = ca
    num_b, let_b = cb

    if let_a == let_b:
        # Same ring: circular distance on 1–12
        diff = abs(num_a - num_b)
        return min(diff, 12 - diff)
    else:
        # Letter swap (A↔B): only compatible if same number
        return 0 if num_a == num_b else min(
            abs(num_a - num_b),
            12 - abs(num_a - num_b),
        ) + 1


def is_blend_compatible(a: str, b: str) -> bool:
    """True if keys are within 1 Camelot step (safe for long_blend)."""
    d = camelot_distance(a, b)
    return d is not None and d <= 1
