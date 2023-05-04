"use strict";

require("source-map-support/register");

const path = require('path');

const {
  fs
} = require("@genx/sys");

const {
  _,
  eachAsync_
} = require('@genx/july');

const {
  throwIfFileNotExist,
  getSchemaConnectors
} = require('../utils/helpers');

const Linker = require('../lang/Linker');

module.exports = async (app, context) => {
  app.log('verbose', `${app.name} build`);
  throwIfFileNotExist("gemlPath", context.gemlPath);
  const schemaObjects = Linker.buildSchemaObjects(app, context);

  if (_.isEmpty(context.schemas)) {
    throw new Error(`Missing schema data source setting. Please run "${app.name} connect" to configure data source first.`);
  }

  let schemaToConnector = getSchemaConnectors(app, context.schemas);
  return eachAsync_(context.schemas, async (deploymentSetting, schemaName) => {
    app.log('verbose', `Processing schema "${schemaName}" ...`);
    let schema = schemaObjects[schemaName];

    if (!schema) {
      throw new Error(`Schema "${schemaName}" not found in model source."`);
    }

    let connector = schemaToConnector[schemaName];

    let DbModeler = require(`../modeler/database/${connector.driver}/Modeler`);

    let dbModeler = new DbModeler(context, schema.linker, connector, deploymentSetting.extraOptions);
    let refinedSchema = dbModeler.modeling(schema, schemaToConnector);

    if (context.saveIntermediate) {
      let jsFile = path.resolve(context.gemlPath, schemaName + ".model.json");
      fs.writeFileSync(jsFile, JSON.stringify(refinedSchema.toJSON(), null, 4));
    }

    const DaoModeler = require('../modeler/Dao');

    let daoModeler = new DaoModeler(context, schema.linker, connector);
    return daoModeler.modeling_(refinedSchema);
  });
};
//# sourceMappingURL=build.js.map