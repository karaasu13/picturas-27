const VideoTask = require("../models/videoTask");
const { ACTIVE_STATES } = require("../models/videoTask");

module.exports.getAll = async (user_id, project_id, limit = 50) => {
  return await VideoTask.find({ user_id, project_id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec();
};

module.exports.getOne = async (user_id, project_id, task_id) => {
  return await VideoTask.findOne({ _id: task_id, user_id, project_id }).exec();
};

module.exports.getById = async (task_id) => {
  return await VideoTask.findById(task_id).exec();
};

module.exports.create = async (task) => {
  return await VideoTask.create(task);
};

module.exports.setMsgId = async (task_id, msg_id) => {
  return await VideoTask.updateOne({ _id: task_id }, { $set: { msg_id } }).exec();
};

/**
 * Muda o estado só se a tarefa estiver num dos estados `from`.
 * É atómico, por isso um cancelamento e o fim do worker nunca se "pisam":
 * só uma das transições ganha (e só essa devolve a quota, por exemplo).
 * Devolve a tarefa atualizada, ou null se a transição não se aplicou.
 */
module.exports.transition = async (task_id, from, update, extraFilter = {}) => {
  return await VideoTask.findOneAndUpdate(
    { _id: task_id, state: { $in: from }, ...extraFilter },
    { $set: update },
    { new: true },
  ).exec();
};

module.exports.countActiveForVideo = async (video_id) => {
  return await VideoTask.countDocuments({ video_id, state: { $in: ACTIVE_STATES } }).exec();
};

// "Em Fila" mas nunca enviadas ao worker, criadas antes de `before`
module.exports.getUnsent = async (before) => {
  return await VideoTask.find({ state: "queued", msg_id: null, createdAt: { $lt: before } }).exec();
};

module.exports.getActiveForProject =async (user_id, project_id) => {
  return await VideoTask.find({ user_id, project_id, state: { $in: ACTIVE_STATES } }).exec();
};

module.exports.deleteAllFromProject = async (user_id, project_id) => {
  return await VideoTask.deleteMany({ user_id, project_id }).exec();
};
