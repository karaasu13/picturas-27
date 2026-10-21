const Timeline = require("../models/timeline");
const { HISTORY_LIMIT } = require("../models/timeline");

/** Timeline do projeto; é criada (vazia) na primeira leitura. */
module.exports.get = async (user_id, project_id) => {
  try {
    return await Timeline.findOneAndUpdate(
      { user_id, project_id },
      { $setOnInsert: { user_id, project_id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
      .lean()
      .exec();
  } catch (err) {
    // Dois pedidos a criar a mesma timeline ao mesmo tempo: o outro ganhou
    if (err.code === 11000) return await Timeline.findOne({ user_id, project_id }).lean().exec();
    throw err;
  }
};

/**
 * Grava { output, faixas } só se a versão for a esperada. O estado anterior
 * vai para o histórico de desfazer e o de refazer é limpo.
 * Devolve a timeline atualizada, ou null se houve conflito de versão.
 */
module.exports.saveIfVersion = async (current, next) => {
  return await Timeline.findOneAndUpdate(
    { _id: current._id, version: current.version },
    {
      $set: { output: next.output, faixas: next.faixas, redo: [] },
      $push: { undo: { $each: [snapshot(current)], $slice: -HISTORY_LIMIT } },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true },
  )
    .lean()
    .exec();
};

/**
 * Desfazer (from = "undo", to = "redo") ou refazer (ao contrário): repõe o
 * último estado de `from` e guarda o atual em `to`. Null se houve conflito.
 */
module.exports.step = async (current, from, to) => {
  const target = current[from][current[from].length - 1];
  return await Timeline.findOneAndUpdate(
    { _id: current._id, version: current.version },
    {
      $set: { output: target.output, faixas: target.faixas },
      $pop: { [from]: 1 },
      $push: { [to]: { $each: [snapshot(current)], $slice: -HISTORY_LIMIT } },
      $inc: { version: 1 },
    },
    { new: true },
  )
    .lean()
    .exec();
};

module.exports.usesVideo = async (user_id, project_id, video_id) => {
  return !!(await Timeline.exists({ user_id, project_id, "faixas.clips.video_id": video_id }));
};

// O histórico não pode repor clips de um vídeo que já não existe
module.exports.forgetVideo = async (user_id, project_id, video_id) => {
  return await Timeline.updateOne(
    {
      user_id,
      project_id,
      $or: [{ "undo.faixas.clips.video_id": video_id }, { "redo.faixas.clips.video_id": video_id }],
    },
    { $set: { undo: [], redo: [] } },
  ).exec();
};

module.exports.deleteForProject = async (user_id, project_id) => {
  return await Timeline.deleteOne({ user_id, project_id }).exec();
};

function snapshot(t) {
  return { output: t.output, faixas: t.faixas };
}
