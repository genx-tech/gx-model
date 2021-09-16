"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

const FEATURE_NAME = 'i18n';

function feature(entity, args = []) {
  let [options] = args;

  if (!options) {
    throw new Error('Missing feature options!');
  }

  if (!_.isPlainObject(options)) {
    throw new Error('Invalid feature options. Plain object expected!');
  }

  if (!options.field) {
    throw new Error('Missing field name in options!');
  }

  if (!options.locales) {
    throw new Error('Missing locale mapping in options!');
  }

  if (!_.isPlainObject(options.locales)) {
    throw new Error('Invalid locale mapping. Plain object expected!');
  }

  entity.addFeature(FEATURE_NAME, options, true).once('afterAddingFields', () => {
    if (!entity.hasField(options.field)) {
      throw new Error('Field "' + options.field + '" does not exist!');
    }

    let fieldInfo = entity.fields[options.field];
    let suffixSet = new Set(Object.values(options.locales));

    for (let suffix of suffixSet) {
      if (suffix === 'default') continue;
      let fieldName = options.field + '_' + suffix;
      entity.addField(fieldName, fieldInfo);
    }
  });
}

module.exports = feature;
//# sourceMappingURL=i18n.js.map