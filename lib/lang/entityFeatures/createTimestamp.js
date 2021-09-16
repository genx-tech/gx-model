"use strict";

require("source-map-support/register");

const FEATURE_NAME = 'createTimestamp';

function feature(entity, args = []) {
  let typeInfo = {
    name: 'createdAt',
    type: 'datetime',
    auto: true,
    readOnly: true,
    writeOnce: true
  };
  let [options] = args;

  if (options) {
    if (typeof options === 'string') {
      options = {
        name: options
      };
    }

    Object.assign(typeInfo, options);
  }

  let fieldName = typeInfo.name;
  entity.addFeature(FEATURE_NAME, {
    field: fieldName
  }).once('afterAddingFields', () => {
    entity.addField(fieldName, typeInfo);
  });
}

module.exports = feature;
//# sourceMappingURL=createTimestamp.js.map