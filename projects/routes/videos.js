// Vídeos do projeto e tarefas de corte (UC-VID-001 - Eliminar segmento intermédio).
//
// As tarefas de vídeo têm um fluxo próprio, fora do pipeline de ferramentas
// das imagens: cada pedido de corte é uma tarefa assíncrona com estado
// (Em Fila, A processar, Concluído, Falhou, Cancelado), processada pelo
// worker `video_cut` através do RabbitMQ.
//
// Nesta fase só o dono do projeto pode usar os vídeos (REQ-VID-CUT-026),
// mesmo que o projeto esteja partilhado.

const express = require("express");
const router = express.Router();
const axios = require("axios");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const path = require("path");
const mongoose = require("mongoose");
const multer = require("multer");
const { pipeline } = require("stream/promises");
const { v4: uuidv4 } = require("uuid");

const Project = require("../controllers/project");
const Video = require("../controllers/video");
const VideoTask = require("../controllers/videoTask");
const { ACTIVE_STATES } = require("../models/videoTask");
const { getCallerId } = require("../utils/caller");
const {
  get_image_internal_url,
  get_image_public_url,
  delete_image,
  post_file,
} = require("../utils/imageStorage");
const V = require("../utils/video");
const { validateVideoConversion } = require("../dto/videoConversion");
const {
  send_video_cut,
  read_video_results,
  send_video_task_update,
} = require("../utils/video_msg");

const key = fs.readFileSync(__dirname + "/../certs/selfsigned.key");
const cert = fs.readFileSync(__dirname + "/../certs/selfsigned.crt");
const httpsAgent = new https.Agent({ rejectUnauthorized: false, cert, key });

const users_ms = "https://users:10001/";

const STORAGE_STAGE = "video";

// Pasta no volume partilhado com o worker (montado em /app/images)
const APP_ROOT = path.join(__dirname, "..");
const VIDEOS_REL = "./images/videos";
const UPLOAD_TMP = path.join(APP_ROOT, VIDEOS_REL, "tmp");

const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: V.LIMITS.maxUploadBytes, files: 1 },
});

fs.mkdirSync(UPLOAD_TMP, { recursive: true });

// ----------------------------------------------------------------- helpers

function abs(relPath) {
  return path.join(APP_ROOT, relPath);
}

function taskPaths(taskId, format) {
  const dir = `${VIDEOS_REL}/tasks/${taskId}`;
  return {
    dir,
    input: `${dir}/input.${format}`,
    output: `${dir}/output.${format}`,
    cancelFlag: `${dir}/cancel`,
  };
}

async function removeDir(relDir) {
  await fsp.rm(abs(relDir), { recursive: true, force: true }).catch(() => {});
}

function fail(res, status, code, message) {
  return res.status(status).jsonp({ code, message });
}

// O Express 4 não apanha erros de funções async: sem isto o pedido ficava pendurado
function wrap(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error("[VIDEO] route error:", err);
      if (!res.headersSent) fail(res, 500, "internal_error", "Ocorreu um erro inesperado. Tenta novamente.");
    });
}

function keyFromStorage(resp) {
  return path.basename(resp.data.data.imageKey);
}

// O multer 1.x lê o nome do ficheiro como latin1
function decodeFileName(name) {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch (_) {
    return name;
  }
}

async function publicUrl(video) {
  try {
    const resp = await get_image_public_url(
      video.user_id,
      video.project_id,
      STORAGE_STAGE,
      video.storage_key,
    );
    return resp.data.url;
  } catch (_) {
    return null;
  }
}

async function getUserType(userId) {
  const resp = await axios.get(users_ms + `${userId}/type/`, { httpsAgent });
  return resp.data?.type;
}

async function refund(task) {
  if (!task.charged_ops) return;
  try {
    await axios.post(
      users_ms + `${task.user_id}/process/refund/${task.charged_ops}`,
      {},
      { httpsAgent },
    );
  } catch (err) {
    console.error(`[VIDEO] refund failed task=${task._id}:`, err.message);
  }
}

// Mensagens para o utilizador por código de erro do worker (padrão do T-02:
// causa + o que fazer)
function userMessage(code, fallback) {
  switch (code) {
    case "av_sync":
      return "Foi detetada uma falha de sincronismo entre o áudio e o vídeo na junção. O vídeo original não foi alterado e a operação não foi contabilizada. Experimenta pontos de corte ligeiramente diferentes.";
    case "timeout":
      return "O processamento excedeu o tempo máximo de 15 minutos. O vídeo original não foi alterado e a operação não foi contabilizada. Tenta novamente mais tarde.";
    case "invalid_input":
    case "invalid_output":
      return "Não foi possível processar este vídeo. Confirma que o ficheiro não está corrompido e tenta novamente. A operação não foi contabilizada.";
    case "storage_error":
      return fallback || "Não foi possível guardar o resultado. A operação não foi contabilizada. Tenta novamente.";
    default:
      return "Ocorreu um erro inesperado ao processar o vídeo. A operação não foi contabilizada. Tenta novamente.";
  }
}

