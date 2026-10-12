const fs = require("fs");
const path = require("path");
const s3 = require("./s3Client");
const createBucket = require("./createBucket");
const { v4: uuidv4 } = require("uuid");

// Envia um ficheiro que já está em disco, em streaming. Usado para os vídeos
// (até 2 GB), que não podem ser carregados inteiros em memória como as imagens.
async function uploadFile(userId, projectId, file, stage) {
  const bucketName = `user-${userId}`;
  await createBucket(bucketName);

  const ext = path.extname(file.originalname || "").toLowerCase();
  const fileKey = `${projectId}/${stage}/${uuidv4()}${ext}`;

  const params = {
    Bucket: bucketName,
    Key: fileKey,
    Body: fs.createReadStream(file.path),
    ContentType: file.mimetype || "application/octet-stream",
  };

  // Upload em partes de 16 MB para ficheiros grandes
  const data = await s3
    .upload(params, { partSize: 16 * 1024 * 1024, queueSize: 4 })
    .promise();

  return { imageKey: fileKey, location: data.Location };
}

module.exports = uploadFile;
