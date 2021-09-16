"use strict";

require("source-map-support/register");

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const {
  _
} = require('@genx/july');

const {
  generateDisplayName,
  deepCloneField,
  Clonable
} = require('./GemlUtils');

const Dataset = require('./Dataset');

class View extends Clonable {
  constructor(linker, name, gemlModule, info) {
    this.linker = linker;
    this.name = name;
    this.gemlModule = gemlModule;
    this.info = info;
  }

  link() {
    pre: !this.linked;

    if (this.info.dataset) {
      this.dataset = this.linker.loadDoc(this.gemlModule, this.info.dataset);
    } else {
      assert: this.info.entity, 'Invalid view syntax!';

      let mainEntity = this.linker.getReferencedEntity(this.gemlModule, this.info.entity);
      this.dataset = new Dataset(this.linker, mainEntity.name, this.gemlModule, {
        mainEntity: mainEntity.name
      });
      this.dataset.link();
    }

    if (this.info.isList) {
      this.isList = true;
    }

    if (!_.isEmpty(this.info.accept)) {
      this.params = this.info.accept.concat();
    }

    if (!_.isEmpty(this.info.selectBy)) {
      this.selectBy = this.info.selectBy.concat();
    }

    if (!_.isEmpty(this.info.groupBy)) {
      this.groupBy = this.info.groupBy.concat();
    }

    if (!_.isEmpty(this.info.orderBy)) {
      this.orderBy = this.info.orderBy.concat();
    }

    if (this.info.skip) {
      this.skip = _.isPlainObject(this.info.skip) ? Object.assign({}, this.info.skip) : this.info.skip;
    }

    if (this.info.limit) {
      this.limit = _.isPlainObject(this.info.limit) ? Object.assign({}, this.info.limit) : this.info.limit;
    }

    this.linked = true;
    return this;
  }

  inferTypeInfo(inSchema) {
    if (!_.isEmpty(this.params)) {
      let inferredParams = [];
      this.params.forEach(param => {
        if (GemlUtils.isMemberAccess(param.type)) {
          let [entityName, fieldName] = param.type.split('.');

          if (!inSchema.hasEntity(entityName)) {
            throw new Error(`Parameter "${param.name}" references to an entity "${entityName}" which is not belong to the schema.`);
          }

          let entity = inSchema.entities[entityName];
          let field = entity.getEntityAttribute(fieldName);
          inferredParams.push(Object.assign(_.omit(_.toPlainObject(field), ['isReference', 'optional', 'displayName']), {
            name: param.name
          }));
        } else {
          inferredParams.push(this.linker.trackBackType(this.gemlModule, param));
        }
      });
      this.params = inferredParams;
    }
  }

  getDocumentHierarchy(inSchema) {
    return inSchema.getDocumentHierachy(this.gemlModule, this.dataset.name);
  }

  clone() {
    super.clone();
    let view = new View(this.linker, this.name, this.gemlModule, this.info);
    deepCloneField(this, view, 'dataset');
    deepCloneField(this, view, 'params');
    deepCloneField(this, view, 'selectBy');
    deepCloneField(this, view, 'groupBy');
    deepCloneField(this, view, 'orderBy');
    deepCloneField(this, view, 'skip');
    deepCloneField(this, view, 'limit');
    view.isList = this.isList;
    view.linked = true;
    return view;
  }

  toJSON() {
    return {
      name: this.name,
      dataset: this.dataset.toJSON(),
      isList: this.isList,
      params: this.params,
      selectBy: this.selectBy,
      groupBy: this.groupBy,
      orderBy: this.orderBy,
      skip: this.skip,
      limit: this.limit
    };
  }

}

module.exports = View;
//# sourceMappingURL=View.js.map