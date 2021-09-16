"use strict";

require("source-map-support/register");

const path = require('path');

const {
  throwIfFileNotExist,
  getSchemaConnectors,
  getDateNamedDir
} = require('../utils/helpers');

module.exports = async (app, context) => {
  app.log('verbose', `${app.name} reverse`);
  let schemaName = app.option('schema');
  let override = app.option('override');
  let schemaToConnector = getSchemaConnectors(app, context.schemas);
  let connector = schemaToConnector[schemaName];
  let basePath = path.join(context.manifestPath, 'reverse');
  let reverseOutput = getDateNamedDir(basePath, undefined, override);

  const ReserveEngineering = require(`../modeler/database/${connector.driver}/ReverseEngineering`);

  let modeler = new ReserveEngineering(app, connector);
  await modeler.reverse_(reverseOutput);
};
//# sourceMappingURL=reverse.js.map