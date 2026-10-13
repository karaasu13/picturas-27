const Video = require("../models/video");

module.exports.getAll = async (user_id, project_id) => {
  return await Video.find({ user_id, project_id }).sort({ createdAt: 1 }).exec();
};

module.exports.getOne = async (user_id, project_id, video_id) => {
  return await Video.findOne({ _id: video_id, user_id, project_id }).exec();
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
