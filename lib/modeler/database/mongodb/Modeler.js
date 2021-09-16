"use strict";

require("source-map-support/register");

const path = require('path');

const {
  fs
} = require('@genx/sys');

class MongoDbModeler {
  constructor(context, connector, dbOptions) {
    this.logger = context.logger;
    this.linker = context.linker;
    this.outputPath = context.scriptOutputPath;
    this.connector = connector;
  }

  modeling(schema) {
    let dataFilesDir = path.join('mongodb', this.connector.database);
    let initIdxFilePath = path.join(dataFilesDir, 'data', '_init', 'index.list');
    let initFilePath = path.join(dataFilesDir, 'data', '_init', '0-init.json');

    this._writeFile(path.join(this.outputPath, initFilePath), JSON.stringify({}, null, 4));

    if (!fs.existsSync(path.join(this.outputPath, initIdxFilePath))) {
      this._writeFile(path.join(this.outputPath, initIdxFilePath), '0-init.json\n');
    }

    return schema;
  }

  _writeFile(filePath, content) {
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, content);
    this.logger.log('info', 'Generated db script: ' + filePath);
  }

}

module.exports = MongoDbModeler;
//# sourceMappingURL=Modeler.js.map