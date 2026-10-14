const Video = require("../models/video");

module.exports.getAll = async (user_id, project_id) => {
  return await Video.find({ user_id, project_id }).sort({ createdAt: 1 }).exec();
};

module.exports.getOne = async (user_id, project_id, video_id) => {
  return await Video.findOne({ _id: video_id, user_id, project_id }).exec();
};

module.exports.getById = async (video_id) => {
  return await Video.findById(video_id).exec();
};

/** Atualiza só os campos indicados de `preview`. Devolve o vídeo atualizado (ou null). */
module.exports.updatePreview = async (video_id, fields) => {
  const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`preview.${k}`, v]));
  return await Video.findOneAndUpdate({ _id: video_id }, { $set: set }, { new: true }).exec();
};

module.exports.getPendingPreviews = async () => {
  return await Video.find({ "preview.state": "pending" }).exec();
};

module.exports.existsByName = async (user_id, project_id, name) => {
  return !!(await Video.exists({ user_id, project_id, name }));
};

module.exports.create = async (video) => {
  return await Video.create(video);
};

module.exports.delete = async (user_id, project_id, video_id) => {
  return await Video.deleteOne({ _id: video_id, user_id, project_id }).exec();
};

module.exports.deleteAllFromProject = async (user_id, project_id) => {
  return await Video.deleteMany({ user_id, project_id }).exec();
};
