"""Tests for the video services as RabbitMQ workers, with a fake broker.

The router and the three stage services are wired to in-memory queues, so a
job travels router -> stage services -> project_queue exactly as in the
deployed system, without RabbitMQ.
"""
import json
import sys
import types
from types import SimpleNamespace

import pytest


class FakeBroker:
    def __init__(self):
        self.queues = {}
        self.acked = 0

    def channel(self):
        broker = self

        class Channel:
            def exchange_declare(self, **_kw): pass
            def queue_bind(self, **_kw): pass
            def basic_qos(self, **_kw): pass

            def queue_declare(self, queue, **_kw):
                broker.queues.setdefault(queue, [])

            def basic_publish(self, exchange, routing_key, body):
                broker.queues.setdefault(routing_key, []).append(json.loads(body))

            def basic_ack(self, delivery_tag):
                broker.acked += 1
        return Channel()


@pytest.fixture
def services(monkeypatch):
    """Router and stage workers connected to a fake broker; returns (broker, deliver)."""
    broker = FakeBroker()
    pika = types.ModuleType("pika")
    pika.PlainCredentials = lambda *a, **k: None
    pika.ConnectionParameters = lambda *a, **k: None
    pika.BlockingConnection = lambda _params: SimpleNamespace(channel=broker.channel)
    pika.exceptions = SimpleNamespace(AMQPConnectionError=ConnectionError)
    exchange_type = types.ModuleType("pika.exchange_type")
    exchange_type.ExchangeType = SimpleNamespace(direct="direct")
    monkeypatch.setitem(sys.modules, "pika", pika)
    monkeypatch.setitem(sys.modules, "pika.exchange_type", exchange_type)
    for name in ("common.messaging", "common.worker", "router.router"):
        monkeypatch.delitem(sys.modules, name, raising=False)

    from common.plan import EDIT_QUEUE, EXTRACT_QUEUE, SUBTITLES_QUEUE
    from common.worker import StageWorker
    from edit import processor
    from extract_frames import extraction
    from router.router import VIDEO_QUEUE, VideoRouter
    from subtitles import captions

    consumers = {
        VIDEO_QUEUE: VideoRouter(),
        EDIT_QUEUE: StageWorker(EDIT_QUEUE, "edit", lambda c: processor.edit_stage(c)),
        SUBTITLES_QUEUE: StageWorker(SUBTITLES_QUEUE, "subtitles", lambda c: captions.subtitles_stage(c)),
        EXTRACT_QUEUE: StageWorker(EXTRACT_QUEUE, "extract", lambda c: extraction.extraction_stage(c)),
    }

    def deliver(message, queue=VIDEO_QUEUE):
        """Publishes `message` and lets every service consume until the queues are empty."""
        broker.queues.setdefault(queue, []).append(message)
        visited = []
        while True:
            pending = next((q for q in consumers if broker.queues.get(q)), None)
            if pending is None:
                return visited
            visited.append(pending)
            body = json.dumps(broker.queues[pending].pop(0)).encode()
            consumers[pending].callback(consumers[pending]._channel, SimpleNamespace(delivery_tag=1), None, body)

    deliver.consumers = consumers
    return broker, deliver


def job(source, output, tools, preview=False, procedure="video"):
    return {"messageId": "request-1234", "procedure": procedure,
            "parameters": {"inputImageURI": source, "outputImageURI": output, "tools": tools,
                           "preview": preview,
                           "progress": {"user": "u1", "projectId": "p1", "imgId": "i1"}}}


def recognizer():
    segment = SimpleNamespace(start=0, end=2, text="Hello")
    return SimpleNamespace(transcribe=lambda *a, **k: (iter([segment]), None))


# A single-stage job goes router -> edit service -> orchestrator, in the reply format it expects
def test_edit_job_replies_to_the_orchestrator(services, sample_video, tmp_path):
    broker, deliver = services
    out = str(tmp_path / "out" / "result.mp4")
    visited = deliver(job(sample_video, out, [{"procedure": "brightness", "params": {"brightness": 1.2}}]))
    assert visited == ["video_queue", "video_edit_queue"]
    (reply,) = broker.queues["project_queue"]
    assert reply["status"] == "success" and reply["correlationId"] == "request-1234"
    assert reply["output"] == {"type": "video", "imageURI": out}
    assert reply["metadata"]["video"]["duration"] == pytest.approx(4, abs=0.15)
    assert (tmp_path / "out" / "result.mp4").is_file()
    assert [p.name for p in (tmp_path / "out").iterdir()] == ["result.mp4"]
    assert broker.acked == 2


