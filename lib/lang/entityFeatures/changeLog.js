"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

const FEATURE_NAME = 'changeLog';

function feature(entity, args = []) {
  let [options] = args;
  options = {
    storeEntity: 'changeLogs',
    ...options
  };
  entity.addFeature(FEATURE_NAME, options);
}

module.exports = feature;
//# sourceMappingURL=changeLog.js.map