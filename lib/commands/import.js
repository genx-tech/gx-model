"use strict";

require("source-map-support/register");

const {
  throwIfFileNotExist,
  importDataFiles
} = require('../utils/helpers');

module.exports = async (app, context) => {
  app.log('verbose', `${app.name} import`);
  throwIfFileNotExist("modelPath", context.modelPath);
  throwIfFileNotExist("scriptPath", context.scriptPath);
  let schemaName = app.option('schema');
  let dataset = app.option('dataset');
  let ignoreDuplicate = app.option('ignore');
  let schemaConfig = context.schemas[schemaName];

  if (!schemaConfig) {
    throw new Error(`Schema "${schemaName}" not found in geml config.`);
  }

  const db = app.db(schemaName);

  const Migrator = require(`../migration/${db.driver}`);

  const migrator = new Migrator(app, context, db);
  await importDataFiles(migrator, dataset, ignoreDuplicate);
};
//# sourceMappingURL=import.js.map