const express = require("express");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const uploadFile = require("../services/uploadFile");
const allowedStages = require("../utils/stages");

const router = express.Router();

// Os ficheiros grandes (vídeos) vão para disco e não para memória
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_BYTES },
});

router.post("/:userId/:projectId/:stage", (req, res) => {
  const { userId, projectId, stage } = req.params;

  if (!allowedStages.includes(stage)) {
    return res.status(400).json({
      error: `O estágio deve ser um de: ${allowedStages.join(", ")}.`,
    });
  }

  upload.single("file")(req, res, async (err) => {
    if (err) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Nenhum ficheiro recebido." });
    }

    try {
      const result = await uploadFile(userId, projectId, req.file, stage);
      res.status(201).json({ message: "Ficheiro enviado com sucesso!", data: result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  });
});

module.exports = router;
