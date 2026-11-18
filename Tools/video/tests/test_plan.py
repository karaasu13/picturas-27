"""Tests for the split of a video pipeline into stages (common.plan)."""
import pytest

from common.errors import InvalidExtraction
from common.plan import EDIT_QUEUE, EXTRACT_QUEUE, SUBTITLES_QUEUE, plan_stages


def tools(*names):
    return [{"procedure": name, "params": {}} for name in names]


def shape(stages):
    return [(s["queue"], [t["procedure"] for t in s["tools"]], s["preview"]) for s in stages]


# Ordinary effects share a single decode/encode pass in the edit service
def test_ordinary_effects_are_one_edit_stage():
    stages = plan_stages(tools("trim", "speed", "brightness", "rotate"), preview=True)
    assert shape(stages) == [(EDIT_QUEUE, ["trim", "speed", "brightness", "rotate"], True)]
    assert stages[0]["progress"] == [0, 100]


# An empty pipeline still re-encodes the video (normalised output)
def test_empty_pipeline():
    assert shape(plan_stages([])) == [(EDIT_QUEUE, [], False)]


# Captions split the pipeline; the input is always normalised by an edit stage first
def test_subtitles_split_the_pipeline():
    assert shape(plan_stages(tools("subtitles"))) == [
        (EDIT_QUEUE, [], False), (SUBTITLES_QUEUE, ["subtitles"], False)]
    assert shape(plan_stages(tools("trim", "subtitles", "subtitles", "border"))) == [
        (EDIT_QUEUE, ["trim"], False), (SUBTITLES_QUEUE, ["subtitles"], False),
        (SUBTITLES_QUEUE, ["subtitles"], False), (EDIT_QUEUE, ["border"], False)]


# The preview excerpt is cut by the last stage that changes the timeline
@pytest.mark.parametrize("names,cut_at", [
    (("subtitles",), 0),
    (("brightness", "subtitles"), 0),
    (("trim", "subtitles", "brightness"), 0),
    (("subtitles", "trim"), 2),
    (("speed", "subtitles", "trim", "subtitles", "rotate"), 2),
])
def test_preview_is_cut_after_the_last_temporal_stage(names, cut_at):
    stages = plan_stages(tools(*names), preview=True)
    assert [i for i, s in enumerate(stages) if s["preview"]] == [cut_at]


# Extraction alone samples the original; after edits it is the last stage, on the full timeline
def test_extraction_is_the_last_stage():
    assert shape(plan_stages(tools("extract_frames"), preview=True)) == [
        (EXTRACT_QUEUE, ["extract_frames"], True)]
    stages = plan_stages(tools("trim", "subtitles", "extract_frames"), preview=True)
    assert shape(stages) == [(EDIT_QUEUE, ["trim"], False), (SUBTITLES_QUEUE, ["subtitles"], False),
                             (EXTRACT_QUEUE, ["extract_frames"], True)]
    assert [s["progress"] for s in stages] == [[0, 35], [35, 70], [70, 100]]


@pytest.mark.parametrize("names", [("extract_frames", "rotate"), ("extract_frames", "extract_frames")])
def test_extraction_must_be_terminal_and_unique(names):
    with pytest.raises(InvalidExtraction):
        plan_stages(tools(*names))


# The slices of progress are contiguous and cover 0 to 100
@pytest.mark.parametrize("names", [("rotate",), ("subtitles", "trim"), ("cut", "subtitles", "extract_frames")])
def test_progress_slices_are_contiguous(names):
    slices = [s["progress"] for s in plan_stages(tools(*names))]
    assert slices[0][0] == 0 and slices[-1][1] == 100
    assert all(a[1] == pytest.approx(b[0]) for a, b in zip(slices, slices[1:]))


# Invalid extraction parameters reject the whole plan (the router answers before any stage)
@pytest.mark.parametrize("params", [{"mode": "bogus", "format": "png"}, {"mode": "count", "count": 500},
                                    {"mode": "interval", "interval": 0}, None])
def test_invalid_extraction_parameters_reject_the_plan(params):
    with pytest.raises(InvalidExtraction):
        plan_stages([{"procedure": "trim", "params": {}}, {"procedure": "extract_frames", "params": params}])

