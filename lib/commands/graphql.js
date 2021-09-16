"use strict";

require("source-map-support/register");

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
  app.log('verbose', `${app.name} graphql`);
  throwIfFileNotExist("gemlPath", context.gemlPath);
  let linker = new Linker(app, context);
  let schemaFiles = Linker.getGemlFiles(context.gemlPath, context.useJsonSource);
  schemaFiles.forEach(schemaFile => linker.link(schemaFile));
  let schemaToConnector = getSchemaConnectors(app, context.schemas);
  return eachAsync_(context.schemas, async (deploymentSetting, schemaName) => {
    app.log('verbose', `Processing schema "${schemaName}" ...`);
    let schema = linker.schemas[schemaName];

    if (!schema) {
      throw new Error(`Schema "${schemaName}" not found in model source."`);
    }

    let connector = schemaToConnector[schemaName];
    const skipGeneration = true;

    let DbModeler = require(`../modeler/database/${connector.driver}/Modeler`);

    let dbModeler = new DbModeler(context, linker, connector, deploymentSetting.extraOptions);
    let refinedSchema = dbModeler.modeling(schema, schemaToConnector, skipGeneration);

    const GraphQLModeler = require('../modeler/GraphQL');

    let graphQLModeler = new GraphQLModeler(context, linker, connector);
    return graphQLModeler.modeling_(refinedSchema);
  });
};
//# sourceMappingURL=graphql.js.map