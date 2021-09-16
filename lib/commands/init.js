"use strict";

require("source-map-support/register");

const path = require('path');

const {
  _,
  eachAsync_
} = require('@genx/july');

const {
  fs
} = require('@genx/sys');

const {
  throwIfFileNotExist,
  getSchemaConnectors
} = require('../utils/helpers');

const copyFileFromTemplate_ = require('../utils/copyFileFromTemplate_');

module.exports = async (app, context) => {
  var _config$settings;

  app.log('verbose', `${app.name} init`);
  const moduleName = app.commandLine.option('module');
  const schemaName = app.commandLine.option('schema');
  let workingPath = app.workingPath;
  let configName;

  if (moduleName) {
    workingPath = path.join(workingPath, 'app_modules', moduleName);
    configName = 'app';
  } else {
    configName = 'server';
  }

  const configFile = path.join(workingPath, 'conf', `${configName}.default.json`);
  throwIfFileNotExist('config', configFile);
  const config = await fs.readJson(configFile);

  if ((_config$settings = config.settings) !== null && _config$settings !== void 0 && _config$settings.geml) {
    throw new Error(`"geml" setting has already exist in ${configFile}`);
  }

  config.settings = { ...config.settings,
    geml: {
      gemlPath: "geml",
      modelPath: "src/models",
      scriptPath: "src/scripts",
      manifestPath: "manifests"
    }
  };
  await fs.writeJson(configFile, config, {
    spaces: 4
  });
  app.log('info', `"geml" setting is added into ${configFile}`);
  const gemlPath = path.join(workingPath, 'geml', 'entities');
  await fs.ensureDir(gemlPath);
  const schemaSource = path.resolve(__dirname, 'init/sample.geml');
  const entitySource = path.resolve(__dirname, 'init/test.geml');
  const schemaFile = path.join(workingPath, 'geml', `${schemaName}.geml`);
  const entityFile = path.join(workingPath, 'geml', 'entities', 'test.geml');
  await copyFileFromTemplate_(schemaSource, schemaFile, {
    schemaName
  });
  app.log('info', `Created ${schemaFile}`);
  await fs.copyFile(entitySource, entityFile);
  app.log('info', `Created ${entityFile}`);
};
//# sourceMappingURL=init.js.map