/** Marca a tarefa como "Falhou", devolve a quota e regista no log. */
async function failTask(taskId, code, reason) {
  const task = await VideoTask.transition(taskId, ACTIVE_STATES, {
    state: "failed",
    error_code: code || "unexpected",
    error_msg: userMessage(code, reason),
    finished_at: new Date(),
  });
  if (!task) return null;

  await refund(task);

  // REQ-VID-CUT-029: ID da tarefa, utilizador, data/hora e motivo
  console.error(
    JSON.stringify({
      event: "video-task-failed",
      taskId: String(task._id),
      userId: String(task.user_id),
      projectId: String(task.project_id),
      timestamp: new Date().toISOString(),
      code: task.error_code,
      reason: reason || null,
    }),
  );

  send_video_task_update(task);
  return task;
}

// ---------------------------------------------------------------- middleware

// Só o dono, sem links de partilha (REQ-VID-CUT-026)
function requireVideoOwner(req, res, next) {
  const caller = getCallerId(req);
  if (!caller) return fail(res, 401, "unauthenticated", "Tens de iniciar sessão.");

  if (req.query.share || String(caller) !== String(req.params.user)) {
    return fail(res, 403, "forbidden", "Só o dono do projeto pode usar as ferramentas de vídeo.");
  }

  for (const p of ["user", "project", "video", "task"]) {
    if (req.params[p] !== undefined && !mongoose.isValidObjectId(req.params[p])) {
      return fail(res, 404, "not_found", "Recurso não encontrado.");
    }
  }
  next();
}

async function loadProject(req, res, next) {
  try {
    const project = await Project.getOne(req.params.user, req.params.project);
    if (!project) return fail(res, 404, "not_found", "Projeto não encontrado.");
    req.project = project;
    next();
  } catch (_) {
    return fail(res, 404, "not_found", "Projeto não encontrado.");
  }
}

// O anónimo não tem acesso às ferramentas de vídeo
async function loadUserType(req, res, next) {
  try {
    req.userType = await getUserType(req.params.user);
  } catch (err) {
    console.error("[VIDEO] users-ms /type failed:", err.message);
    return fail(res, 503, "users_unavailable", "Não foi possível validar a tua conta. Tenta novamente.");
  }
  if (req.userType === "anonymous") return fail(res, 403, "anonymous", V.MESSAGES.anonymous);
  next();
}

const guard = [requireVideoOwner, loadProject];

// -------------------------------------------------------------------- vídeos

// Listar os vídeos do projeto
router.get("/:user/:project/videos", guard, wrap(async (req, res) => {
  const videos = await Video.getAll(req.params.user, req.params.project);
  const out = await Promise.all(videos.map(async (v) => V.serializeVideo(v, await publicUrl(v))));
  res.status(200).jsonp(out);
}));

// Um vídeo (com URL nova, por exemplo para descarregar)
router.get("/:user/:project/videos/:video", guard, wrap(async (req, res) => {
  const video = await Video.getOne(req.params.user, req.params.project, req.params.video);
  if (!video) return fail(res, 404, "not_found", "Vídeo não encontrado.");
  res.status(200).jsonp(V.serializeVideo(video, await publicUrl(video)));
}));

