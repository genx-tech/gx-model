"use strict";

require("source-map-support/register");

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const EventEmitter = require('events');

const path = require('path');

const {
  _
} = require('@genx/july');

const {
  generateDisplayName,
  deepCloneField,
  Clonable,
  entityNaming
} = require('./GemlUtils');

const Field = require('./Field');

const {
  Types: {
    FunctionalQualifiers
  }
} = require('@genx/data');

class Entity extends Clonable {
  static overrideEntityMeta(sourceInfo, overrideInfo) {
    if (overrideInfo.features) {
      sourceInfo.features = [...(sourceInfo.features ?? []), ...overrideInfo.features];
    }

    if (overrideInfo.fields) {
      sourceInfo.fields = { ...sourceInfo.fields,
        ...overrideInfo.fields
      };
    }

    if (overrideInfo.associations) {
      sourceInfo.associations = [...(sourceInfo.associations ?? []), ...overrideInfo.associations];
    }

    if (overrideInfo.indexes) {
      sourceInfo.indexes = [...(sourceInfo.indexes ?? []), ...overrideInfo.indexes];
    }

    if (overrideInfo.inputs) {
      sourceInfo.inputs = { ...sourceInfo.inputs,
        ...overrideInfo.inputs
      };
    }
  }

  constructor(linker, name, gemlModule, info) {
    super();

    _defineProperty(this, "fields", {});

    _defineProperty(this, "types", {});

    this._events = new EventEmitter();
    this.linker = linker;
    this.name = entityNaming(name);
    this.gemlModule = gemlModule;
    this.info = info;
  }

  once(eventName, listener) {
    return this._events.once(eventName, listener);
  }

  link() {
    pre: !this.linked;

    this.linker.log('debug', 'Linking entity [' + this.name + '] ...');

    if (this.info.code) {
      this.code = this.info.code || this.name;
    }

    if (this.info.base) {
      let baseClasses = _.castArray(this.info.base);

      baseClasses.reverse().forEach(base => {
        let baseEntity = this.linker.loadEntity(this.gemlModule, base);

        assert: baseEntity.linked;

        this._inherit(baseEntity);
      });
      this.baseClasses = baseClasses;
    }

    if (this.info.comment) {
      this.comment = this.info.comment;
    }

    this.displayName = generateDisplayName(this.name);

    this._events.emit('featuresMixingIn');

    if (this.info.features) {
      this.info.features.forEach(feature => {
        let featureName;

        if (typeof feature === 'string') {
          featureName = feature;
        } else {
          featureName = feature.name;
        }

        let fn;

        try {
          fn = require(path.resolve(__dirname, `./entityFeatures/${featureName}.js`));
        } catch (err) {
          if (err.code === 'MODULE_NOT_FOUND') {
            throw new Error(`Unknown feature "${featureName}" reference in entity "${this.name}"`);
          }
        }

        fn(this, this.linker.translateOolValue(this.gemlModule, feature.args));
      });
    }

    this._events.emit('beforeAddingFields');

    if (this.info.fields) {
      _.each(this.info.fields, (fieldInfo, fieldName) => this.addField(fieldName, fieldInfo));
    }

    this._events.emit('afterAddingFields');

    if (this.info.key) {
      this.key = this.info.key;

      if (Array.isArray(this.key) && this.key.length === 1) {
        this.key = this.key[0];
      }
    }

    if (this.info.inputs) {
      this.inputs = this.info.inputs;
    }

    this._events.emit('beforeAddingInterfaces');

    if (!_.isEmpty(this.info.interfaces)) {
      this.interfaces = _.cloneDeep(this.info.interfaces);

      _.forOwn(this.interfaces, intf => {
        if (!_.isEmpty(intf.accept)) {
          intf.accept = _.map(intf.accept, param => {
            const [typeInfo, baseInfo] = this.linker.trackBackType(this.gemlModule, param);

            if (baseInfo != null) {
              this.addUsedType(param.type, baseInfo.gemlModule.id);
            }

            return typeInfo;
          });
        }
      });
    }

    this._events.emit('afterAddingInterfaces');

    this.linked = true;
    return this;
  }

  addUsedType(type, typeLocation) {
    const existing = this.types[type];

    if (existing == null) {
      this.types[type] = typeLocation;
    } else {
      if (existing !== typeLocation) {
        throw new Error('Different used types appear in the same entity!');
      }
    }
  }

