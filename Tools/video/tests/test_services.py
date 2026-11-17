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