# Each stage runs in its own service, in pipeline order, and only the last one replies
def test_stages_travel_through_their_services(services, sample_video, tmp_path, monkeypatch):
    from subtitles import captions
    monkeypatch.setattr(captions, "speech_model", recognizer)
    broker, deliver = services
    out = str(tmp_path / "result.mp4")
    tools = [{"procedure": "trim", "params": {"start": 0, "end": 2}}, {"procedure": "subtitles", "params": {}},
             {"procedure": "rotate", "params": {"degrees": 90}},
             {"procedure": "extract_frames", "params": {"mode": "count", "count": 2, "format": "png"}}]
    visited = deliver(job(sample_video, out, tools))
    assert visited == ["video_queue", "video_edit_queue", "video_subtitles_queue",
                       "video_edit_queue", "video_extract_queue"]
    (reply,) = broker.queues["project_queue"]
    assert reply["status"] == "success" and reply["output"]["type"] == "frames"
    assert len(reply["output"]["frames"]) == 2
    assert reply["metadata"]["video"]["width"] == 240  # rotated after the captions
    assert not list(tmp_path.glob(".video-work-*"))


# Progress is reported for the whole pipeline: it never goes back and ends at 100
def test_progress_covers_the_whole_pipeline(services, sample_video, tmp_path, monkeypatch):
    from subtitles import captions
    monkeypatch.setattr(captions, "speech_model", recognizer)
    broker, deliver = services
    deliver(job(sample_video, str(tmp_path / "result.mp4"),
                [{"procedure": "subtitles", "params": {}}, {"procedure": "contrast", "params": {"contrastFactor": 1.5}}]))
    events = broker.queues["ws_queue"]
    percents = [e["percent"] for e in events]
    assert percents == sorted(percents) and percents[-1] == 100 and percents.count(100) == 1
    assert all(e["user"] == "u1" and e["imgId"] == "i1" and e["preview"] is False for e in events)
    assert all(e["messageId"].startswith("update-client-video-progress-") for e in events)


# A failing stage reports the error code, stops the pipeline and leaves nothing behind
@pytest.mark.parametrize("tools,code", [
    ([{"procedure": "trim", "params": {"start": 20, "end": 30}}], 2003),
    ([{"procedure": "speed", "params": {"factor": 50}}], 2005),
    ([{"procedure": "obj_ai", "params": {}}], 2002),
    ([{"procedure": "resize", "params": {"width": 0, "height": 0}}], 2001),
    ([{"procedure": "subtitles", "params": {}}, {"procedure": "trim", "params": {"start": 9, "end": 10}}], 2003),
    ([{"procedure": "extract_frames", "params": {"mode": "count", "count": 1, "format": "png"}},
      {"procedure": "rotate", "params": {"degrees": 90}}], 2001),
])
def test_failure_is_reported_with_its_code(services, sample_video, tmp_path, monkeypatch, tools, code):
    from subtitles import captions
    monkeypatch.setattr(captions, "speech_model", recognizer)
    broker, deliver = services
    out = tmp_path / "result.mp4"
    deliver(job(sample_video, str(out), tools))
    (reply,) = broker.queues["project_queue"]
    assert reply["status"] == "error" and reply["error"]["code"] == code
    assert reply["error"]["msg"] == reply["error"]["message"] != ""
    assert reply["error"]["details"] == {"inputFileURI": sample_video}
    assert not out.exists() and not list(tmp_path.glob(".video-work-*"))
    assert not any(broker.queues.get(q) for q in ("video_edit_queue", "video_subtitles_queue", "video_extract_queue"))


# A corrupted source is reported as an invalid video
def test_unreadable_video(services, tmp_path):
    broker, deliver = services
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video")
    deliver(job(str(bad), str(tmp_path / "o.mp4"), [{"procedure": "brightness", "params": {"brightness": 1}}]))
    assert broker.queues["project_queue"][0]["error"]["code"] == 2004