  hasIndexOn(fields) {
    fields = fields.concat();
    fields.sort();
    return _.findIndex(this.indexes, index => {
      return _.findIndex(index.fields, (f, idx) => fields.length <= idx || fields[idx] !== f) === -1;
    }) != -1;
  }

  addIndexes() {
    if (this.info.indexes) {
      _.each(this.info.indexes, index => {
        this.addIndex(index);
      });
    }
  }

  addIndex(index) {
    if (!this.indexes) {
      this.indexes = [];
    }

    index = _.cloneDeep(index);

    assert: index.fields;

    if (!_.isArray(index.fields)) {
      index.fields = [index.fields];
    }

    let fields = index.fields;
    index.fields = _.map(fields, field => {
      let normalizedField = field;

      if (!this.hasField(normalizedField)) {
        throw new Error(`Index references non-exist field: ${field}, entity: ${this.name}.`);
      }

      return normalizedField;
    });
    index.fields.sort();

    if (this.hasIndexOn(index.fields)) {
      throw new Error(`Index on [${index.fields.join(', ')}] already exist in entity [${this.name}].`);
    }

    this.indexes.push(index);
    return this;
  }

  getEntityAttribute(fieldId) {
    if (fieldId[0] === '$') {
      let token = fieldId.substr(1);

      switch (token) {
        case "key":
          if (Array.isArray(this.key)) {
            throw new Error('Combination key not support for accesor "$key".');
          }

          return this.fields[this.key];

        case 'feature':
          return this.features;

        default:
          throw new Error(`Filed accessor "${token}" not supported!`);
      }
    } else {
      if (!this.hasField(fieldId)) {
        throw new Error(`Field "${fieldId}" not exists in entity "${this.name}".`);
      }

      return this.fields[fieldId];
    }
  }

  hasField(name) {
    if (Array.isArray(name)) {
      return _.every(name, fn => this.hasField(fn));
    }

    return name in this.fields;
  }

  addAssociation(name, props) {
    if (!this.associations) {
      this.associations = {};
    }

    if (name in this.associations) {
      throw new Error(`Association "${name}" already exists in entity "${this.name}". Props: ` + JSON.stringify(props));
    }

    this.associations[name] = props;
  }

  addAssocField(name, destEntity, destField, extraProps) {
    let localField = this.fields[name];

    if (localField) {
      throw new Error(`Field "${name}" already exists in entity "${this.name}".`);
    }

    let destFieldInfo = _.omit(destField.toJSON(), FunctionalQualifiers);

    Object.assign(destFieldInfo, extraProps);
    this.addField(name, destFieldInfo);
  }

  addField(name, rawInfo) {
    if (this.hasField(name)) {
      throw new Error(`Field name [${name}] conflicts in entity [${this.name}].`);
    }

    assert: rawInfo.type;

    let field;

    if (rawInfo instanceof Field) {
      field = rawInfo.clone();
      field.name = name;
    } else {
      let [fullRawInfo, baseInfo] = this.linker.trackBackType(this.gemlModule, rawInfo);

      if (baseInfo != null) {
        this.addUsedType(rawInfo.type, baseInfo.gemlModule.id);
      }

      field = new Field(name, fullRawInfo);
      field.link();
    }

    this.fields[name] = field;

    if (!this.key) {
      this.key = name;
    }

    return this;
  }

  addFeature(name, feature, allowMultiple) {
    if (!this.features) {
      this.features = {};
    }

    if (allowMultiple) {
      if (!this.features[name]) {
        this.features[name] = [];
      }

      this.features[name].push(feature);
    } else {
      if (name in this.features) {
        throw new Error(`Duplicate feature found: ${name}. An entity can only have one "${name}" feature only. Entity: ${this.name}`);
      }

      this.features[name] = feature;
    }

    return this;
  }

  hasFeature(name) {
    return this.features && name in this.features;
  }

  setKey(name) {
    this.key = name;
    return this;
  }

  getReferencedEntity(entityName) {
    return this.linker.loadEntity(this.gemlModule, entityName);
  }

