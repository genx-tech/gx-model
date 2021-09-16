"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

const {
  generateDisplayName,
  deepCloneField,
  Clonable,
  fieldNaming
} = require('./GemlUtils');

const {
  Types
} = require('@genx/data');

const RESERVED_KEYS = new Set(['name', 'type', 'modifiers', 'subClass', 'values']);

class Field extends Clonable {
  constructor(name, info) {
    super();
    this.name = fieldNaming(name);
    this.info = info;
  }

  link() {
    assert: Types.Builtin.has(this.info.type);

    let typeObject = Types[this.info.type];

    _.forOwn(this.info, (value, key) => {
      if (RESERVED_KEYS.has(key)) {
        this[key] = value;
        return;
      }

      if (!typeObject.qualifiers.includes(key)) {
        throw new Error(`Unsupported field qualifier "${key}" for type "${this.info.type}" of field "${this.name}."`);
      }

      this[key] = Array.isArray(value) ? value[0] : value;
    });

    if (this.info.modifiers && _.find(this.info.modifiers, mod => mod.oolType === 'Activator')) {
      this.hasActivator = true;
    }

    this.displayName = generateDisplayName(this.name);
    deepCloneField(this.info, this, 'modifiers');
    this.linked = true;
  }

  hasSameType(targetField) {
    return _.isEqual(this.toJSON(), targetField);
  }

  clone() {
    super.clone();
    let field = new Field(this.name, this.info);
    Object.assign(field, this.toJSON());
    field.linked = true;
    return field;
  }

  toJSON() {
    return _.omit(_.toPlainObject(this), ['name', 'linked', 'info']);
  }

}

module.exports = Field;
//# sourceMappingURL=Field.js.map