# Messages that are not video jobs are refused; malformed ones are discarded and acknowledged
def test_wrong_and_malformed_messages(services, sample_video, tmp_path):
    broker, deliver = services
    deliver(job(sample_video, str(tmp_path / "o.mp4"), [], procedure="brightness"))
    assert broker.queues["project_queue"][0]["error"]["code"] == 2000
    # a job delivered to a stage service without a plan for it is refused too
    deliver(job(sample_video, str(tmp_path / "o.mp4"), []), queue="video_subtitles_queue")
    assert broker.queues["project_queue"][1]["error"]["code"] == 2000
    deliver({"procedure": "video"})
    assert len(broker.queues["project_queue"]) == 2 and broker.acked == 3


# A preview only renders the first seconds and flags its progress events as preview
def test_preview_job(services, sample_video, tmp_path):
    broker, deliver = services
    deliver(job(sample_video, str(tmp_path / "p.mp4"),
                [{"procedure": "brightness", "params": {"brightness": 1.1}}], preview=True))
    reply = broker.queues["project_queue"][0]
    assert reply["metadata"]["video"]["duration"] == pytest.approx(3, abs=0.15)
    assert all(e["preview"] is True for e in broker.queues["ws_queue"])


# ---------------------------------------------------------------------------
# An invalid pipeline is rejected before any expensive stage runs
# ---------------------------------------------------------------------------

STAGE_QUEUES = ("video_edit_queue", "video_subtitles_queue", "video_extract_queue")


class CountingRecognizer:
    """Speech model stub that counts how many recognitions ran."""

    def __init__(self):
        self.runs = 0

    def __call__(self):
        return self

    def transcribe(self, *_args, **_kwargs):
        self.runs += 1
        return iter([SimpleNamespace(start=0, end=2, text="Hello")]), None


# An unknown effect after the captions fails in the first edit stage, before speech recognition
def test_unknown_effect_is_rejected_before_captions(services, sample_video, tmp_path, monkeypatch):
    from subtitles import captions
    speech = CountingRecognizer()
    monkeypatch.setattr(captions, "speech_model", speech)
    broker, deliver = services
    visited = deliver(job(sample_video, str(tmp_path / "r.mp4"),
                          [{"procedure": "subtitles", "params": {}}, {"procedure": "obj_ai", "params": {}}]))
    assert visited == ["video_queue", "video_edit_queue"]
    (reply,) = broker.queues["project_queue"]
    assert reply["status"] == "error" and reply["error"]["code"] == 2002
    assert reply["error"]["msg"] == "Effect 'obj_ai' is not available for video"
    assert speech.runs == 0
    assert not broker.queues.get("video_subtitles_queue") and not broker.queues.get("video_extract_queue")
    assert not list(tmp_path.glob(".video-work-*"))


# Invalid extraction parameters are rejected by the router: no service receives the job
def test_invalid_extraction_is_rejected_by_the_router(services, sample_video, tmp_path):
    broker, deliver = services
    visited = deliver(job(sample_video, str(tmp_path / "r.mp4"),
                          [{"procedure": "trim", "params": {"start": 0, "end": 3}},
                           {"procedure": "extract_frames", "params": {"mode": "bogus", "format": "png"}}]))
    assert visited == ["video_queue"]
    (reply,) = broker.queues["project_queue"]
    assert reply["status"] == "error" and reply["error"]["code"] == 2001
    assert reply["error"]["msg"] == "Choose count/interval and PNG/JPEG"
    assert not any(broker.queues.get(q) for q in STAGE_QUEUES)
    assert not list(tmp_path.glob(".video-work-*"))


# ---------------------------------------------------------------------------
# A stage runs once per job, even when RabbitMQ delivers it again
# ---------------------------------------------------------------------------

def plan_for(deliver, broker, message):
    """Runs only the router and returns the message it handed to the first stage."""
    consumer = deliver.consumers["video_queue"]
    consumer.callback(consumer._channel, SimpleNamespace(delivery_tag=1), None, json.dumps(message).encode())
    queue = next(q for q in STAGE_QUEUES if broker.queues.get(q))
    return queue, broker.queues[queue].pop(0)


def deliver_once(deliver, queue, message, redelivered=False):
    consumer = deliver.consumers[queue]
    consumer.callback(consumer._channel, SimpleNamespace(delivery_tag=1, redelivered=redelivered),
                      None, json.dumps(message).encode())


