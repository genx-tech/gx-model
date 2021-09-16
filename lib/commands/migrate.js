"use strict";

require("source-map-support/register");

const {
  _,
  eachAsync_
} = require('@genx/july');

const {
  throwIfFileNotExist,
  getSchemaConnectors,
  importDataFiles
} = require('../utils/helpers');

module.exports = async (app, context) => {
  app.log('verbose', `${app.name} migrate`);
  throwIfFileNotExist("modelPath", context.modelPath);
  throwIfFileNotExist("scriptPath", context.scriptPath);
  let reset = app.option('reset');

  if (reset) {
    await eachAsync_(Object.keys(context.schemas).reverse(), async schemaName => {
      const db = app.db(schemaName);

      const Migrator = require(`../migration/${db.driver}`);

      const migrator = new Migrator(app, context, db);
      await migrator.reset_();
    });
  }

  return eachAsync_(context.schemas, async (schemaConfig, schemaName) => {
    const db = app.db(schemaName);

    const Migrator = require(`../migration/${db.driver}`);

    const migrator = new Migrator(app, context, db);
    await migrator.create_(schemaConfig.extraOptions);
    await importDataFiles(migrator, '_init');
  });
};
//# sourceMappingURL=migrate.js.map