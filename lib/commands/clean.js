"use strict";

require("source-map-support/register");

const path = require('path');

const {
  _,
  naming,
  eachAsync_
} = require('@genx/july');

const del = require('del');

const {
  throwIfFileNotExist
} = require('../utils/helpers');

const Linker = require('../lang/Linker');

module.exports = async (app, context) => {
  app.log('verbose', `${app.name} clean`);
  throwIfFileNotExist("gemlPath", context.gemlPath);
  let linker = new Linker(app, context);
  let schemaFiles = Linker.getGemlFiles(context.gemlPath, context.useJsonSource);
  schemaFiles.forEach(schemaFile => linker.link(schemaFile));
  const jsonFiles = path.join(context.gemlPath, '**/*.json');
  await del(jsonFiles);
  app.log('info', `Deleted intermediate files.`);
  return eachAsync_(linker.schemas, async (schema, schemaName) => {
    app.log('verbose', `Removing auto-generated files of schema "${schemaName}" ...`);
    await del([path.join(context.manifestPath, schemaName, '*.js'), path.join(context.manifestPath, schemaName, '*.json'), path.join(context.modelPath, naming.pascalCase(schemaName) + '.js'), path.join(context.modelPath, schemaName, 'base', '*.js'), path.join(context.modelPath, schemaName, 'inputs', '*.js'), path.join(context.modelPath, schemaName, 'types', '*.js')]);
    app.log('info', `Removed auto-generated files of schema "${schemaName}".`);
  });
};
//# sourceMappingURL=clean.js.map