// Enviar um vídeo (REQ-VID-PLAT-001: MP4/MOV/AVI, H.264/H.265, até 2 GB)
router.post("/:user/:project/videos", guard, loadUserType, (req, res) => {
  upload.single("video")(req, res, async (err) => {
    const tmpPath = req.file?.path;
    const cleanup = () => tmpPath && fsp.rm(tmpPath, { force: true }).catch(() => {});

    if (err) {
      cleanup();
      if (err.code === "LIMIT_FILE_SIZE") return fail(res, 413, "too_large", V.MESSAGES.too_large);
      return fail(res, 400, "bad_upload", "O envio do vídeo falhou. Tenta novamente.");
    }

    if (!req.file) return fail(res, 400, "no_file", "Nenhum vídeo recebido.");

    try {
      const name = decodeFileName(req.file.originalname);

      if (await Video.existsByName(req.params.user, req.params.project, name)) {
        return fail(res, 409, "duplicate_name", "Este projeto já tem um vídeo com esse nome. Muda o nome do ficheiro e tenta novamente.");
      }

      let probe;
      try {
        probe = await V.ffprobe(tmpPath);
      } catch (_) {
        return fail(res, 415, "unsupported_format", V.MESSAGES.unsupported_format);
      }

      const check = V.validateProbe(probe, name);
      if (!check.ok) {
        const status = check.code === "unsupported_format" ? 415 : 422;
        return fail(res, status, check.code, check.message);
      }

      const stored = await post_file(
        req.params.user,
        req.params.project,
        STORAGE_STAGE,
        tmpPath,
        name,
        V.MIME_TYPES[check.meta.format],
      );

      const video = await Video.create({
        user_id: req.params.user,
        project_id: req.params.project,
        name,
        storage_key: keyFromStorage(stored),
        size: req.file.size,
        source: "upload",
        ...check.meta,
      });

      console.log(`[VIDEO] upload user=${req.params.user} project=${req.params.project} video=${video._id} ${check.meta.format} ${check.meta.duration}s`);

      return res.status(201).jsonp(V.serializeVideo(video, await publicUrl(video)));
    } catch (e) {
      console.error("[VIDEO] upload error:", e.message);
      return fail(res, 500, "storage_error", "Não foi possível guardar o vídeo. Tenta novamente.");
    } finally {
      cleanup();
    }
  });
});

// Remover um vídeo do projeto
router.delete("/:user/:project/videos/:video", guard, wrap(async (req, res) => {
  const video = await Video.getOne(req.params.user, req.params.project, req.params.video);
  if (!video) return fail(res, 404, "not_found", "Vídeo não encontrado.");

  if ((await VideoTask.countActiveForVideo(video._id)) > 0) {
    return fail(res, 409, "video_busy", "Este vídeo tem uma tarefa em curso. Cancela-a ou espera que termine.");
  }

  await delete_image(video.user_id, video.project_id, STORAGE_STAGE, video.storage_key).catch((e) =>
    console.error("[VIDEO] storage delete failed:", e.message),
  );
  await Video.delete(req.params.user, req.params.project, video._id);
  res.sendStatus(204);
}));

// Validar uma conversão e calcular a estimativa, sem criar tarefa nem
// comunicar com o worker. O processamento será ligado numa fase posterior.
router.post("/:user/:project/videos/:video/convert", guard, wrap(async (req, res) => {
  const video = await Video.getOne(req.params.user, req.params.project, req.params.video);
  if (!video) return fail(res, 404, "not_found", "Vídeo não encontrado.");

  const check = validateVideoConversion(req.body, video);
  if (!check.ok) return fail(res, check.status, check.code, check.message);

  return res.status(200).jsonp({
    videoId: video._id,
    original: {
      format: video.format,
      width: video.width,
      height: video.height,
      sizeBytes: video.size,
    },
    conversion: check.value,
  });
}));

// ------------------------------------------------------------------- tarefas

// Prepara o ficheiro no volume partilhado e envia o pedido ao worker.
// Corre depois de responder ao cliente, para o pedido não ficar à espera
// da cópia de um ficheiro grande.
async function prepareAndQueue(task, video) {
  const paths = taskPaths(task._id, video.format);

  try {
    await fsp.mkdir(abs(paths.dir), { recursive: true });

    const urlResp = await get_image_internal_url(
      video.user_id,
      video.project_id,
      STORAGE_STAGE,
      video.storage_key,
    );
    const file = await axios.get(urlResp.data.url, { responseType: "stream" });
    await pipeline(file.data, fs.createWriteStream(abs(paths.input)));

    // Pode ter sido cancelada enquanto o ficheiro era copiado
    const fresh = await VideoTask.getById(task._id);
    if (!fresh || fresh.state !== "queued") {
      await removeDir(paths.dir);
      return;
    }

    // msg_id só é gravado depois do envio: no arranque, "queued" sem msg_id
    // quer dizer que o pedido nunca chegou ao worker
    const msg_id = `video-cut-${uuidv4()}`;
    await send_video_cut(msg_id, fresh, paths);
    await VideoTask.setMsgId(task._id, msg_id);
  } catch (err) {
    await removeDir(paths.dir);
    await failTask(
      task._id,
      "storage_error",
      `Não foi possível preparar o vídeo para processamento (${err.message}). A operação não foi contabilizada. Tenta novamente.`,
    );
  }
}

