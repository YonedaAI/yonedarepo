"""Align the approved transcript to local ASR word times; retain original copy."""

from difflib import SequenceMatcher
import json
import re
import textwrap


def timestamp(seconds):
    milliseconds = round(seconds*1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def webvtt_timestamps(srt):
    return re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", srt)


def normalized(word):
    return re.sub(r"[^a-z0-9]", "", word.lower())


def aligned_words(narration, alignment, seconds):
    reference = narration.split()
    spoken = [word for segment in alignment["segments"]
              for word in segment.get("words", [])]
    matcher = SequenceMatcher(None, [normalized(w) for w in reference],
                              [normalized(w["word"]) for w in spoken], autojunk=False)
    if matcher.ratio() < 0.85:
        raise ValueError("ASR differs materially from narration; inspect the audio before assembly")
    spans = [None]*len(reference)
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            word = spoken[block.b+offset]
            spans[block.a+offset] = [float(word["start"]), float(word["end"])]
    cursor = 0
    while cursor < len(spans):
        if spans[cursor] is not None:
            cursor += 1
            continue
        end = cursor
        while end < len(spans) and spans[end] is None:
            end += 1
        left = spans[cursor-1][1] if cursor else 0.0
        right = spans[end][0] if end < len(spans) else seconds
        step = max(0, right-left)/(end-cursor)
        for j in range(cursor, end):
            spans[j] = [left+(j-cursor)*step, left+(j-cursor+1)*step]
        cursor = end
    return reference, spans, matcher.ratio()


def scene_captions(scene, audio_seconds, alignment_path, first_index):
    alignment = json.loads(alignment_path.read_text())
    words, spans, ratio = aligned_words(scene["narration"], alignment, audio_seconds)
    captions = []
    for i in range(0, len(words), 12):
        last = min(i+12, len(words))-1
        start = scene["start_seconds"]+spans[i][0]
        end = scene["start_seconds"]+min(audio_seconds, spans[last][1])
        if end <= start:
            raise ValueError("Caption has no duration")
        captions.append(
            f"{first_index+len(captions)}\n{timestamp(start)} --> {timestamp(end)}\n"
            + "\n".join(textwrap.wrap(" ".join(words[i:last+1]), 70))+"\n"
        )
    return captions, ratio
