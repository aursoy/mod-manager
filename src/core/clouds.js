'use strict';
// Cloud hats (cloudhat_*.ytd): see texsource.js, which finds and edits them.
const { listSources, openSource, cloudName, KINDS } = require('./texsource');

module.exports = {
  listCloudSources: (ctx) => listSources('clouds', ctx),
  openCloudSource: (id, ctx) => openSource('clouds', id, ctx),
  cloudName,
  IS_CLOUD: KINDS.clouds.test,
};
