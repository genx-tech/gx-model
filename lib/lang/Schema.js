"use strict";

require("source-map-support/register");

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const {
  _
} = require('@genx/july');

const {
  generateDisplayName,
  deepCloneField,
  Clonable,
  schemaNaming
} = require('./GemlUtils');

class Schema extends Clonable {
  constructor(linker, name, info) {
    super();

    _defineProperty(this, "types", {});

    _defineProperty(this, "entities", {});

    _defineProperty(this, "datasets", {});

    _defineProperty(this, "views", {});

    this.linker = linker;
    this.name = schemaNaming(name);
    this.gemlModule = this.linker.entryModule;
    this.info = info;
  }

  link() {
    pre: !this.linked;

    this.linker.log('verbose', 'Linking schema [' + this.name + '] ...');

    if (this.info.comment) {
      this.comment = this.info.comment;
    }

    this.displayName = generateDisplayName(this.name);
    this.info.entities || (this.info.entities = []);
    this.info.entities.forEach(entityEntry => {
      let entity = this.linker.loadEntity(this.gemlModule, entityEntry.entity);

      if (!entity.linked) {
        throw new Error(`Entity [${entity.name}] not linked after loading.`);
      }

      this.addEntity(entity);
    });

    if (!_.isEmpty(this.info.views)) {
      this.info.views.forEach(viewName => {
        let view = this.linker.loadView(this.gemlModule, viewName);

        if (!view.linked) {
          throw new Error(`View [${entity.name}] not linked after loading.`);
        }

        this.addView(view);
      });
    }

    this.linked = true;
    return this;
  }

  addType(type, typeLocation) {
    const existing = this.types[type];

    if (existing == null) {
      this.types[type] = typeLocation;
    } else {
      if (existing !== typeLocation) {
        throw new Error('Different used types appear in the same entity!');
      }
    }

    return this;
  }

  hasEntity(entityName) {
    return entityName in this.entities;
  }

  addEntity(entity) {
    if (this.hasEntity(entity.name)) {
      throw new Error(`Entity name [${entity.name}] conflicts in schema [${this.name}].`);
    }

    this.entities[entity.name] = entity;

    _.each(entity.types, (info, type) => this.addType(type, info));

    return this;
  }

  hasView(viewName) {
    return viewName in this.views;
  }

  addView(view) {
    pre: !this.hasView(view.name), `View name [${view.name}] conflicts in schema [${this.name}].`;

    this.views[view.name] = view;
    return this;
  }

  getDocumentHierachy(fromModule, datasetName) {
    if (datasetName in this.datasets) {
      return this.datasets[datasetName];
    }

    let dataset = this.linker.loadDataset(fromModule, datasetName);
    return this.datasets[datasetName] = dataset.buildHierarchy(this);
  }

  getReferencedEntity(refererModule, entityName) {
    let entity = this.linker.loadEntity(refererModule, entityName);

    if (!this.hasEntity(entity.name)) {
      throw new Error(`Entity "${entity.name}" not exists in schema "${this.name}".`);
    }

    return entity;
  }

  ensureGetEntity(refererModule, entityName, newlyAdded) {
    if (this.hasEntity(entityName)) return this.entities[entityName];
    let entity = this.linker.loadEntity(refererModule, entityName, false);

    if (entity) {
      this.addEntity(entity);

      if (newlyAdded) {
        newlyAdded.push(entity.name);
        this.linker.log('debug', `New entity "${entity.name}" added by association.`);
      }
    }

    return entity;
  }

  clone() {
    super.clone();
    let schema = new Schema(this.linker, this.name, this.info);
    deepCloneField(this, schema, 'displayName');
    deepCloneField(this, schema, 'comment');
    deepCloneField(this, schema, 'entities');
    deepCloneField(this, schema, 'types');
    deepCloneField(this, schema, 'datasets');
    deepCloneField(this, schema, 'views');
    schema.linked = true;
    return schema;
  }

  toJSON() {
    return {
      name: this.name,
      displayName: this.displayName,
      comment: this.comment,
      entities: _.mapValues(this.entities, entity => entity.toJSON()),
      types: this.types,
      datasets: _.mapValues(this.datasets, dataset => dataset.toJSON()),
      views: _.mapValues(this.views, view => view.toJSON())
    };
  }

}

module.exports = Schema;
//# sourceMappingURL=Schema.js.map