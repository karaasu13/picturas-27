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
   `projects` on `project_queue`. Any failure replies with its error code. The work
   directory is removed only after the reply has been published.

## Early validation

An invalid pipeline is rejected before any expensive stage runs, as the single worker did:

- `router` rejects a frame extraction that is not unique and last, or that has invalid
  parameters (`common/extraction_params.py`), and replies at once; no service receives the job.
- The first edit stage checks every frame effect of the whole plan before doing any work. Every
  pipeline with frame effects starts with an edit stage, so an unknown effect is rejected before
  speech recognition or extraction run. The list of effects is the `edit/effects` package itself:
  the router does not need to know it, and a new effect only needs a new edit image.

## Redelivered and duplicated messages

A service acknowledges its message after handing the job to the next queue. If it dies in
between, RabbitMQ redelivers the message and the next stage receives two copies. `common/stage.py`
makes each stage run once per job:

- a later stage whose input file (`stage-<n-1>.mp4`) is gone belongs to a job that has already
  replied and cleaned up: it is acknowledged and dropped, without a reply;
- before running, a stage creates `stage-<n>.claim` with `O_CREAT | O_EXCL` in the work directory,
  on the shared volume, so every replica sees it. If the claim exists, a message with the
  `redelivered` flag takes the stage over (RabbitMQ only redelivers once the previous owner's
  channel is closed); any other copy is a duplicate and is dropped.

Known limitations, both needing a second failure in a short window:

- if a duplicate copy is delivered to a replica that also dies, its redelivery takes over the
  claim and may run alongside the original;
- if the router dies after publishing the first stage, its redelivery publishes the job again; a
  copy that arrives after the job has finished (claims already removed) runs the pipeline again.
  The orchestrator ignores the second reply; the cost is repeated work.

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