# The reported scenario: the edit service publishes the next stage and dies before acknowledging.
# RabbitMQ redelivers; the pipeline still replies once, with success, and captions run once.
def test_crash_between_publish_and_ack(services, sample_video, tmp_path, monkeypatch):
    from common.messaging import now
    from subtitles import captions
    speech = CountingRecognizer()
    monkeypatch.setattr(captions, "speech_model", speech)
    broker, deliver = services
    queue, first = plan_for(deliver, broker, job(sample_video, str(tmp_path / "r.mp4"),
                            [{"procedure": "brightness", "params": {"brightness": 1.1}},
                             {"procedure": "subtitles", "params": {}}]))
    assert queue == "video_edit_queue"
    edit = deliver.consumers["video_edit_queue"]
    edit.handle(json.loads(json.dumps(first)), now())        # runs and publishes, then "dies" (no ack)
    deliver_once(deliver, "video_edit_queue", first, redelivered=True)
    assert len(broker.queues["video_subtitles_queue"]) == 2  # the redelivery could not know it had published
    deliver({"messageId": "drain"}, queue="__drain__")
    replies = [r["status"] for r in broker.queues["project_queue"]]
    assert replies == ["success"]
    assert speech.runs == 1
    assert (tmp_path / "r.mp4").is_file() and not list(tmp_path.glob(".video-work-*"))


# A second copy of a stage that is running, without the redelivered flag, is dropped
def test_duplicate_without_redelivered_is_dropped(services, sample_video, tmp_path):
    from common.stage import work_dir
    broker, deliver = services
    out = str(tmp_path / "r.mp4")
    _queue, first = plan_for(deliver, broker, job(sample_video, out,
                             [{"procedure": "contrast", "params": {"contrastFactor": 1.2}},
                              {"procedure": "subtitles", "params": {}}]))
    # another delivery holds the stage
    work = work_dir(out, first["messageId"])
    work.mkdir()
    (work / "stage-0.claim").touch()
    deliver_once(deliver, "video_edit_queue", first, redelivered=False)
    assert not broker.queues.get("video_subtitles_queue")
    assert not broker.queues.get("project_queue")
    assert not (work / "stage-0.mp4").exists()
    assert broker.acked == 2  # router + the dropped copy


# A redelivered message takes over a stage whose claim was left by a service that died
def test_redelivered_message_takes_over_the_claim(services, sample_video, tmp_path):
    from common.stage import work_dir
    broker, deliver = services
    out = str(tmp_path / "r.mp4")
    _queue, first = plan_for(deliver, broker, job(sample_video, out,
                             [{"procedure": "contrast", "params": {"contrastFactor": 1.2}},
                              {"procedure": "subtitles", "params": {}}]))
    work = work_dir(out, first["messageId"])
    work.mkdir()
    (work / "stage-0.claim").touch()
    deliver_once(deliver, "video_edit_queue", first, redelivered=True)
    assert len(broker.queues["video_subtitles_queue"]) == 1
    assert (work / "stage-0.mp4").is_file()


# A later stage of a job that has already ended (work directory gone) is dropped without a reply
def test_stage_of_an_ended_job_is_dropped(services, sample_video, tmp_path):
    broker, deliver = services
    out = str(tmp_path / "r.mp4")
    _queue, first = plan_for(deliver, broker, job(sample_video, out,
                             [{"procedure": "contrast", "params": {"contrastFactor": 1.2}},
                              {"procedure": "subtitles", "params": {}}]))
    first["parameters"]["stage"] = 1
    deliver_once(deliver, "video_subtitles_queue", first, redelivered=True)
    assert not broker.queues.get("project_queue")
    assert not list(tmp_path.glob(".video-work-*"))


# The work directory still exists when the reply is published (it is removed afterwards),
# for success and for failure, so a crash in between leads to a repeated stage, not a lost reply
@pytest.mark.parametrize("tools,status", [
    ([{"procedure": "brightness", "params": {"brightness": 1.1}}], "success"),
    ([{"procedure": "trim", "params": {"start": 20, "end": 30}}], "error"),
])
def test_reply_is_sent_before_cleanup(services, sample_video, tmp_path, tools, status):
    broker, deliver = services
    out = str(tmp_path / "r.mp4")
    seen = []
    edit = deliver.consumers["video_edit_queue"]
    publish = edit.publish

    def spy(queue, msg):
        if queue == "project_queue":
            seen.append(bool(list(tmp_path.glob(".video-work-*"))))
        publish(queue, msg)

    edit.publish = spy
    deliver(job(sample_video, out, tools))
    assert broker.queues["project_queue"][0]["status"] == status
    assert seen == [True]
    assert not list(tmp_path.glob(".video-work-*"))