  getReferenceTo(entityName, includes, excludes) {
    return this.info.associations && _.find(this.info.associations, assoc => {
      if (includes) {
        if (_.find(includes, (value, prop) => typeof value === 'function' ? !value(assoc[prop]) : !_.isEqual(assoc[prop], value))) return false;
      }

      if (excludes) {
        if (excludes.association && assoc === excludes.association) return false;
        if (excludes.type && assoc.type === excludes.type) return false;
        if (excludes.associations && excludes.associations.indexOf(assoc) > -1) return false;
        if (excludes.types && excludes.types.indexOf(assoc.type) > -1) return false;
        if (excludes.props && _.find(excludes.props, prop => assoc[prop])) return false;
      }

      return assoc.destEntity === entityName;
    });
  }

  getKeyField() {
    return Array.isArray(this.key) ? this.key.map(kf => this.fields[kf]) : this.fields[this.key];
  }

  clone() {
    super.clone();
    let entity = new Entity(this.linker, this.name, this.gemlModule, this.info);
    deepCloneField(this, entity, 'code');
    deepCloneField(this, entity, 'displayName');
    deepCloneField(this, entity, 'comment');
    deepCloneField(this, entity, 'features');
    deepCloneField(this, entity, 'fields');
    deepCloneField(this, entity, 'types');
    deepCloneField(this, entity, 'associations');
    deepCloneField(this, entity, 'key');
    deepCloneField(this, entity, 'indexes');
    deepCloneField(this, entity, 'inputs');
    deepCloneField(this, entity, 'interfaces');
    entity.linked = true;
    return entity;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      displayName: this.displayName,
      comment: this.comment,
      ...(this.baseClasses ? {
        baseClasses: this.baseClasses
      } : {}),
      features: this.features,
      types: this.types,
      fields: _.mapValues(this.fields, field => field.toJSON()),
      associations: this.associations,
      key: this.key,
      indexes: this.indexes
    };
  }

  _inherit(baseEntity) {
    let overrideInfo = {};

    if (baseEntity.baseClasses) {
      let baseClasses = baseEntity.baseClasses;

      if (this.baseClasses) {
        this.baseClasses = _.uniq(baseClasses.concat(this.baseClasses));
      } else {
        this.baseClasses = baseClasses.concat();
      }
    }

    if (!_.isEmpty(baseEntity.info.features)) {
      let baseFeatures = _.cloneDeep(baseEntity.info.features);

      if (this.info.features) {
        overrideInfo.features = baseFeatures.concat(this.info.features);
      } else {
        overrideInfo.features = baseFeatures;
      }
    }

    if (!_.isEmpty(baseEntity.info.fields)) {
      let fields = _.cloneDeep(baseEntity.info.fields);

      overrideInfo.fields = { ...fields,
        ...this.info.fields
      };
    }

    if (baseEntity.info.key) {
      overrideInfo.key = baseEntity.info.key;
    }

    if (baseEntity.info.indexes) {
      let indexes = _.cloneDeep(baseEntity.info.indexes);

      let uniqueIndexes = indexes.filter(index => index.unique);

      if (this.info.indexes) {
        this.info.indexes.forEach(index => {
          if (index.unique) {
            uniqueIndexes.forEach(inheritedIndex => {
              const fields1 = _.castArray(index.fields);

              const fields2 = _.castArray(inheritedIndex.fields);

              if (_.intersection(fields1, fields2).length === fields2.length) {
                const pos = indexes.indexOf(inheritedIndex);

                if (pos !== -1) {
                  indexes.splice(pos, 1);
                }
              }
            });
          }
        });
        indexes = indexes.concat(this.info.indexes);
      }

      overrideInfo.indexes = indexes;
    }

    if (baseEntity.info.associations) {
      let assocs = _.cloneDeep(baseEntity.info.associations);

      assocs = assocs.map(assoc => {
        if (assoc.destEntity === baseEntity.name) {
          return { ...assoc,
            destEntity: this.name
          };
        }

        return assoc;
      });

      if (this.info.associations) {
        assocs = assocs.concat(this.info.associations);
      }

      overrideInfo.associations = assocs;
    }

    if (baseEntity.inputs) {
      overrideInfo.inputs = { ...baseEntity.inputs,
        ...this.info.inputs
      };
    }

    if (!_.isEmpty(overrideInfo)) {
      this.info = { ...this.info,
        ...overrideInfo
      };
    }
  }

}

module.exports = Entity;
//# sourceMappingURL=Entity.js.map