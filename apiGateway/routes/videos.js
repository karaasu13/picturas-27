// Rotas de vídeo (UC-VID-001): reencaminha para o Projects-MS.
//
// Só o dono do projeto usa os vídeos (o Projects-MS volta a verificar).
// O upload é passado em streaming: um vídeo pode ter até 2 GB e não pode
// ficar em memória no gateway, como acontece com as imagens (multer).

const express = require("express");
const router = express.Router();
const axios = require("axios");
const https = require("https");
const fs = require("fs");

const auth = require("../auth/auth");

const key = fs.readFileSync(__dirname + "/../certs/selfsigned.key");
const cert = fs.readFileSync(__dirname + "/../certs/selfsigned.crt");
const httpsAgent = new https.Agent({ rejectUnauthorized: false, cert, key });

const PROJECTS_HOST = "projects";
const PROJECTS_PORT = 9001;
const projectsURL = `https://${PROJECTS_HOST}:${PROJECTS_PORT}`;

const UNAVAILABLE = {
  code: "projects_unavailable",
  message: "O serviço de projetos não está disponível. Tenta novamente daqui a pouco.",
};

function upstreamPath(req, suffix = "") {
  const { user, project } = req.params;
  return `/${encodeURIComponent(user)}/${encodeURIComponent(project)}${suffix}`;
}

function upstreamHeaders(req) {
  return {
    Authorization: req.headers["authorization"],
    "X-Caller-Id": req.authUserId,
  };
}

function sendUpstream(res, resp) {
  if (resp.status === 204) return res.sendStatus(204);
  return res.status(resp.status).jsonp(resp.data);
}

function sendError(res, err) {
  if (err.response) return res.status(err.response.status).jsonp(err.response.data);
  console.error("[API-GW][VIDEO]", err.message);
  return res.status(502).jsonp(UNAVAILABLE);
}

// Pedido "normal" (JSON) para o Projects-MS
function proxy(method, suffix) {
  return (req, res) => {
    axios({
      method,
      url: projectsURL + upstreamPath(req, suffix(req)),
      data: method === "post" || method === "put" ? req.body : undefined,
      httpsAgent,
      headers: upstreamHeaders(req),
    })
      .then((resp) => sendUpstream(res, resp))
      .catch((err) => sendError(res, err));
  };
}

const id = (name) => (req) => encodeURIComponent(req.params[name]);

// ------------------------------------------------------------------ vídeos

router.get("/:user/:project/videos", auth.checkToken, proxy("get", () => "/videos"));

router.get(
  "/:user/:project/videos/:video",
  auth.checkToken,
  proxy("get", (req) => `/videos/${id("video")(req)}`),
);

router.delete(
  "/:user/:project/videos/:video",
  auth.checkToken,
  proxy("delete", (req) => `/videos/${id("video")(req)}`),
);

router.post(
  "/:user/:project/videos/:video/cut",
  auth.checkToken,
  proxy("post", (req) => `/videos/${id("video")(req)}/cut`),
);

// Upload em streaming: o corpo multipart segue tal como chegou
router.post("/:user/:project/videos", auth.checkToken, (req, res) => {
  const headers = {
    "content-type": req.headers["content-type"],
    authorization: req.headers["authorization"],
    "x-caller-id": req.authUserId,
  };
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];

  const upstream = https.request(
    {
      host: PROJECTS_HOST,
      port: PROJECTS_PORT,
      method: "POST",
      path: upstreamPath(req, "/videos"),
      agent: httpsAgent,
      headers,
    },
    (up) => {
      res.status(up.statusCode);
      if (up.headers["content-type"]) res.set("Content-Type", up.headers["content-type"]);
      up.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    console.error("[API-GW][VIDEO] upload:", err.message);
    if (!res.headersSent) res.status(502).jsonp(UNAVAILABLE);
  });

  // O browser desistiu do envio: não vale a pena continuar
  req.on("aborted", () => upstream.destroy());

  req.pipe(upstream);
});

// ---------------------------------------------------------------- timeline

router.get("/:user/:project/timeline", auth.checkToken, proxy("get", () => "/timeline"));
router.put("/:user/:project/timeline", auth.checkToken, proxy("put", () => "/timeline"));
router.post("/:user/:project/timeline/undo", auth.checkToken, proxy("post", () => "/timeline/undo"));
router.post("/:user/:project/timeline/redo", auth.checkToken, proxy("post", () => "/timeline/redo"));

// ----------------------------------------------------------------- tarefas

router.get("/:user/:project/video-tasks", auth.checkToken, proxy("get", () => "/video-tasks"));

router.get(
  "/:user/:project/video-tasks/:task",
  auth.checkToken,
  proxy("get", (req) => `/video-tasks/${id("task")(req)}`),
);

// Cancelar
router.delete(
  "/:user/:project/video-tasks/:task",
  auth.checkToken,
  proxy("delete", (req) => `/video-tasks/${id("task")(req)}`),
);

module.exports = router;
