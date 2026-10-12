const axios = require("axios");

const fs = require("fs");

const key = fs.readFileSync(__dirname + "/../certs/selfsigned.key");
const cert = fs.readFileSync(__dirname + "/../certs/selfsigned.crt");

const https = require("https");
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // (NOTE: this will disable client verification)
  cert: cert,
  key: key,
});

const FormData = require("form-data");

const img_storage_ms = "http://img_storage:11000";

async function get_image_internal_url(user, project, type, img) {
  return await axios.get(
    `${img_storage_ms}/image/internal/${user}/${project}/${type}/${img}` /* , { httpsAgent: httpsAgent } */,
  );
}

async function get_image_public_url(user, project, type, img) {
  return await axios.get(
    `${img_storage_ms}/image/public/${user}/${project}/${type}/${img}` /* , { httpsAgent: httpsAgent } */,
  );
}

async function post_image(user, project, type, file) {
  return await axios.post(
    `${img_storage_ms}/upload/${user}/${project}/${type}`,
    file /* , { httpsAgent: httpsAgent } */,
  );
}

async function delete_image(user, project, type, img) {
  return await axios.delete(
    `${img_storage_ms}/delete/${user}/${project}/${type}/${img}` /* , { httpsAgent: httpsAgent } */,
  );
}

async function copy_image(userId, projectId, fromStage, toStage, fileName) {
  // usa o mesmo serviço interno (docker network) tal como as outras
  return axios.post(
    `${img_storage_ms}/copy/${userId}/${projectId}/${fromStage}/${toStage}/${fileName}`,
    {}
  );
}

// Envia um ficheiro em disco em streaming (vídeos até 2 GB, sem os ter em memória)
async function post_file(user, project, type, filePath, fileName, contentType) {
  const data = new FormData();
  data.append("file", fs.createReadStream(filePath), {
    filename: fileName,
    contentType: contentType,
  });

  return await axios.post(`${img_storage_ms}/upload-file/${user}/${project}/${type}`, data, {
    headers: data.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

module.exports = { get_image_internal_url, get_image_public_url, post_image, delete_image, copy_image, post_file };