# Video services

One container per kind of work, each consuming its own queue of the `picturas` exchange.

| Folder            | Compose service        | Queue                   | Work                                   |
| ----------------- | ---------------------- | ----------------------- | -------------------------------------- |
| `router/`         | `video_router`         | `video_queue`           | Splits a pipeline into stages          |
| `edit/`           | `video_edit_tool`      | `video_edit_queue`      | Trim, speed and frame effects          |
| `subtitles/`      | `video_subtitles_tool` | `video_subtitles_queue` | Speech recognition, burned-in captions |
| `extract_frames/` | `video_extract_tool`   | `video_extract_queue`   | Still frames and preview contact sheet |
| `common/`         | (shared code)          |                         | Plan, stage runner, RabbitMQ worker    |

## How a job travels

1. `projects` publishes one message per video, with the whole pipeline, to `video_queue`.
2. `router` plans the stages (`common/plan.py`) and stores them in the message
   (`parameters.stages`, `parameters.stage`). A stage is a contiguous part of the pipeline for
   one service; contiguous ordinary effects stay in one edit stage (one decode/encode pass).
3. Each service runs its stage (`common/stage.py`) and publishes the message to the queue of
   the next stage. Intermediate files live in `.video-work-<messageId>/` next to the output.
4. The service of the last stage moves the result to the output path and replies to
   `projects` on `project_queue`. Any failure replies with its error code and removes the
   work directory.

The messages to `projects` (`project_queue`) and to the WebSocket gateway (`ws_queue`) keep the
format of the previous single worker, so nothing changes outside this folder.

## Changing things

- **New frame effect**: add `edit/effects/<procedure>.py` with `apply(img, **params)`. No other
  file of the video services changes.
- **New kind of video work**: add a folder with its handler, worker and Dockerfile, a queue in
  `rabbitMQ/definitions.json`, a service in `docker-compose.yaml`, and its stage in
  `common/plan.py`.
- **Scaling**: `VIDEO_EDIT_REPLICAS`, `VIDEO_SUBTITLES_REPLICAS`, `VIDEO_EXTRACT_REPLICAS` in
  `.env`. Replicas of a service share its queue; each replica takes one job at a time.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # once
.venv/bin/python -m pytest -q tests
```

They need `ffmpeg`/`ffprobe` on the `PATH`. Speech recognition and RabbitMQ are simulated.
`tests/local_pipeline.py` runs a whole pipeline in-process with the same plan and stage runner
as the services; `tests/test_services.py` sends jobs through the router and the stage services
with an in-memory broker.

## AI assistance

The split of the single `video_tool` into these services (Phase 2 refactoring) was written with
an AI coding agent (Claude) and reviewed by the team. The behaviour was checked against the
previous worker with the automated tests of this folder and with an output comparison on the
same inputs.
