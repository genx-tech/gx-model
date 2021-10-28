"use strict";

require("source-map-support/register");

const {
  _,
  eachAsync_,
  get,
  set
} = require('@genx/july');

const {
  fs
} = require('@genx/sys');

const npmInstall_ = require('../utils/npmInstall_');

const dependencies = {
  "mysql": ["mysql2"],
  "mongodb": ["mongodb"],
  "rabbitmq": ["amqplib"]
};

module.exports = async (app, context) => {
  app.log('verbose', `${app.name} connect`);
  const schemaName = app.option('schema');
  const dataSourceType = app.option('dbms');
  const dataSourceName = app.option('ds');
  const connection = app.option('conn');
  const config = await fs.readJson(context.configFullPath);
  const dsConfig = get(config, ['dataSource', dataSourceType, dataSourceName]);

  if (dsConfig != null) {
    throw new Error(`Data source "${dataSourceType}.${dataSourceName}" already exists.`);
  }

  set(config, ['dataSource', dataSourceType, dataSourceName], {
    connection,
    logStatement: true
  });
  set(config, ['settings', 'geml', 'schemas', schemaName, "dataSource"], `${dataSourceType}.${dataSourceName}`);
  await fs.writeJson(context.configFullPath, config, {
    spaces: 4
  });
  app.log('info', `Data source for schema "${schemaName}" is added into ${context.configFullPath}`);
  await npmInstall_(app, app.workingPath, dependencies[dataSourceType]);
};
//# sourceMappingURL=connect.js.map