// Pedir o corte: elimina [start, end] (segundos) e junta as partes
router.post("/:user/:project/videos/:video/cut", guard, loadUserType, wrap(async (req, res) => {
  const video = await Video.getOne(req.params.user, req.params.project, req.params.video);
  if (!video) return fail(res, 404, "not_found", "Vídeo não encontrado.");

  const check = V.validateCut({
    start: req.body?.start,
    end: req.body?.end,
    duration: video.duration,
    userType: req.userType,
  });
  if (!check.ok) return fail(res, check.status, check.code, check.message);

  // Reserva 1 operação da quota diária (Premium não tem limite). É devolvida
  // se a tarefa falhar ou for cancelada (mecanismo já existente no users-ms).
  let charged = 0;
  if (req.userType !== "premium") {
    try {
      await axios.get(users_ms + `${req.params.user}/process/1`, { httpsAgent });
      charged = 1;
    } catch (err) {
      if (err.response?.data === "No more daily_operations available") {
        return fail(res, 429, "quota_exceeded", V.MESSAGES.quota_exceeded);
      }
      console.error("[VIDEO] users-ms /process failed:", err.message);
      return fail(res, 503, "users_unavailable", "Não foi possível validar a tua quota. Tenta novamente.");
    }
  }

  let task;
  try {
    task = await VideoTask.create({
      user_id: req.params.user,
      project_id: req.params.project,
      video_id: video._id,
      video_name: video.name,
      op: "cut",
      params: { start: check.start, end: check.end },
      state: "queued",
      // Premium primeiro na fila (REQ-VID-CUT-009)
      priority: req.userType === "premium" ? 5 : 1,
      charged_ops: charged,
    });
  } catch (err) {
    await refund({ _id: "-", user_id: req.params.user, charged_ops: charged });
    console.error("[VIDEO] could not create task:", err.message);
    return fail(res, 500, "task_error", "Não foi possível criar a tarefa. A operação não foi contabilizada. Tenta novamente.");
  }

  send_video_task_update(task);
  res.status(201).jsonp(V.serializeTask(task));

  prepareAndQueue(task, video);
}));

// Tarefas de vídeo do projeto (mais recentes primeiro)
router.get("/:user/:project/video-tasks", guard, wrap(async (req, res) => {
  const tasks = await VideoTask.getAll(req.params.user, req.params.project);
  res.status(200).jsonp(tasks.map(V.serializeTask));
}));

router.get("/:user/:project/video-tasks/:task", guard, wrap(async (req, res) => {
  const task = await VideoTask.getOne(req.params.user, req.params.project, req.params.task);
  if (!task) return fail(res, 404, "not_found", "Tarefa não encontrada.");
  res.status(200).jsonp(V.serializeTask(task));
}));

// Cancelar uma tarefa "Em Fila" ou "A processar" (REQ-VID-CUT-017)
router.delete("/:user/:project/video-tasks/:task", guard, wrap(async (req, res) => {
  const task = await VideoTask.transition(
    req.params.task,
    ACTIVE_STATES,
    { state: "cancelled", finished_at: new Date() },
    { user_id: req.params.user, project_id: req.params.project },
  );

  if (!task) {
    const existing = await VideoTask.getOne(req.params.user, req.params.project, req.params.task);
    if (!existing) return fail(res, 404, "not_found", "Tarefa não encontrada.");
    return fail(res, 409, "task_finished", "Esta tarefa já terminou e não pode ser cancelada.");
  }

  // Sinal para o worker: se ainda está na fila é descartada quando chegar a
  // vez dela; se está a ser processada, o ffmpeg é interrompido e os
  // ficheiros temporários são apagados.
  await cancelTask(task);
  send_video_task_update(task);
  res.status(200).jsonp(V.serializeTask(task));
}));

// ------------------------------------------------- mensagens do worker

async function completeTask(taskId, outputRel) {
  const task = await VideoTask.getById(taskId);
  if (!task || !ACTIVE_STATES.includes(task.state)) return;

  const source = await Video.getOne(task.user_id, task.project_id, task.video_id);
  const format = source?.format || V.extOf(outputRel);
  const outAbs = abs(outputRel);

  const probe = await V.ffprobe(outAbs).catch(() => null);
  const check = probe ? V.validateProbe(probe, `output.${format}`) : { ok: false };
  if (!check.ok) {
    await failTask(taskId, "invalid_output", "O worker produziu um ficheiro inválido");
    return;
  }

  const existing = (await Video.getAll(task.user_id, task.project_id)).map((v) => v.name);
  const name = V.cutResultName(source?.name || task.video_name, existing);
  const { size } = await fsp.stat(outAbs);

  const stored = await post_file(task.user_id, task.project_id, STORAGE_STAGE, outAbs, name, V.MIME_TYPES[format]);
  const storageKey = keyFromStorage(stored);

  // Novo vídeo no projeto; o original fica intacto (REQ-VID-CUT-014)
  const video = await Video.create({
    user_id: task.user_id,
    project_id: task.project_id,
    name,
    storage_key: storageKey,
    size,
    source: "cut",
    parent_video_id: task.video_id,
    task_id: task._id,
    ...check.meta,
  });

  const done = await VideoTask.transition(taskId, ACTIVE_STATES, {
    state: "done",
    output_video_id: video._id,
    finished_at: new Date(),
  });

  if (!done) {
    // Cancelada enquanto guardávamos: o resultado não é entregue
    await delete_image(task.user_id, task.project_id, STORAGE_STAGE, storageKey).catch(() => {});
    await Video.delete(task.user_id, task.project_id, video._id);
    return;
  }

  console.log(`[VIDEO] task done task=${taskId} video=${video._id}`);
  send_video_task_update(done);
}

