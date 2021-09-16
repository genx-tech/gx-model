"use strict";

require("source-map-support/register");

const FEATURE_NAME = 'atLeastOneNotNull';

function feature(entity, [fields]) {
  if (!fields) {
    throw new Error('Missing field names!');
  }

  Array.isArray(fields) || (fields = [fields]);
  entity.addFeature(FEATURE_NAME, fields, true).once('afterAddingFields', () => {
    fields.forEach(fieldName => {
      let field = entity.fields[fieldName];

      if (!field) {
        throw new Error('Required field "' + fieldName + '" not exist.');
      }

      field.optional = true;
    });
  });
}

module.exports = feature;
//# sourceMappingURL=atLeastOneNotNull.js.map