async function handleWorkerMessage(msg) {
  const taskId = msg?.taskId;
  if (!taskId || !mongoose.isValidObjectId(taskId)) return;

  const task = await VideoTask.getById(taskId);
  if (!task) {
    // A tarefa já não existe (o projeto foi apagado entretanto): só falta
    // apagar os ficheiros temporários que o worker deixou
    await removeDir(taskPaths(taskId, "mp4").dir);
    return;
  }
  const paths = taskPaths(task._id, V.extOf(msg?.output?.videoURI || "") || "mp4");

  switch (msg.status) {
    case "processing": {
      const updated = await VideoTask.transition(taskId, ["queued"], {
        state: "processing",
        started_at: new Date(),
      });
      if (updated) send_video_task_update(updated);
      return;
    }

    case "success":
      try {
        await completeTask(taskId, msg.output?.videoURI);
      } catch (err) {
        await failTask(taskId, "storage_error", `Não foi possível guardar o resultado (${err.message}).`);
      } finally {
        await removeDir(paths.dir);
      }
      return;

    case "error":
      await failTask(taskId, msg.error?.code, msg.error?.msg);
      await removeDir(paths.dir);
      return;

    case "cancelled":
      // Normalmente a tarefa já está "Cancelado". Se ainda estiver ativa é
      // porque o ficheiro de entrada desapareceu: conta como falha.
      await failTask(taskId, "invalid_input", "O worker não encontrou o vídeo de entrada");
      await removeDir(paths.dir);
      return;

    default:
      console.error("[VIDEO] unknown worker status:", msg.status);
  }
}

// Tarefas que ficaram a meio do prepareAndQueue quando o serviço parou: nunca
// vão chegar ao worker, por isso falham (e a quota é devolvida) em vez de
// ficarem "Em Fila" para sempre
async function failUnsentTasks(bootTime) {
  for (const t of await VideoTask.getUnsent(bootTime)) {
    await removeDir(taskPaths(t._id, "mp4").dir);
    await failTask(t._id, "unexpected", "O serviço reiniciou antes de enviar a tarefa ao worker");
  }
}

function start_video_consumer() {
  failUnsentTasks(new Date()).catch((err) =>
    console.error("[VIDEO] could not fail unsent tasks:", err.message),
  );
  read_video_results(handleWorkerMessage);
}

// Pede ao worker para parar e devolve a quota (cancelamento pelo utilizador
// ou porque o projeto foi apagado)
async function cancelTask(task) {
  try {
    const video = await Video.getOne(task.user_id, task.project_id, task.video_id);
    const paths = taskPaths(task._id, video?.format || "mp4");
    await fsp.mkdir(abs(paths.dir), { recursive: true });
    await fsp.writeFile(abs(paths.cancelFlag), new Date().toISOString());
  } catch (err) {
    console.error(`[VIDEO] could not write cancel flag task=${task._id}:`, err.message);
  }
  await refund(task);
}

// Usado quando um projeto (ou a conta) é apagado
async function deleteProjectVideos(userId, projectId) {
  // cortes ainda em curso: cancelar (o worker para e a quota é devolvida)
  for (const t of await VideoTask.getActiveForProject(userId, projectId)) {
    const cancelled = await VideoTask.transition(t._id, ACTIVE_STATES, {
      state: "cancelled",
      finished_at: new Date(),
    });
    if (cancelled) await cancelTask(cancelled);
  }

  const videos = await Video.getAll(userId, projectId);
  for (const v of videos) {
    await delete_image(userId, projectId, STORAGE_STAGE, v.storage_key).catch(() => {});
  }
  await Video.deleteAllFromProject(userId, projectId);
  await VideoTask.deleteAllFromProject(userId, projectId);
}

module.exports = { router, start_video_consumer, deleteProjectVideos };
