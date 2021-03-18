"use strict";

require("source-map-support/register");

const EventEmitter = require("events");

const path = require("path");

const Util = require("rk-utils");

const {
  _,
  fs,
  quote,
  putIntoBucket
} = Util;

const GemlUtils = require("../../../lang/GemlUtils");

const {
  pluralize,
  isDotSeparateName,
  extractDotSeparateName
} = GemlUtils;

const Entity = require("../../../lang/Entity");

const {
  Types
} = require("@genx/data");

const UNSUPPORTED_DEFAULT_VALUE = new Set(["BLOB", "TEXT", "JSON", "GEOMETRY"]);

class MySQLModeler {
  constructor(context, linker, connector, dbOptions) {
    this.linker = linker;
    this.outputPath = context.scriptPath;
    this.connector = connector;
    this._events = new EventEmitter();
    this._dbOptions = dbOptions ? {
      db: _.mapKeys(dbOptions.db, (value, key) => _.upperCase(key)),
      table: _.mapKeys(dbOptions.table, (value, key) => _.upperCase(key))
    } : {};
    this._references = {};
    this._relationEntities = {};
    this._processedRef = new Set();
  }

  modeling(schema, schemaToConnector, skipGeneration) {
    if (!skipGeneration) {
      this.linker.log("info", 'Generating mysql scripts for schema "' + schema.name + '"...');
    }

    let modelingSchema = schema.clone();
    this.linker.log("debug", "Building relations...");
    let pendingEntities = Object.keys(modelingSchema.entities);

    while (pendingEntities.length > 0) {
      let entityName = pendingEntities.shift();
      let entity = modelingSchema.entities[entityName];

      if (!_.isEmpty(entity.info.associations)) {
        this.linker.log("debug", `Processing associations of entity "${entityName}"...`);

        let assocs = this._preProcessAssociations(entity);

        let assocNames = assocs.reduce((result, v) => {
          result[v] = v;
          return result;
        }, {});
        entity.info.associations.forEach(assoc => this._processAssociation(modelingSchema, entity, assoc, assocNames, pendingEntities));
      }
    }

    this._events.emit("afterRelationshipBuilding");

    let sqlFilesDir = path.join("mysql", this.connector.database);
    let dbFilePath = path.join(sqlFilesDir, "entities.sql");
    let fkFilePath = path.join(sqlFilesDir, "relations.sql");
    let tableSQL = "",
        relationSQL = "",
        data = {};

    _.each(modelingSchema.entities, (entity, entityName) => {
      entity.addIndexes();
      let result = MySQLModeler.complianceCheck(entity);

      if (result.errors.length) {
        let message = "";

        if (result.warnings.length > 0) {
          message += "Warnings: \n" + result.warnings.join("\n") + "\n";
        }

        message += result.errors.join("\n");
        throw new Error(message);
      }

      if (entity.features) {
        _.forOwn(entity.features, (f, featureName) => {
          if (Array.isArray(f)) {
            f.forEach(ff => this._featureReducer(modelingSchema, entity, featureName, ff));
          } else {
            this._featureReducer(modelingSchema, entity, featureName, f);
          }
        });
      }

      if (!skipGeneration) {
        tableSQL += this._createTableStatement(entityName, entity) + "\n";

        if (entity.info.data) {
          entity.info.data.forEach(({
            dataSet,
            runtimeEnv,
            records
          }) => {
            let entityData = [];

            if (Array.isArray(records)) {
              records.forEach(record => {
                if (!_.isPlainObject(record)) {
                  let fields = Object.keys(entity.fields);

                  if (fields.length !== 2) {
                    throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
                  }

                  let keyField = entity.fields[fields[0]];

                  if (!keyField.auto && !keyField.defaultByDb) {
                    throw new Error(`The key field "${entity.name}" has no default value or auto-generated value.`);
                  }

                  record = {
                    [fields[1]]: this.linker.translateOolValue(entity.gemlModule, record)
                  };
                } else {
                  record = this.linker.translateOolValue(entity.gemlModule, record);
                }

                entityData.push(record);
              });
            } else {
              _.forOwn(records, (record, key) => {
                if (!_.isPlainObject(record)) {
                  let fields = Object.keys(entity.fields);

                  if (fields.length !== 2) {
                    throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
                  }

                  record = {
                    [entity.key]: key,
                    [fields[1]]: this.linker.translateOolValue(entity.gemlModule, record)
                  };
                } else {
                  record = Object.assign({
                    [entity.key]: key
                  }, this.linker.translateOolValue(entity.gemlModule, record));
                }

                entityData.push(record);
              });
            }

            if (!_.isEmpty(entityData)) {
              dataSet || (dataSet = "_init");
              runtimeEnv || (runtimeEnv = "default");
              let nodes = [dataSet, runtimeEnv];
              nodes.push(entityName);
              let key = nodes.join(".");
              putIntoBucket(data, key, entityData, true);
            }
          });
        }
      }
    });

    if (!skipGeneration) {
      _.forOwn(this._references, (refs, srcEntityName) => {
        _.each(refs, ref => {
          relationSQL += this._addForeignKeyStatement(srcEntityName, ref, schemaToConnector) + "\n";
        });
      });

      this._writeFile(path.join(this.outputPath, dbFilePath), tableSQL);

      this._writeFile(path.join(this.outputPath, fkFilePath), relationSQL);

      let initIdxFiles = {};

      if (!_.isEmpty(data)) {
        _.forOwn(data, (envData, dataSet) => {
          _.forOwn(envData, (entitiesData, runtimeEnv) => {
            _.forOwn(entitiesData, (records, entityName) => {
              let initFileName = `0-${entityName}.json`;
              let pathNodes = [sqlFilesDir, "data", dataSet || "_init"];

              if (runtimeEnv !== "default") {
                pathNodes.push(runtimeEnv);
              }

              let initFilePath = path.join(...pathNodes, initFileName);
              let idxFilePath = path.join(...pathNodes, "index.list");
              putIntoBucket(initIdxFiles, [idxFilePath], initFileName);

              this._writeFile(path.join(this.outputPath, initFilePath), JSON.stringify({
                [entityName]: records
              }, null, 4));
            });
          });
        });
      }

      _.forOwn(initIdxFiles, (list, filePath) => {
        let idxFilePath = path.join(this.outputPath, filePath);
        let manual = [];

        if (fs.existsSync(idxFilePath)) {
          let lines = fs.readFileSync(idxFilePath, "utf8").split("\n");
          lines.forEach(line => {
            if (!line.startsWith("0-")) {
              manual.push(line);
            }
          });
        }

        this._writeFile(idxFilePath, list.concat(manual).join("\n"));
      });

      let funcSQL = "";
      let spFilePath = path.join(sqlFilesDir, "procedures.sql");

      this._writeFile(path.join(this.outputPath, spFilePath), funcSQL);
    }

    return modelingSchema;
  }

  _toColumnReference(name) {
    return {
      oorType: "ColumnReference",
      name
    };
  }

  _translateJoinCondition(context, localField, anchor, remoteField) {
    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._translateJoinCondition(context, localField, anchor, rf));
    }

    if (_.isPlainObject(remoteField)) {
      let ret = {
        [localField]: this._toColumnReference(anchor + "." + remoteField.by)
      };

      let withExtra = this._oolConditionToQueryCondition(context, remoteField.with);

      if (localField in withExtra) {
        return {
          $and: [ret, withExtra]
        };
      }

      return { ...ret,
        ...withExtra
      };
    }

    return {
      [localField]: this._toColumnReference(anchor + "." + remoteField)
    };
  }

  _getAllRelatedFields(remoteField) {
    if (!remoteField) return undefined;

    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._getAllRelatedFields(rf));
    }

    if (_.isPlainObject(remoteField)) {
      return remoteField.by;
    }

    return remoteField;
  }

  _preProcessAssociations(entity) {
    return entity.info.associations.map(assoc => {
      if (assoc.srcField) return assoc.srcField;

      if (assoc.type === "hasMany") {
        return pluralize(assoc.destEntity);
      }

      return assoc.destEntity;
    });
  }

  _processAssociation(schema, entity, assoc, assocNames, pendingEntities) {
    let entityKeyField = entity.getKeyField();
    this.linker.log("debug", `Processing "${entity.name}" ${JSON.stringify(assoc)}`);
    let destEntityName = assoc.destEntity,
        destEntity,
        destEntityNameAsFieldName;

    if (isDotSeparateName(destEntityName)) {
      let [destSchemaName, actualDestEntityName] = extractDotSeparateName(destEntityName);
      let destSchema = schema.linker.schemas[destSchemaName];

      if (!destSchema.linked) {
        throw new Error(`The destination schema ${destSchemaName} has not been linked yet. Currently only support one-way reference for cross db relation.`);
      }

      destEntity = destSchema.entities[actualDestEntityName];
      destEntityNameAsFieldName = actualDestEntityName;
    } else {
      destEntity = schema.ensureGetEntity(entity.gemlModule, destEntityName, pendingEntities);

      if (!destEntity) {
        throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
      }

      destEntityNameAsFieldName = destEntityName;
    }

    if (!destEntity) {
      throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
    }

    let destKeyField = destEntity.getKeyField();

    if (Array.isArray(destKeyField)) {
      throw new Error(`Destination entity "${destEntityName}" with combination primary key is not supported.`);
    }

    switch (assoc.type) {
      case "hasOne":
      case "hasMany":
        let includes;
        let excludes = {
          types: ["refersTo"],
          association: assoc
        };

        if (assoc.by) {
          excludes.types.push("belongsTo");
          includes = {
            by: cb => cb && cb.split(".")[0] === assoc.by.split(".")[0]
          };

          if (assoc.with) {
            includes.with = assoc.with;
          }
        } else {
          let remoteFields = this._getAllRelatedFields(assoc.remoteField);

          includes = {
            srcField: remoteField => {
              remoteField || (remoteField = entity.name);
              return _.isNil(remoteFields) || (Array.isArray(remoteFields) ? remoteFields.indexOf(remoteField) > -1 : remoteFields === remoteField);
            }
          };
        }

        let backRef = destEntity.getReferenceTo(entity.name, includes, excludes);

        if (backRef) {
          if (backRef.type === "hasMany" || backRef.type === "hasOne") {
            if (!assoc.by) {
              throw new Error('"m2n" association requires "by" property. Entity: ' + entity.name + " destination: " + destEntityName);
            }

            let connectedByParts = assoc.by.split(".");
            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);
            let tag1 = `${entity.name}:${assoc.type === "hasMany" ? "m" : "1"}-${destEntityName}:${backRef.type === "hasMany" ? "n" : "1"} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === "hasMany" ? "m" : "1"}-${entity.name}:${assoc.type === "hasMany" ? "n" : "1"} by ${connEntityName}`;

            if (assoc.srcField) {
              tag1 += " " + assoc.srcField;
            }

            if (backRef.srcField) {
              tag2 += " " + backRef.srcField;
            }

            if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
              return;
            }

            let connectedByParts2 = backRef.by.split(".");
            let connectedByField2 = connectedByParts2.length > 1 && connectedByParts2[1] || destEntityNameAsFieldName;

            if (connectedByField === connectedByField2) {
              throw new Error('Cannot use the same "by" field in a relation entity.');
            }

            let connEntity = schema.ensureGetEntity(entity.gemlModule, connEntityName, pendingEntities);

            if (!connEntity) {
              connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, connectedByField2);
              pendingEntities.push(connEntity.name);
              this.linker.log("debug", `New entity "${connEntity.name}" added by association.`);
            }

            this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

            let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);
            entity.addAssociation(localFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: localFieldName
              }, entity.key, localFieldName, assoc.with ? {
                by: connectedByField,
                with: assoc.with
              } : connectedByField),
              field: connectedByField,
              ...(assoc.type === "hasMany" ? {
                list: true
              } : {}),
              assoc: connectedByField2
            });
            let remoteFieldName = backRef.srcField || pluralize(entity.name);
            destEntity.addAssociation(remoteFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: remoteFieldName
              }, destEntity.key, remoteFieldName, backRef.with ? {
                by: connectedByField2,
                with: backRef.with
              } : connectedByField2),
              field: connectedByField2,
              ...(backRef.type === "hasMany" ? {
                list: true
              } : {}),
              assoc: connectedByField
            });

            this._processedRef.add(tag1);

            this.linker.log("verbose", `Processed 2-way reference: ${tag1}`);

            this._processedRef.add(tag2);

            this.linker.log("verbose", `Processed 2-way reference: ${tag2}`);
          } else if (backRef.type === "belongsTo") {
            if (assoc.by) {
              throw new Error("todo: belongsTo by. entity: " + entity.name);
            } else {
              let anchor = assoc.srcField || (assoc.type === "hasMany" ? pluralize(destEntityNameAsFieldName) : destEntityNameAsFieldName);
              let remoteField = assoc.remoteField || backRef.srcField || entity.name;

              if (destEntity.hasFeature("logicalDeletion")) {
                let deletionCheck = {
                  oolType: "BinaryExpression",
                  operator: "!=",
                  left: {
                    oolType: "ObjectReference",
                    name: `${destEntityName}.${destEntity.features["logicalDeletion"].field}`
                  },
                  right: true
                };

                if (_.isPlainObject(remoteField)) {
                  remoteField.with = {
                    oolType: "LogicalExpression",
                    operator: "and",
                    left: remoteField.with,
                    right: deletionCheck
                  };
                } else if (assoc.with) {
                  assoc.with = {
                    oolType: "LogicalExpression",
                    operator: "and",
                    left: assoc.with,
                    right: deletionCheck
                  };
                } else {
                  assoc.with = deletionCheck;
                }
              }

              entity.addAssociation(anchor, {
                entity: destEntityName,
                key: destEntity.key,
                on: this._translateJoinCondition({ ...assocNames,
                  [destEntityName]: anchor
                }, entity.key, anchor, assoc.with ? {
                  by: remoteField,
                  with: assoc.with
                } : remoteField),
                ...(typeof remoteField === "string" ? {
                  field: remoteField
                } : {}),
                ...(assoc.type === "hasMany" ? {
                  list: true
                } : {})
              });
            }
          } else {
            throw new Error("Unexpected path. Entity: " + entity.name + ", association: " + JSON.stringify(assoc, null, 2));
          }
        } else {
          let connectedByParts = assoc.by ? assoc.by.split(".") : [GemlUtils.prefixNaming(entity.name, destEntityName)];
          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);
          let tag1 = `${entity.name}:${assoc.type === "hasMany" ? "m" : "1"}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += " " + assoc.srcField;
          }

          let connEntity = schema.ensureGetEntity(entity.gemlModule, connEntityName, pendingEntities);

          if (!connEntity) {
            connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, destEntityNameAsFieldName);
            pendingEntities.push(connEntity.name);
            this.linker.log("debug", `New entity "${connEntity.name}" added by association.`);
          }

          let connBackRef1 = connEntity.getReferenceTo(entity.name, {
            type: "refersTo",
            srcField: f => _.isNil(f) || f == connectedByField
          });

          if (!connBackRef1) {
            throw new Error(`Cannot find back reference to "${entity.name}" from relation entity "${connEntityName}".`);
          }

          let connBackRef2 = connEntity.getReferenceTo(destEntityName, {
            type: "refersTo"
          }, {
            association: connBackRef1
          });

          if (!connBackRef2) {
            throw new Error(`Cannot find back reference to "${destEntityName}" from relation entity "${connEntityName}".`);
          }

          let connectedByField2 = connBackRef2.srcField || destEntityNameAsFieldName;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "by" field in a relation entity. Detail: ' + JSON.stringify({
              src: entity.name,
              dest: destEntityName,
              srcField: assoc.srcField,
              by: connectedByField
            }));
          }

          this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

          let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);
          entity.addAssociation(localFieldName, {
            entity: connEntityName,
            key: connEntity.key,
            on: this._translateJoinCondition({ ...assocNames,
              [destEntityName]: localFieldName + "." + connectedByField2,
              [connEntityName]: localFieldName
            }, entity.key, localFieldName, assoc.with ? {
              by: connectedByField,
              with: assoc.with
            } : connectedByField),
            field: connectedByField,
            ...(assoc.type === "hasMany" ? {
              list: true
            } : {}),
            assoc: connectedByField2
          });

          this._processedRef.add(tag1);

          this.linker.log("verbose", `Processed 1-way reference: ${tag1}`);
        }

        break;

      case "refersTo":
      case "belongsTo":
        let localField = assoc.srcField || destEntityNameAsFieldName;
        let destFieldName = destKeyField.name;
        let referencedField = destKeyField;

        if (assoc.type === "refersTo") {
          let tag = `${entity.name}:1-${destEntityName}:* ${localField}`;

          if (assoc.destField) {
            if (!destEntity.hasField(assoc.destField)) {
              throw new Error(`The field "${assoc.destField}" being referenced is not a field of entity "${destEntityName}".`);
            }

            destFieldName = assoc.destField;
            referencedField = destEntity.fields[destFieldName];
          }

          tag += "->" + assoc.destField;

          if (this._processedRef.has(tag)) {
            return;
          }

          this._processedRef.add(tag);

          this.linker.log("verbose", `Processed week reference: ${tag}`);
        }

        let joinOn = {
          [localField]: this._toColumnReference(localField + "." + destFieldName)
        };

        if (assoc.with) {
          Object.assign(joinOn, this._oolConditionToQueryCondition({ ...assocNames,
            [destEntityName]: localField
          }, assoc.with));
        }

        entity.addAssocField(localField, destEntity, referencedField, assoc.fieldProps);
        entity.addAssociation(localField, {
          type: assoc.type,
          entity: destEntityName,
          key: destEntity.key,
          field: destFieldName,
          on: joinOn
        });
        let localFieldObj = entity.fields[localField];
        let constraints = {};

        if (localFieldObj.constraintOnUpdate) {
          constraints.onUpdate = localFieldObj.constraintOnUpdate;
        }

        if (localFieldObj.constraintOnDelete) {
          constraints.onDelete = localFieldObj.constraintOnDelete;
        }

        if (assoc.type === "belongsTo") {
          constraints.onUpdate || (constraints.onUpdate = "CASCADE");
          constraints.onDelete || (constraints.onDelete = "CASCADE");
        } else if (localFieldObj.optional) {
          constraints.onUpdate || (constraints.onUpdate = "SET NULL");
          constraints.onDelete || (constraints.onDelete = "SET NULL");
        }

        constraints.onUpdate || (constraints.onUpdate = "NO ACTION");
        constraints.onDelete || (constraints.onDelete = "NO ACTION");

        this._addReference(entity.name, localField, destEntityName, destFieldName, constraints);

        break;
    }
  }

  _oolConditionToQueryCondition(context, oolCon) {
    if (oolCon.oolType === "BinaryExpression") {
      if (oolCon.operator === "==") {
        let left = oolCon.left;

        if (left.oolType && left.oolType === "ObjectReference") {
          left = this._translateReference(context, left.name, true);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === "ObjectReference") {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            $eq: right
          }
        };
      } else if (oolCon.operator === "!=") {
        let left = oolCon.left;

        if (left.oolType && left.oolType === "ObjectReference") {
          left = this._translateReference(context, left.name, true);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === "ObjectReference") {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            $ne: right
          }
        };
      }
    } else if (oolCon.oolType === "UnaryExpression") {
      let arg;

      switch (oolCon.operator) {
        case "is-null":
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === "ObjectReference") {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              $eq: null
            }
          };

        case "is-not-null":
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === "ObjectReference") {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              $ne: null
            }
          };

        default:
          throw new Error("Unknown UnaryExpression operator: " + oolCon.operator);
      }
    } else if (oolCon.oolType === "LogicalExpression") {
      switch (oolCon.operator) {
        case "and":
          return {
            $and: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };

        case "or":
          return {
            $or: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };
      }
    }

    throw new Error("Unknown syntax: " + JSON.stringify(oolCon));
  }

  _translateReference(context, ref, asKey) {
    let [base, ...other] = ref.split(".");
    let translated = context[base];

    if (!translated) {
      console.log(context);
      throw new Error(`Referenced object "${ref}" not found in context.`);
    }

    let refName = [translated, ...other].join(".");

    if (asKey) {
      return refName;
    }

    return this._toColumnReference(refName);
  }

  _addReference(left, leftField, right, rightField, constraints) {
    if (Array.isArray(leftField)) {
      leftField.forEach(lf => this._addReference(left, lf, right, rightField, constraints));
      return;
    }

    if (_.isPlainObject(leftField)) {
      this._addReference(left, leftField.by, right.rightField, constraints);

      return;
    }

    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      refs4LeftEntity = [];
      this._references[left] = refs4LeftEntity;
    } else {
      let found = _.find(refs4LeftEntity, item => item.leftField === leftField && item.right === right && item.rightField === rightField);

      if (found) return;
    }

    refs4LeftEntity.push({
      leftField,
      right,
      rightField,
      constraints
    });
  }

  _getReferenceOfField(left, leftField) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      return undefined;
    }

    let reference = _.find(refs4LeftEntity, item => item.leftField === leftField);

    if (!reference) {
      return undefined;
    }

    return reference;
  }

  _hasReferenceOfField(left, leftField) {
    let refs4LeftEntity = this._references[left];
    if (!refs4LeftEntity) return false;
    return undefined !== _.find(refs4LeftEntity, item => item.leftField === leftField);
  }

  _getReferenceBetween(left, right) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      return undefined;
    }

    let reference = _.find(refs4LeftEntity, item => item.right === right);

    if (!reference) {
      return undefined;
    }

    return reference;
  }

  _hasReferenceBetween(left, right) {
    let refs4LeftEntity = this._references[left];
    if (!refs4LeftEntity) return false;
    return undefined !== _.find(refs4LeftEntity, item => item.right === right);
  }

  _featureReducer(schema, entity, featureName, feature) {
    let field;

    switch (featureName) {
      case "autoId":
        field = entity.fields[feature.field];

        if (field.type === "integer" && !field.generator) {
          field.autoIncrementId = true;

          if ("startFrom" in feature) {
            this._events.once("setTableOptions:" + entity.name, extraOpts => {
              extraOpts["AUTO_INCREMENT"] = feature.startFrom;
            });
          }
        }

        break;

      case "createTimestamp":
        field = entity.fields[feature.field];
        field.isCreateTimestamp = true;
        break;

      case "updateTimestamp":
        field = entity.fields[feature.field];
        field.isUpdateTimestamp = true;
        break;

      case "userEditTracking":
        break;

      case "logicalDeletion":
        break;

      case "atLeastOneNotNull":
        break;

      case "validateAllFieldsOnCreation":
        break;

      case "stateTracking":
        break;

      case "i18n":
        break;

      case "changeLog":
        let changeLogSettings = Util.getValueByPath(schema.deploymentSettings, "features.changeLog");

        if (!changeLogSettings) {
          throw new Error(`Missing "changeLog" feature settings in deployment config for schema [${schema.name}].`);
        }

        if (!changeLogSettings.dataSource) {
          throw new Error(`"changeLog.dataSource" is required. Schema: ${schema.name}`);
        }

        Object.assign(feature, changeLogSettings);
        break;

      default:
        throw new Error('Unsupported feature "' + featureName + '".');
    }
  }

  _writeFile(filePath, content) {
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, content);
    this.linker.log("info", "Generated db script: " + filePath);
  }

  _addRelationEntity(schema, relationEntityName, entity1Name, entity2Name, entity1RefField, entity2RefField) {
    let entityInfo = {
      features: ["autoId", "createTimestamp"],
      indexes: [{
        fields: [entity1RefField, entity2RefField],
        unique: true
      }],
      associations: [{
        type: "refersTo",
        destEntity: entity1Name,
        srcField: entity1RefField
      }, {
        type: "refersTo",
        destEntity: entity2Name,
        srcField: entity2RefField
      }]
    };
    let entity = new Entity(this.linker, relationEntityName, schema.gemlModule, entityInfo);
    entity.link();
    schema.addEntity(entity);
    return entity;
  }

  _updateRelationEntity(relationEntity, entity1, entity2, entity1Name, entity2Name, connectedByField, connectedByField2) {
    let relationEntityName = relationEntity.name;
    this._relationEntities[relationEntityName] = true;

    if (relationEntity.info.associations) {
      let hasRefToEntity1 = false,
          hasRefToEntity2 = false;

      _.each(relationEntity.info.associations, assoc => {
        if (assoc.type === "refersTo" && assoc.destEntity === entity1Name && (assoc.srcField || entity1Name) === connectedByField) {
          hasRefToEntity1 = true;
        }

        if (assoc.type === "refersTo" && assoc.destEntity === entity2Name && (assoc.srcField || entity2Name) === connectedByField2) {
          hasRefToEntity2 = true;
        }
      });

      if (hasRefToEntity1 && hasRefToEntity2) {
        return;
      }
    }

    let tag1 = `${relationEntityName}:1-${entity1Name}:* ${connectedByField}`;
    let tag2 = `${relationEntityName}:1-${entity2Name}:* ${connectedByField2}`;

    if (this._processedRef.has(tag1)) {
      return;
    }

    this._processedRef.add(tag1);

    this.linker.log("verbose", `Processed bridging reference: ${tag1}`);

    this._processedRef.add(tag2);

    this.linker.log("verbose", `Processed bridging reference: ${tag2}`);
    let keyEntity1 = entity1.getKeyField();

    if (Array.isArray(keyEntity1)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity1Name}`);
    }

    let keyEntity2 = entity2.getKeyField();

    if (Array.isArray(keyEntity2)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity2Name}`);
    }

    relationEntity.addAssocField(connectedByField, entity1, keyEntity1);
    relationEntity.addAssocField(connectedByField2, entity2, keyEntity2);
    relationEntity.addAssociation(connectedByField, {
      entity: entity1Name
    });
    relationEntity.addAssociation(connectedByField2, {
      entity: entity2Name
    });
    let allCascade = {
      onUpdate: "RESTRICT",
      onDelete: "RESTRICT"
    };

    this._addReference(relationEntityName, connectedByField, entity1Name, keyEntity1.name, allCascade);

    this._addReference(relationEntityName, connectedByField2, entity2Name, keyEntity2.name, allCascade);
  }

  static oolOpToSql(op) {
    switch (op) {
      case "=":
        return "=";

      default:
        throw new Error("oolOpToSql to be implemented.");
    }
  }

  static oolToSql(schema, doc, ool, params) {
    if (!ool.oolType) {
      return ool;
    }

    switch (ool.oolType) {
      case "BinaryExpression":
        let left, right;

        if (ool.left.oolType) {
          left = MySQLModeler.oolToSql(schema, doc, ool.left, params);
        } else {
          left = ool.left;
        }

        if (ool.right.oolType) {
          right = MySQLModeler.oolToSql(schema, doc, ool.right, params);
        } else {
          right = ool.right;
        }

        return left + " " + MySQLModeler.oolOpToSql(ool.operator) + " " + right;

      case "ObjectReference":
        if (!GemlUtils.isMemberAccess(ool.name)) {
          if (params && _.find(params, p => p.name === ool.name) !== -1) {
            return "p" + _.upperFirst(ool.name);
          }

          throw new Error(`Referencing to a non-existing param "${ool.name}".`);
        }

        let {
          entityNode,
          entity,
          field
        } = GemlUtils.parseReferenceInDocument(schema, doc, ool.name);
        return entityNode.alias + "." + MySQLModeler.quoteIdentifier(field.name);

      default:
        throw new Error("oolToSql to be implemented.");
    }
  }

  static _orderByToSql(schema, doc, ool) {
    return MySQLModeler.oolToSql(schema, doc, {
      oolType: "ObjectReference",
      name: ool.field
    }) + (ool.ascend ? "" : " DESC");
  }

  _viewDocumentToSQL(modelingSchema, view) {
    let sql = "  ";

    let doc = _.cloneDeep(view.getDocumentHierarchy(modelingSchema));

    let [colList, alias, joins] = this._buildViewSelect(modelingSchema, doc, 0);

    sql += "SELECT " + colList.join(", ") + " FROM " + MySQLModeler.quoteIdentifier(doc.entity) + " AS " + alias;

    if (!_.isEmpty(joins)) {
      sql += " " + joins.join(" ");
    }

    if (!_.isEmpty(view.selectBy)) {
      sql += " WHERE " + view.selectBy.map(select => MySQLModeler.oolToSql(modelingSchema, doc, select, view.params)).join(" AND ");
    }

    if (!_.isEmpty(view.groupBy)) {
      sql += " GROUP BY " + view.groupBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(", ");
    }

    if (!_.isEmpty(view.orderBy)) {
      sql += " ORDER BY " + view.orderBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(", ");
    }

    let skip = view.skip || 0;

    if (view.limit) {
      sql += " LIMIT " + MySQLModeler.oolToSql(modelingSchema, doc, skip, view.params) + ", " + MySQLModeler.oolToSql(modelingSchema, doc, view.limit, view.params);
    } else if (view.skip) {
      sql += " OFFSET " + MySQLModeler.oolToSql(modelingSchema, doc, view.skip, view.params);
    }

    return sql;
  }

  _createTableStatement(entityName, entity) {
    let sql = "CREATE TABLE IF NOT EXISTS `" + entityName + "` (\n";

    _.each(entity.fields, (field, name) => {
      sql += "  " + MySQLModeler.quoteIdentifier(name) + " " + MySQLModeler.columnDefinition(field) + ",\n";
    });

    sql += "  PRIMARY KEY (" + MySQLModeler.quoteListOrValue(entity.key) + "),\n";

    if (entity.indexes && entity.indexes.length > 0) {
      entity.indexes.forEach(index => {
        sql += "  ";

        if (index.unique) {
          sql += "UNIQUE ";
        }

        sql += "KEY (" + MySQLModeler.quoteListOrValue(index.fields) + "),\n";
      });
    }

    let lines = [];

    this._events.emit("beforeEndColumnDefinition:" + entityName, lines);

    if (lines.length > 0) {
      sql += "  " + lines.join(",\n  ");
    } else {
      sql = sql.substr(0, sql.length - 2);
    }

    sql += "\n)";
    let extraProps = {};

    this._events.emit("setTableOptions:" + entityName, extraProps);

    let props = Object.assign({}, this._dbOptions.table, extraProps);
    sql = _.reduce(props, function (result, value, key) {
      return result + " " + key + "=" + value;
    }, sql);
    sql += ";\n";
    return sql;
  }

  _addForeignKeyStatement(entityName, relation, schemaToConnector) {
    let refTable = relation.right;

    if (refTable.indexOf(".") > 0) {
      let [schemaName, refEntityName] = refTable.split(".");
      let targetConnector = schemaToConnector[schemaName];
      refTable = targetConnector.database + "`.`" + refEntityName;
    }

    let sql = "ALTER TABLE `" + entityName + "` ADD FOREIGN KEY (`" + relation.leftField + "`) " + "REFERENCES `" + refTable + "` (`" + relation.rightField + "`) ";
    sql += `ON UPDATE ${relation.constraints.onUpdate} ON DELETE ${relation.constraints.onDelete};\n`;
    return sql;
  }

  static foreignKeyFieldNaming(entityName, entity) {
    let leftPart = Util._.camelCase(entityName);

    let rightPart = Util.pascalCase(entity.key);

    if (_.endsWith(leftPart, rightPart)) {
      return leftPart;
    }

    return leftPart + rightPart;
  }

  static quoteString(str) {
    return "'" + str.replace(/'/g, "\\'") + "'";
  }

  static quoteIdentifier(str) {
    return "`" + str + "`";
  }

  static quoteListOrValue(obj) {
    return _.isArray(obj) ? obj.map(v => MySQLModeler.quoteIdentifier(v)).join(", ") : MySQLModeler.quoteIdentifier(obj);
  }

  static complianceCheck(entity) {
    let result = {
      errors: [],
      warnings: []
    };

    if (!entity.key) {
      result.errors.push("Primary key is not specified.");
    }

    return result;
  }

  static columnDefinition(field, isProc) {
    let col;

    switch (field.type) {
      case "integer":
        col = MySQLModeler.intColumnDefinition(field);
        break;

      case "number":
        col = MySQLModeler.floatColumnDefinition(field);
        break;

      case "text":
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case "boolean":
        col = MySQLModeler.boolColumnDefinition(field);
        break;

      case "binary":
        col = MySQLModeler.binaryColumnDefinition(field);
        break;

      case "datetime":
        col = MySQLModeler.datetimeColumnDefinition(field);
        break;

      case "object":
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case "enum":
        col = MySQLModeler.enumColumnDefinition(field);
        break;

      case "array":
        col = MySQLModeler.textColumnDefinition(field);
        break;

      default:
        throw new Error('Unsupported type "' + field.type + '".');
    }

    let {
      sql,
      type
    } = col;

    if (!isProc) {
      sql += this.columnNullable(field);
      sql += this.defaultValue(field, type);
    }

    return sql;
  }

  static intColumnDefinition(info) {
    let sql, type;

    if (info.digits) {
      if (info.digits > 10) {
        type = sql = "BIGINT";
      } else if (info.digits > 7) {
        type = sql = "INT";
      } else if (info.digits > 4) {
        type = sql = "MEDIUMINT";
      } else if (info.digits > 2) {
        type = sql = "SMALLINT";
      } else {
        type = sql = "TINYINT";
      }

      sql += `(${info.digits})`;
    } else {
      type = sql = "INT";
    }

    if (info.unsigned) {
      sql += " UNSIGNED";
    }

    return {
      sql,
      type
    };
  }

  static floatColumnDefinition(info) {
    let sql = "",
        type;

    if (info.type == "number" && info.exact) {
      type = sql = "DECIMAL";

      if (info.totalDigits > 65) {
        throw new Error("Total digits exceed maximum limit.");
      }
    } else {
      if (info.totalDigits > 23) {
        type = sql = "DOUBLE";

        if (info.totalDigits > 53) {
          throw new Error("Total digits exceed maximum limit.");
        }
      } else {
        type = sql = "FLOAT";
      }
    }

    if ("totalDigits" in info) {
      sql += "(" + info.totalDigits;

      if ("decimalDigits" in info) {
        sql += ", " + info.decimalDigits;
      }

      sql += ")";
    } else {
      if ("decimalDigits" in info) {
        if (info.decimalDigits > 23) {
          sql += "(53, " + info.decimalDigits + ")";
        } else {
          sql += "(23, " + info.decimalDigits + ")";
        }
      }
    }

    return {
      sql,
      type
    };
  }

  static textColumnDefinition(info) {
    let sql = "",
        type;

    if (info.fixedLength && info.fixedLength <= 255) {
      sql = "CHAR(" + info.fixedLength + ")";
      type = "CHAR";
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = "LONGTEXT";
      } else if (info.maxLength > 65535) {
        type = sql = "MEDIUMTEXT";
      } else if (info.maxLength > 2000) {
        type = sql = "TEXT";
      } else {
        type = sql = "VARCHAR";

        if (info.fixedLength) {
          sql += "(" + info.fixedLength + ")";
        } else {
          sql += "(" + info.maxLength + ")";
        }
      }
    } else {
      type = sql = "TEXT";
    }

    return {
      sql,
      type
    };
  }

  static binaryColumnDefinition(info) {
    let sql = "",
        type;

    if (info.fixedLength <= 255) {
      sql = "BINARY(" + info.fixedLength + ")";
      type = "BINARY";
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = "LONGBLOB";
      } else if (info.maxLength > 65535) {
        type = sql = "MEDIUMBLOB";
      } else {
        type = sql = "VARBINARY";

        if (info.fixedLength) {
          sql += "(" + info.fixedLength + ")";
        } else {
          sql += "(" + info.maxLength + ")";
        }
      }
    } else {
      type = sql = "BLOB";
    }

    return {
      sql,
      type
    };
  }

  static boolColumnDefinition() {
    return {
      sql: "TINYINT(1)",
      type: "TINYINT"
    };
  }

  static datetimeColumnDefinition(info) {
    let sql;

    if (!info.range || info.range === "datetime") {
      sql = "DATETIME";
    } else if (info.range === "date") {
      sql = "DATE";
    } else if (info.range === "time") {
      sql = "TIME";
    } else if (info.range === "year") {
      sql = "YEAR";
    } else if (info.range === "timestamp") {
      sql = "TIMESTAMP";
    }

    return {
      sql,
      type: sql
    };
  }

  static enumColumnDefinition(info) {
    return {
      sql: "ENUM(" + _.map(info.values, v => MySQLModeler.quoteString(v)).join(", ") + ")",
      type: "ENUM"
    };
  }

  static columnNullable(info) {
    if (info.hasOwnProperty("optional") && info.optional) {
      return " NULL";
    }

    return " NOT NULL";
  }

  static defaultValue(info, type) {
    if (info.isCreateTimestamp) {
      info.createByDb = true;
      return " DEFAULT CURRENT_TIMESTAMP";
    }

    if (info.autoIncrementId) {
      info.createByDb = true;
      return " AUTO_INCREMENT";
    }

    if (info.isUpdateTimestamp) {
      info.updateByDb = true;
      return " ON UPDATE CURRENT_TIMESTAMP";
    }

    let sql = "";

    if (!info.optional) {
      if (info.hasOwnProperty("default")) {
        let defaultValue = info["default"];

        if (typeof defaultValue === "object" && defaultValue.oorType === "SymbolToken") {
          const tokenName = defaultValue.name.toUpperCase();

          switch (tokenName) {
            case "NOW":
              sql += " DEFAULT NOW()";
              info.createByDb = true;
              break;

            default:
              throw new Error(`Unsupported symbol token "${tokenName}".`);
          }
        } else {
          switch (info.type) {
            case "boolean":
              sql += " DEFAULT " + (Types.BOOLEAN.sanitize(defaultValue) ? "1" : "0");
              break;

            case "integer":
              if (_.isInteger(defaultValue)) {
                sql += " DEFAULT " + defaultValue.toString();
              } else {
                sql += " DEFAULT " + parseInt(defaultValue).toString();
              }

              break;

            case "text":
            case "enum":
              sql += " DEFAULT " + Util.quote(defaultValue);
              break;

            case "number":
              if (_.isNumber(defaultValue)) {
                sql += " DEFAULT " + defaultValue.toString();
              } else {
                sql += " DEFAULT " + parseFloat(defaultValue).toString();
              }

              break;

            case "binary":
              sql += " DEFAULT " + Util.bin2Hex(defaultValue);
              break;

            case "datetime":
              sql += " DEFAULT " + Util.quote(Types.DATETIME.sanitize(defaultValue).toSQL({
                includeOffset: false
              }));
              break;

            case "object":
            case "array":
              sql += " DEFAULT " + Util.quote(JSON.stringify(defaultValue));
              break;

            default:
              throw new Error(`Invalid type "${info.type}"`);
          }
        }
      } else if (!info.hasOwnProperty("auto")) {
        if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
          return "";
        }

        if (info.type === "boolean" || info.type === "integer" || info.type === "number") {
          sql += " DEFAULT 0";
        } else if (info.type === "datetime") {
          sql += " DEFAULT CURRENT_TIMESTAMP";
        } else if (info.type === "enum") {
          sql += " DEFAULT " + quote(info.values[0]);
          info.createByDb = true;
        } else {
          sql += ' DEFAULT ""';
        }
      }
    }

    return sql;
  }

  static removeTableNamePrefix(entityName, removeTablePrefix) {
    if (removeTablePrefix) {
      entityName = _.trim(_.snakeCase(entityName));
      removeTablePrefix = _.trimEnd(_.snakeCase(removeTablePrefix), "_") + "_";

      if (_.startsWith(entityName, removeTablePrefix)) {
        entityName = entityName.substr(removeTablePrefix.length);
      }
    }

    return GemlUtils.entityNaming(entityName);
  }

}

module.exports = MySQLModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiR2VtbFV0aWxzIiwicGx1cmFsaXplIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwibGlua2VyIiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwib3V0cHV0UGF0aCIsInNjcmlwdFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwic2NoZW1hVG9Db25uZWN0b3IiLCJza2lwR2VuZXJhdGlvbiIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsImdlbWxNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwibm9kZXMiLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsImluaXRJZHhGaWxlcyIsImVudkRhdGEiLCJlbnRpdGllc0RhdGEiLCJpbml0RmlsZU5hbWUiLCJwYXRoTm9kZXMiLCJpbml0RmlsZVBhdGgiLCJpZHhGaWxlUGF0aCIsIkpTT04iLCJzdHJpbmdpZnkiLCJsaXN0IiwiZmlsZVBhdGgiLCJtYW51YWwiLCJleGlzdHNTeW5jIiwibGluZXMiLCJyZWFkRmlsZVN5bmMiLCJzcGxpdCIsImxpbmUiLCJzdGFydHNXaXRoIiwiY29uY2F0IiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJfdG9Db2x1bW5SZWZlcmVuY2UiLCJvb3JUeXBlIiwiX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24iLCJsb2NhbEZpZWxkIiwiYW5jaG9yIiwicmVtb3RlRmllbGQiLCJtYXAiLCJyZiIsInJldCIsImJ5Iiwid2l0aEV4dHJhIiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJ3aXRoIiwiJGFuZCIsIl9nZXRBbGxSZWxhdGVkRmllbGRzIiwidW5kZWZpbmVkIiwic3JjRmllbGQiLCJ0eXBlIiwiZGVzdEVudGl0eSIsImVudGl0eUtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUiLCJkZXN0U2NoZW1hTmFtZSIsImFjdHVhbERlc3RFbnRpdHlOYW1lIiwiZGVzdFNjaGVtYSIsInNjaGVtYXMiLCJsaW5rZWQiLCJlbnN1cmVHZXRFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNiIiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsImhhc0ZlYXR1cmUiLCJkZWxldGlvbkNoZWNrIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsInJpZ2h0IiwicHJlZml4TmFtaW5nIiwiY29ubkJhY2tSZWYxIiwiY29ubkJhY2tSZWYyIiwic3JjIiwiZGVzdCIsImRlc3RGaWVsZE5hbWUiLCJyZWZlcmVuY2VkRmllbGQiLCJ0YWciLCJkZXN0RmllbGQiLCJoYXNGaWVsZCIsImpvaW5PbiIsImFkZEFzc29jRmllbGQiLCJmaWVsZFByb3BzIiwibG9jYWxGaWVsZE9iaiIsImNvbnN0cmFpbnRzIiwiY29uc3RyYWludE9uVXBkYXRlIiwib25VcGRhdGUiLCJjb25zdHJhaW50T25EZWxldGUiLCJvbkRlbGV0ZSIsIm9wdGlvbmFsIiwiX2FkZFJlZmVyZW5jZSIsIm9vbENvbiIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCIkZXEiLCIkbmUiLCJhcmciLCJhcmd1bWVudCIsIiRvciIsImFzS2V5IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImNvbnNvbGUiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsIm9uY2UiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRlcGxveW1lbnRTZXR0aW5ncyIsImRhdGFTb3VyY2UiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MU5hbWUiLCJlbnRpdHkyTmFtZSIsImVudGl0eTFSZWZGaWVsZCIsImVudGl0eTJSZWZGaWVsZCIsImVudGl0eUluZm8iLCJpbmRleGVzIiwidW5pcXVlIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsImFsbENhc2NhZGUiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4Iiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJyZWZFbnRpdHlOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwidG9rZW5OYW1lIiwidG9VcHBlckNhc2UiLCJCT09MRUFOIiwic2FuaXRpemUiLCJpc0ludGVnZXIiLCJ0b1N0cmluZyIsInBhcnNlSW50IiwiaXNOdW1iZXIiLCJwYXJzZUZsb2F0IiwiYmluMkhleCIsIkRBVEVUSU1FIiwidG9TUUwiLCJpbmNsdWRlT2Zmc2V0IiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUVBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFRyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUEsS0FBVDtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBa0NKLElBQXhDOztBQUVBLE1BQU1LLFNBQVMsR0FBR1AsT0FBTyxDQUFDLHlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRVEsRUFBQUEsU0FBRjtBQUFhQyxFQUFBQSxpQkFBYjtBQUFnQ0MsRUFBQUE7QUFBaEMsSUFBMkRILFNBQWpFOztBQUNBLE1BQU1JLE1BQU0sR0FBR1gsT0FBTyxDQUFDLHNCQUFELENBQXRCOztBQUNBLE1BQU07QUFBRVksRUFBQUE7QUFBRixJQUFZWixPQUFPLENBQUMsWUFBRCxDQUF6Qjs7QUFFQSxNQUFNYSx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMsTUFBVCxFQUFpQixNQUFqQixFQUF5QixVQUF6QixDQUFSLENBQWxDOztBQU1BLE1BQU1DLFlBQU4sQ0FBbUI7QUFTZkMsRUFBQUEsV0FBVyxDQUFDQyxPQUFELEVBQVVDLE1BQVYsRUFBa0JDLFNBQWxCLEVBQTZCQyxTQUE3QixFQUF3QztBQUMvQyxTQUFLRixNQUFMLEdBQWNBLE1BQWQ7QUFDQSxTQUFLRyxVQUFMLEdBQWtCSixPQUFPLENBQUNLLFVBQTFCO0FB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LFNBQUYsQ0FBWUYsaUJBQVosQ0FBVixFQUEwQyxHQUExQyxJQUFpRCxHQUFyRTs7QUFFQSxVQUFJblcsQ0FBQyxDQUFDeUgsVUFBRixDQUFhN0UsVUFBYixFQUF5QnVULGlCQUF6QixDQUFKLEVBQWlEO0FBQzdDdlQsUUFBQUEsVUFBVSxHQUFHQSxVQUFVLENBQUNpUSxNQUFYLENBQWtCc0QsaUJBQWlCLENBQUN4VCxNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPdkMsU0FBUyxDQUFDb0ssWUFBVixDQUF1QjVILFVBQXZCLENBQVA7QUFDSDs7QUF2eERjOztBQTB4RG5CMlQsTUFBTSxDQUFDQyxPQUFQLEdBQWlCNVYsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZShcImV2ZW50c1wiKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKFwicGF0aFwiKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlLCBwdXRJbnRvQnVja2V0IH0gPSBVdGlsO1xuXG5jb25zdCBHZW1sVXRpbHMgPSByZXF1aXJlKFwiLi4vLi4vLi4vbGFuZy9HZW1sVXRpbHNcIik7XG5jb25zdCB7IHBsdXJhbGl6ZSwgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUgfSA9IEdlbWxVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoXCIuLi8uLi8uLi9sYW5nL0VudGl0eVwiKTtcbmNvbnN0IHsgVHlwZXMgfSA9IHJlcXVpcmUoXCJAZ2VueC9kYXRhXCIpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbXCJCTE9CXCIsIFwiVEVYVFwiLCBcIkpTT05cIiwgXCJHRU9NRVRSWVwiXSk7XG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgbGlua2VyLCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxpbmtlciA9IGxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hLCBzY2hlbWFUb0Nvbm5lY3Rvciwgc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgaWYgKCFza2lwR2VuZXJhdGlvbikge1xuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImRlYnVnXCIsIFwiQnVpbGRpbmcgcmVsYXRpb25zLi4uXCIpO1xuXG4gICAgICAgIGxldCBwZW5kaW5nRW50aXRpZXMgPSBPYmplY3Qua2V5cyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgd2hpbGUgKHBlbmRpbmdFbnRpdGllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZXQgZW50aXR5TmFtZSA9IHBlbmRpbmdFbnRpdGllcy5zaGlmdCgpO1xuICAgICAgICAgICAgbGV0IGVudGl0eSA9IG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzW2VudGl0eU5hbWVdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiZGVidWdcIiwgYFByb2Nlc3NpbmcgYXNzb2NpYXRpb25zIG9mIGVudGl0eSBcIiR7ZW50aXR5TmFtZX1cIi4uLmApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jcyA9IHRoaXMuX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KTtcblxuICAgICAgICAgICAgICAgIGxldCBhc3NvY05hbWVzID0gYXNzb2NzLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHY7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfSwge30pO1xuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goKGFzc29jKSA9PlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoXCJhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nXCIpO1xuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKFwibXlzcWxcIiwgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgXCJlbnRpdGllcy5zcWxcIik7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCBcInJlbGF0aW9ucy5zcWxcIik7XG5cbiAgICAgICAgbGV0IHRhYmxlU1FMID0gXCJcIixcbiAgICAgICAgICAgIHJlbGF0aW9uU1FMID0gXCJcIixcbiAgICAgICAgICAgIGRhdGEgPSB7fTtcblxuICAgICAgICAvL2xldCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGVudGl0eU5hbWUgPT09IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgLy9tYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lW2VudGl0eU5hbWVdID0gZW50aXR5LmNvZGU7XG5cbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9IFwiXCI7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gXCJXYXJuaW5nczogXFxuXCIgKyByZXN1bHQud2FybmluZ3Muam9pbihcIlxcblwiKSArIFwiXFxuXCI7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKFwiXFxuXCIpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaCgoZmYpID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkgLyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykgKyBcIlxcblwiO1xuXG4gICAgICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKCh7IGRhdGFTZXQsIHJ1bnRpbWVFbnYsIHJlY29yZHMgfSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlY29yZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKChyZWNvcmQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IGVudGl0eS5maWVsZHNbZmllbGRzWzBdXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFrZXlGaWVsZC5hdXRvICYmICFrZXlGaWVsZC5kZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBrZXkgZmllbGQgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBubyBkZWZhdWx0IHZhbHVlIG9yIGF1dG8tZ2VuZXJhdGVkIHZhbHVlLmBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkuZ2VtbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5LmdlbWxNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24ocmVjb3JkcywgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW2VudGl0eS5rZXldOiBrZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5nZW1sTW9kdWxlLCByZWNvcmQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBbZW50aXR5LmtleV06IGtleSB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5nZW1sTW9kdWxlLCByZWNvcmQpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhU2V0IHx8IChkYXRhU2V0ID0gXCJfaW5pdFwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW50aW1lRW52IHx8IChydW50aW1lRW52ID0gXCJkZWZhdWx0XCIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG5vZGVzID0gW2RhdGFTZXQsIHJ1bnRpbWVFbnZdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXkgPSBub2Rlcy5qb2luKFwiLlwiKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHB1dEludG9CdWNrZXQoZGF0YSwga2V5LCBlbnRpdHlEYXRhLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKCFza2lwR2VuZXJhdGlvbikge1xuICAgICAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBfLmVhY2gocmVmcywgKHJlZikgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlZixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzY2hlbWFUb0Nvbm5lY3RvciAvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovXG4gICAgICAgICAgICAgICAgICAgICAgICApICsgXCJcXG5cIjtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgICAgICBsZXQgaW5pdElkeEZpbGVzID0ge307XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZGF0YSwgKGVudkRhdGEsIGRhdGFTZXQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW52RGF0YSwgKGVudGl0aWVzRGF0YSwgcnVudGltZUVudikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXRpZXNEYXRhLCAocmVjb3JkcywgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbml0RmlsZU5hbWUgPSBgMC0ke2VudGl0eU5hbWV9Lmpzb25gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHBhdGhOb2RlcyA9IFtzcWxGaWxlc0RpciwgXCJkYXRhXCIsIGRhdGFTZXQgfHwgXCJfaW5pdFwiXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChydW50aW1lRW52ICE9PSBcImRlZmF1bHRcIikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXRoTm9kZXMucHVzaChydW50aW1lRW52KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKC4uLnBhdGhOb2RlcywgaW5pdEZpbGVOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCBcImluZGV4Lmxpc3RcIik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGluaXRJZHhGaWxlcywgW2lkeEZpbGVQYXRoXSwgaW5pdEZpbGVOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoeyBbZW50aXR5TmFtZV06IHJlY29yZHMgfSwgbnVsbCwgNClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL2NvbnNvbGUuZGlyKGluaXRJZHhGaWxlcywge2RlcHRoOiAxMH0pO1xuXG4gICAgICAgICAgICBfLmZvck93bihpbml0SWR4RmlsZXMsIChsaXN0LCBmaWxlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgICAgIGxldCBtYW51YWwgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGlkeEZpbGVQYXRoKSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMoaWR4RmlsZVBhdGgsIFwidXRmOFwiKS5zcGxpdChcIlxcblwiKTtcbiAgICAgICAgICAgICAgICAgICAgbGluZXMuZm9yRWFjaCgobGluZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoXCIwLVwiKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1hbnVhbC5wdXNoKGxpbmUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUoaWR4RmlsZVBhdGgsIGxpc3QuY29uY2F0KG1hbnVhbCkuam9pbihcIlxcblwiKSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IGZ1bmNTUUwgPSBcIlwiO1xuXG4gICAgICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgXCJwcm9jZWR1cmVzLnNxbFwiKTtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfVxuXG4gICAgX3RvQ29sdW1uUmVmZXJlbmNlKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHsgb29yVHlwZTogXCJDb2x1bW5SZWZlcmVuY2VcIiwgbmFtZSB9O1xuICAgIH1cblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKChyZikgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyBcIi5cIiArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG5cbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFtyZXQsIHdpdGhFeHRyYV0gfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgXCIuXCIgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcCgocmYpID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KSB7XG4gICAgICAgIHJldHVybiBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMubWFwKChhc3NvYykgPT4ge1xuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSBcImhhc01hbnlcIikge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUb1xuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2J5XSBbd2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogcmVmZXJzVG8gLSBzZW1pIGNvbm5lY3Rpb25cbiAgICAgKlxuICAgICAqIHJlbW90ZUZpZWxkOlxuICAgICAqICAgMS4gZmllbGROYW1lXG4gICAgICogICAyLiBhcnJheSBvZiBmaWVsZE5hbWVcbiAgICAgKiAgIDMuIHsgYnkgLCB3aXRoIH1cbiAgICAgKiAgIDQuIGFycmF5IG9mIGZpZWxkTmFtZSBhbmQgeyBieSAsIHdpdGggfSBtaXhlZFxuICAgICAqXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWFcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJkZWJ1Z1wiLCBgUHJvY2Vzc2luZyBcIiR7ZW50aXR5Lm5hbWV9XCIgJHtKU09OLnN0cmluZ2lmeShhc3NvYyl9YCk7XG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSxcbiAgICAgICAgICAgIGRlc3RFbnRpdHksXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgW2Rlc3RTY2hlbWFOYW1lLCBhY3R1YWxEZXN0RW50aXR5TmFtZV0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlc3RTY2hlbWEgPSBzY2hlbWEubGlua2VyLnNjaGVtYXNbZGVzdFNjaGVtYU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFkZXN0U2NoZW1hLmxpbmtlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYFRoZSBkZXN0aW5hdGlvbiBzY2hlbWEgJHtkZXN0U2NoZW1hTmFtZX0gaGFzIG5vdCBiZWVuIGxpbmtlZCB5ZXQuIEN1cnJlbnRseSBvbmx5IHN1cHBvcnQgb25lLXdheSByZWZlcmVuY2UgZm9yIGNyb3NzIGRiIHJlbGF0aW9uLmBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07XG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gYWN0dWFsRGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkuZ2VtbE1vZHVsZSwgZGVzdEVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQsXG4gICAgICAgICAgICBgRW1wdHkga2V5IGZpZWxkIFwiJHtkZXN0RW50aXR5LmtleUZpZWxkfVwiLiBEZXN0IGVudGl0eTogJHtkZXN0RW50aXR5TmFtZX0sIGN1cnJlbnQgZW50aXR5OiAke2VudGl0eS5uYW1lfWA7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSBcImhhc09uZVwiOlxuICAgICAgICAgICAgY2FzZSBcImhhc01hbnlcIjpcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7XG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0ge1xuICAgICAgICAgICAgICAgICAgICB0eXBlczogW1wicmVmZXJzVG9cIl0sXG4gICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uOiBhc3NvYyxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goXCJiZWxvbmdzVG9cIik7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgYnk6IChjYikgPT4gY2IgJiYgY2Iuc3BsaXQoXCIuXCIpWzBdID09PSBhc3NvYy5ieS5zcGxpdChcIi5cIilbMF0sXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLndpdGggPSBhc3NvYy53aXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IChyZW1vdGVGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkIHx8IChyZW1vdGVGaWVsZCA9IGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHJlbW90ZUZpZWxkcy5pbmRleE9mKHJlbW90ZUZpZWxkKSA+IC0xXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09IFwiaGFzTWFueVwiIHx8IGJhY2tSZWYudHlwZSA9PT0gXCJoYXNPbmVcIikge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ1wibTJuXCIgYXNzb2NpYXRpb24gcmVxdWlyZXMgXCJieVwiIHByb3BlcnR5LiBFbnRpdHk6ICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5Lm5hbWUgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCIgZGVzdGluYXRpb246IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb25lL21hbnkgdG8gb25lL21hbnkgcmVsYXRpb25cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieS5zcGxpdChcIi5cIik7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IEdlbWxVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7YXNzb2MudHlwZSA9PT0gXCJoYXNNYW55XCIgPyBcIm1cIiA6IFwiMVwifS0ke2Rlc3RFbnRpdHlOYW1lfToke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYudHlwZSA9PT0gXCJoYXNNYW55XCIgPyBcIm5cIiA6IFwiMVwiXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7YmFja1JlZi50eXBlID09PSBcImhhc01hbnlcIiA/IFwibVwiIDogXCIxXCJ9LSR7ZW50aXR5Lm5hbWV9OiR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MudHlwZSA9PT0gXCJoYXNNYW55XCIgPyBcIm5cIiA6IFwiMVwiXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSBcIiBcIiArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gXCIgXCIgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5ieS5zcGxpdChcIi5cIik7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5LmdlbWxNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJkZWJ1Z1wiLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKGxvY2FsRmllbGROYW1lLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gXCJoYXNNYW55XCIgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihyZW1vdGVGaWVsZE5hbWUsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBiYWNrUmVmLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSBcImhhc01hbnlcIiA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJ2ZXJib3NlXCIsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJ2ZXJib3NlXCIsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSBcImJlbG9uZ3NUb1wiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ0b2RvOiBiZWxvbmdzVG8gYnkuIGVudGl0eTogXCIgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLnNyY0ZpZWxkIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChhc3NvYy50eXBlID09PSBcImhhc01hbnlcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vY2hlY2sgaWYgdGhlIHRhcmdldCBlbnRpdHkgaGFzIGxvZ2ljYWwgZGVsZXRpb24gZmVhdHVyZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5Lmhhc0ZlYXR1cmUoXCJsb2dpY2FsRGVsZXRpb25cIikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGRlbGV0aW9uQ2hlY2sgPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiBcIkJpbmFyeUV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcIiE9XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogXCJPYmplY3RSZWZlcmVuY2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBgJHtkZXN0RW50aXR5TmFtZX0uJHtkZXN0RW50aXR5LmZlYXR1cmVzW1wibG9naWNhbERlbGV0aW9uXCJdLmZpZWxkfWAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogXCJMb2dpY2FsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcImFuZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IHJlbW90ZUZpZWxkLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IGRlbGV0aW9uQ2hlY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogXCJMb2dpY2FsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcImFuZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IGFzc29jLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IGRlbGV0aW9uQ2hlY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IGRlbGV0aW9uQ2hlY2s7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oYW5jaG9yLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBhbmNob3IgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IHJlbW90ZUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSBcInN0cmluZ1wiID8geyBmaWVsZDogcmVtb3RlRmllbGQgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09IFwiaGFzTWFueVwiID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJVbmV4cGVjdGVkIHBhdGguIEVudGl0eTogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkubmFtZSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiLCBhc3NvY2lhdGlvbjogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMilcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBzZW1pIGFzc29jaWF0aW9uXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieVxuICAgICAgICAgICAgICAgICAgICAgICAgPyBhc3NvYy5ieS5zcGxpdChcIi5cIilcbiAgICAgICAgICAgICAgICAgICAgICAgIDogW0dlbWxVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKV07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IEdlbWxVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfToke1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MudHlwZSA9PT0gXCJoYXNNYW55XCIgPyBcIm1cIiA6IFwiMVwiXG4gICAgICAgICAgICAgICAgICAgIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9IFwiIFwiICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkuZ2VtbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWVcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiZGVidWdcIiwgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogZ2V0IGJhY2sgcmVmIGZyb20gY29ubmVjdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMSA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtlbnRpdHkubmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7IHR5cGU6IFwicmVmZXJzVG9cIiB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuIERldGFpbDogJyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiBhc3NvYy5zcmNGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KFxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihsb2NhbEZpZWxkTmFtZSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLmFzc29jTmFtZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtkZXN0RW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lICsgXCIuXCIgKyBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gXCJoYXNNYW55XCIgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwidmVyYm9zZVwiLCBgUHJvY2Vzc2VkIDEtd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlIFwicmVmZXJzVG9cIjpcbiAgICAgICAgICAgIGNhc2UgXCJiZWxvbmdzVG9cIjpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGRlc3RGaWVsZE5hbWUgPSBkZXN0S2V5RmllbGQubmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgcmVmZXJlbmNlZEZpZWxkID0gZGVzdEtleUZpZWxkO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09IFwicmVmZXJzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnID0gYCR7ZW50aXR5Lm5hbWV9OjEtJHtkZXN0RW50aXR5TmFtZX06KiAke2xvY2FsRmllbGR9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuZGVzdEZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkuaGFzRmllbGQoYXNzb2MuZGVzdEZpZWxkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYFRoZSBmaWVsZCBcIiR7YXNzb2MuZGVzdEZpZWxkfVwiIGJlaW5nIHJlZmVyZW5jZWQgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEZpZWxkTmFtZSA9IGFzc29jLmRlc3RGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RFbnRpdHkuZmllbGRzW2Rlc3RGaWVsZE5hbWVdO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGFnICs9IFwiLT5cIiArIGFzc29jLmRlc3RGaWVsZDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkIGJ5IGNvbm5lY3Rpb24sIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwidmVyYm9zZVwiLCBgUHJvY2Vzc2VkIHdlZWsgcmVmZXJlbmNlOiAke3RhZ31gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgam9pbk9uID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyBcIi5cIiArIGRlc3RGaWVsZE5hbWUpIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICAgICAgICAgICAgICAgICAgam9pbk9uLFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGxvY2FsRmllbGQgfSwgYXNzb2Mud2l0aClcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCByZWZlcmVuY2VkRmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihsb2NhbEZpZWxkLCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgIGZpZWxkOiBkZXN0RmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICBvbjogam9pbk9uLFxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgLy9mb3JlaWduIGtleSBjb25zdHJhaXRzXG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGRPYmogPSBlbnRpdHkuZmllbGRzW2xvY2FsRmllbGRdO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNvbnN0cmFpbnRzID0ge307XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gXCJiZWxvbmdzVG9cIikge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSBcIkNBU0NBREVcIik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9IFwiQ0FTQ0FERVwiKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGxvY2FsRmllbGRPYmoub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gXCJTRVQgTlVMTFwiKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gXCJTRVQgTlVMTFwiKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSBcIk5PIEFDVElPTlwiKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSBcIk5PIEFDVElPTlwiKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RGaWVsZE5hbWUsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gXCJCaW5hcnlFeHByZXNzaW9uXCIpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09IFwiPT1cIikge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09IFwiT2JqZWN0UmVmZXJlbmNlXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSBcIk9iamVjdFJlZmVyZW5jZVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAkZXE6IHJpZ2h0IH0sXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9wZXJhdG9yID09PSBcIiE9XCIpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSBcIk9iamVjdFJlZmVyZW5jZVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gXCJPYmplY3RSZWZlcmVuY2VcIikge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJG5lOiByaWdodCB9LFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09IFwiVW5hcnlFeHByZXNzaW9uXCIpIHtcbiAgICAgICAgICAgIGxldCBhcmc7XG5cbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSBcImlzLW51bGxcIjpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09IFwiT2JqZWN0UmVmZXJlbmNlXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJGVxOiBudWxsIH0sXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBjYXNlIFwiaXMtbm90LW51bGxcIjpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09IFwiT2JqZWN0UmVmZXJlbmNlXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJG5lOiBudWxsIH0sXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIFVuYXJ5RXhwcmVzc2lvbiBvcGVyYXRvcjogXCIgKyBvb2xDb24ub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSBcIkxvZ2ljYWxFeHByZXNzaW9uXCIpIHtcbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSBcImFuZFwiOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgJGFuZDogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBjYXNlIFwib3JcIjpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICRvcjogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIHN5bnRheDogXCIgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFtiYXNlLCAuLi5vdGhlcl0gPSByZWYuc3BsaXQoXCIuXCIpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gW3RyYW5zbGF0ZWQsIC4uLm90aGVyXS5qb2luKFwiLlwiKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2goKGxmKSA9PiB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGYsIHJpZ2h0LCByaWdodEZpZWxkLCBjb25zdHJhaW50cykpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLmJ5LCByaWdodC5yaWdodEZpZWxkLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBsZWZ0RmllbGQgPT09IFwic3RyaW5nXCI7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQoXG4gICAgICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIChpdGVtKSA9PiBpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKGZvdW5kKSByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7IGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzIH0pO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSwgKGl0ZW0pID0+IGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSwgKGl0ZW0pID0+IGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LCAoaXRlbSkgPT4gaXRlbS5yaWdodCA9PT0gcmlnaHQpO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LCAoaXRlbSkgPT4gaXRlbS5yaWdodCA9PT0gcmlnaHQpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgXCJhdXRvSWRcIjpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gXCJpbnRlZ2VyXCIgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoXCJzdGFydEZyb21cIiBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub25jZShcInNldFRhYmxlT3B0aW9uczpcIiArIGVudGl0eS5uYW1lLCAoZXh0cmFPcHRzKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzW1wiQVVUT19JTkNSRU1FTlRcIl0gPSBmZWF0dXJlLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlIFwiY3JlYXRlVGltZXN0YW1wXCI6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcInVwZGF0ZVRpbWVzdGFtcFwiOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgXCJ1c2VyRWRpdFRyYWNraW5nXCI6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgXCJsb2dpY2FsRGVsZXRpb25cIjpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcImF0TGVhc3RPbmVOb3ROdWxsXCI6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgXCJ2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb25cIjpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcInN0YXRlVHJhY2tpbmdcIjpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcImkxOG5cIjpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcImNoYW5nZUxvZ1wiOlxuICAgICAgICAgICAgICAgIGxldCBjaGFuZ2VMb2dTZXR0aW5ncyA9IFV0aWwuZ2V0VmFsdWVCeVBhdGgoc2NoZW1hLmRlcGxveW1lbnRTZXR0aW5ncywgXCJmZWF0dXJlcy5jaGFuZ2VMb2dcIik7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBNaXNzaW5nIFwiY2hhbmdlTG9nXCIgZmVhdHVyZSBzZXR0aW5ncyBpbiBkZXBsb3ltZW50IGNvbmZpZyBmb3Igc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MuZGF0YVNvdXJjZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY2hhbmdlTG9nLmRhdGFTb3VyY2VcIiBpcyByZXF1aXJlZC4gU2NoZW1hOiAke3NjaGVtYS5uYW1lfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oZmVhdHVyZSwgY2hhbmdlTG9nU2V0dGluZ3MpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGRiIHNjcmlwdDogXCIgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KFxuICAgICAgICBzY2hlbWEsXG4gICAgICAgIHJlbGF0aW9uRW50aXR5TmFtZSxcbiAgICAgICAgZW50aXR5MU5hbWUgLyogZm9yIGNyb3NzIGRiICovLFxuICAgICAgICBlbnRpdHkyTmFtZSAvKiBmb3IgY3Jvc3MgZGIgKi8sXG4gICAgICAgIGVudGl0eTFSZWZGaWVsZCxcbiAgICAgICAgZW50aXR5MlJlZkZpZWxkXG4gICAgKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFtcImF1dG9JZFwiLCBcImNyZWF0ZVRpbWVzdGFtcFwiXSxcbiAgICAgICAgICAgIGluZGV4ZXM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkczogW2VudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkXSxcbiAgICAgICAgICAgICAgICAgICAgdW5pcXVlOiB0cnVlLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHk6IGVudGl0eTFOYW1lLFxuICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogZW50aXR5MVJlZkZpZWxkLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHk6IGVudGl0eTJOYW1lLFxuICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogZW50aXR5MlJlZkZpZWxkLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5nZW1sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKlxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHlcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTJcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyTmFtZVxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgKi9cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkoXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LFxuICAgICAgICBlbnRpdHkxLFxuICAgICAgICBlbnRpdHkyLFxuICAgICAgICBlbnRpdHkxTmFtZSAvKiBmb3IgY3Jvc3MgZGIgKi8sXG4gICAgICAgIGVudGl0eTJOYW1lIC8qIGZvciBjcm9zcyBkYiAqLyxcbiAgICAgICAgY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgY29ubmVjdGVkQnlGaWVsZDJcbiAgICApIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIC8vIGNoZWNrIGlmIHRoZSByZWxhdGlvbiBlbnRpdHkgaGFzIHRoZSByZWZlcnNUbyBib3RoIHNpZGUgb2YgYXNzb2NpYXRpb25zXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsXG4gICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7XG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgKGFzc29jKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgICBhc3NvYy50eXBlID09PSBcInJlZmVyc1RvXCIgJiZcbiAgICAgICAgICAgICAgICAgICAgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5MU5hbWUgJiZcbiAgICAgICAgICAgICAgICAgICAgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTFOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgYXNzb2MudHlwZSA9PT0gXCJyZWZlcnNUb1wiICYmXG4gICAgICAgICAgICAgICAgICAgIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTJOYW1lICYmXG4gICAgICAgICAgICAgICAgICAgIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgLy95ZXMsIGRvbid0IG5lZWQgdG8gYWRkIHJlZmVyc1RvIHRvIHRoZSByZWxhdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdGFnMSA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTFOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZH1gO1xuICAgICAgICBsZXQgdGFnMiA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTJOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZDJ9YDtcblxuICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSkge1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpO1xuXG4gICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJ2ZXJib3NlXCIsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG5cbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTtcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKFwidmVyYm9zZVwiLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcyfWApO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MU5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTJOYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBrZXlFbnRpdHkxKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Miwga2V5RW50aXR5Mik7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oY29ubmVjdGVkQnlGaWVsZCwgeyBlbnRpdHk6IGVudGl0eTFOYW1lIH0pO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihjb25uZWN0ZWRCeUZpZWxkMiwgeyBlbnRpdHk6IGVudGl0eTJOYW1lIH0pO1xuXG4gICAgICAgIGxldCBhbGxDYXNjYWRlID0geyBvblVwZGF0ZTogXCJSRVNUUklDVFwiLCBvbkRlbGV0ZTogXCJSRVNUUklDVFwiIH07XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSwgYWxsQ2FzY2FkZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlIFwiPVwiOlxuICAgICAgICAgICAgICAgIHJldHVybiBcIj1cIjtcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLlwiKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBvb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLCBwYXJhbXMpIHtcbiAgICAgICAgaWYgKCFvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9vbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAob29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgXCJCaW5hcnlFeHByZXNzaW9uXCI6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgXCIgXCIgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgXCIgXCIgKyByaWdodDtcblxuICAgICAgICAgICAgY2FzZSBcIk9iamVjdFJlZmVyZW5jZVwiOlxuICAgICAgICAgICAgICAgIGlmICghR2VtbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIChwKSA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBcInBcIiArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBHZW1sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArIFwiLlwiICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC5cIik7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogXCJPYmplY3RSZWZlcmVuY2VcIiwgbmFtZTogb29sLmZpZWxkIH0pICtcbiAgICAgICAgICAgIChvb2wuYXNjZW5kID8gXCJcIiA6IFwiIERFU0NcIilcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9IFwiICBcIjtcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgW2NvbExpc3QsIGFsaWFzLCBqb2luc10gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG5cbiAgICAgICAgc3FsICs9IFwiU0VMRUNUIFwiICsgY29sTGlzdC5qb2luKFwiLCBcIikgKyBcIiBGUk9NIFwiICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArIFwiIEFTIFwiICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gXCIgXCIgKyBqb2lucy5qb2luKFwiIFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz1cbiAgICAgICAgICAgICAgICBcIiBXSEVSRSBcIiArXG4gICAgICAgICAgICAgICAgdmlldy5zZWxlY3RCeVxuICAgICAgICAgICAgICAgICAgICAubWFwKChzZWxlY3QpID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSlcbiAgICAgICAgICAgICAgICAgICAgLmpvaW4oXCIgQU5EIFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPVxuICAgICAgICAgICAgICAgIFwiIEdST1VQIEJZIFwiICtcbiAgICAgICAgICAgICAgICB2aWV3Lmdyb3VwQnkubWFwKChjb2wpID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oXCIsIFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPVxuICAgICAgICAgICAgICAgIFwiIE9SREVSIEJZIFwiICtcbiAgICAgICAgICAgICAgICB2aWV3Lm9yZGVyQnkubWFwKChjb2wpID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oXCIsIFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz1cbiAgICAgICAgICAgICAgICBcIiBMSU1JVCBcIiArXG4gICAgICAgICAgICAgICAgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArXG4gICAgICAgICAgICAgICAgXCIsIFwiICtcbiAgICAgICAgICAgICAgICBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9IFwiIE9GRlNFVCBcIiArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgLypcbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH0qL1xuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSAvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCBzcWwgPSBcIkNSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGBcIiArIGVudGl0eU5hbWUgKyBcImAgKFxcblwiO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSBcIiAgXCIgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgXCIgXCIgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyBcIixcXG5cIjtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gXCIgIFBSSU1BUlkgS0VZIChcIiArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgXCIpLFxcblwiO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaCgoaW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gXCIgIFwiO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9IFwiVU5JUVVFIFwiO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gXCJLRVkgKFwiICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArIFwiKSxcXG5cIjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KFwiYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjpcIiArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSBcIiAgXCIgKyBsaW5lcy5qb2luKFwiLFxcbiAgXCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoIC0gMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gXCJcXG4pXCI7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KFwic2V0VGFibGVPcHRpb25zOlwiICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UoXG4gICAgICAgICAgICBwcm9wcyxcbiAgICAgICAgICAgIGZ1bmN0aW9uIChyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgXCIgXCIgKyBrZXkgKyBcIj1cIiArIHZhbHVlO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHNxbFxuICAgICAgICApO1xuXG4gICAgICAgIHNxbCArPSBcIjtcXG5cIjtcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uLCBzY2hlbWFUb0Nvbm5lY3RvciAvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCByZWZUYWJsZSA9IHJlbGF0aW9uLnJpZ2h0O1xuXG4gICAgICAgIGlmIChyZWZUYWJsZS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbc2NoZW1hTmFtZSwgcmVmRW50aXR5TmFtZV0gPSByZWZUYWJsZS5zcGxpdChcIi5cIik7XG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRDb25uZWN0b3IgPSBzY2hlbWFUb0Nvbm5lY3RvcltzY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGFzc2VydDogdGFyZ2V0Q29ubmVjdG9yO1xuXG4gICAgICAgICAgICByZWZUYWJsZSA9IHRhcmdldENvbm5lY3Rvci5kYXRhYmFzZSArIFwiYC5gXCIgKyByZWZFbnRpdHlOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9XG4gICAgICAgICAgICBcIkFMVEVSIFRBQkxFIGBcIiArXG4gICAgICAgICAgICBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgIFwiYCBBREQgRk9SRUlHTiBLRVkgKGBcIiArXG4gICAgICAgICAgICByZWxhdGlvbi5sZWZ0RmllbGQgK1xuICAgICAgICAgICAgXCJgKSBcIiArXG4gICAgICAgICAgICBcIlJFRkVSRU5DRVMgYFwiICtcbiAgICAgICAgICAgIHJlZlRhYmxlICtcbiAgICAgICAgICAgIFwiYCAoYFwiICtcbiAgICAgICAgICAgIHJlbGF0aW9uLnJpZ2h0RmllbGQgK1xuICAgICAgICAgICAgXCJgKSBcIjtcblxuICAgICAgICBzcWwgKz0gYE9OIFVQREFURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uVXBkYXRlfSBPTiBERUxFVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vbkRlbGV0ZX07XFxuYDtcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopXG4gICAgICAgICAgICA/IG9iai5tYXAoKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oXCIsIFwiKVxuICAgICAgICAgICAgOiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goXCJQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLlwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSBcImludGVnZXJcIjpcbiAgICAgICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgXCJudW1iZXJcIjpcbiAgICAgICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcInRleHRcIjpcbiAgICAgICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlIFwiYm9vbGVhblwiOlxuICAgICAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgXCJiaW5hcnlcIjpcbiAgICAgICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgXCJkYXRldGltZVwiOlxuICAgICAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlIFwib2JqZWN0XCI6XG4gICAgICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSBcImVudW1cIjpcbiAgICAgICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlIFwiYXJyYXlcIjpcbiAgICAgICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7XG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiQklHSU5UXCI7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSBcIklOVFwiO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gXCJNRURJVU1JTlRcIjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiU01BTExJTlRcIjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiVElOWUlOVFwiO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiSU5UXCI7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9IFwiIFVOU0lHTkVEXCI7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9IFwiXCIsXG4gICAgICAgICAgICB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gXCJudW1iZXJcIiAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gXCJERUNJTUFMXCI7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSBcIkRPVUJMRVwiO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiRkxPQVRcIjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChcInRvdGFsRGlnaXRzXCIgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9IFwiKFwiICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmIChcImRlY2ltYWxEaWdpdHNcIiBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9IFwiLCBcIiArIGluZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSBcIilcIjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChcImRlY2ltYWxEaWdpdHNcIiBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIig1MywgXCIgKyBpbmZvLmRlY2ltYWxEaWdpdHMgKyBcIilcIjtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIoMjMsIFwiICsgaW5mby5kZWNpbWFsRGlnaXRzICsgXCIpXCI7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9IFwiXCIsXG4gICAgICAgICAgICB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSBcIkNIQVIoXCIgKyBpbmZvLmZpeGVkTGVuZ3RoICsgXCIpXCI7XG4gICAgICAgICAgICB0eXBlID0gXCJDSEFSXCI7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiTE9OR1RFWFRcIjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSBcIk1FRElVTVRFWFRcIjtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiVEVYVFwiO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gXCJWQVJDSEFSXCI7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9IFwiKFwiICsgaW5mby5maXhlZExlbmd0aCArIFwiKVwiO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIihcIiArIGluZm8ubWF4TGVuZ3RoICsgXCIpXCI7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9IFwiVEVYVFwiO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gXCJcIixcbiAgICAgICAgICAgIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSBcIkJJTkFSWShcIiArIGluZm8uZml4ZWRMZW5ndGggKyBcIilcIjtcbiAgICAgICAgICAgIHR5cGUgPSBcIkJJTkFSWVwiO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSBcIkxPTkdCTE9CXCI7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gXCJNRURJVU1CTE9CXCI7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSBcIlZBUkJJTkFSWVwiO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIihcIiArIGluZm8uZml4ZWRMZW5ndGggKyBcIilcIjtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIoXCIgKyBpbmZvLm1heExlbmd0aCArIFwiKVwiO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSBcIkJMT0JcIjtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiBcIlRJTllJTlQoMSlcIiwgdHlwZTogXCJUSU5ZSU5UXCIgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gXCJkYXRldGltZVwiKSB7XG4gICAgICAgICAgICBzcWwgPSBcIkRBVEVUSU1FXCI7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gXCJkYXRlXCIpIHtcbiAgICAgICAgICAgIHNxbCA9IFwiREFURVwiO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09IFwidGltZVwiKSB7XG4gICAgICAgICAgICBzcWwgPSBcIlRJTUVcIjtcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSBcInllYXJcIikge1xuICAgICAgICAgICAgc3FsID0gXCJZRUFSXCI7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gXCJ0aW1lc3RhbXBcIikge1xuICAgICAgICAgICAgc3FsID0gXCJUSU1FU1RBTVBcIjtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiBcIkVOVU0oXCIgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbihcIiwgXCIpICsgXCIpXCIsIHR5cGU6IFwiRU5VTVwiIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoXCJvcHRpb25hbFwiKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gXCIgTlVMTFwiO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFwiIE5PVCBOVUxMXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuIFwiIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVBcIjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiBcIiBBVVRPX0lOQ1JFTUVOVFwiO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gXCIgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QXCI7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gXCJcIjtcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KFwiZGVmYXVsdFwiKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvW1wiZGVmYXVsdFwiXTtcblxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSBcIm9iamVjdFwiICYmIGRlZmF1bHRWYWx1ZS5vb3JUeXBlID09PSBcIlN5bWJvbFRva2VuXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdG9rZW5OYW1lID0gZGVmYXVsdFZhbHVlLm5hbWUudG9VcHBlckNhc2UoKTtcblxuICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKHRva2VuTmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSBcIk5PV1wiOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIiBERUZBVUxUIE5PVygpXCI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHN5bWJvbCB0b2tlbiBcIiR7dG9rZW5OYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChpbmZvLnR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJib29sZWFuXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsICs9IFwiIERFRkFVTFQgXCIgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJpbnRlZ2VyXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsICs9IFwiIERFRkFVTFQgXCIgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIgREVGQVVMVCBcIiArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJ0ZXh0XCI6XG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlIFwiZW51bVwiOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIiBERUZBVUxUIFwiICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlIFwibnVtYmVyXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIgREVGQVVMVCBcIiArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIiBERUZBVUxUIFwiICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlIFwiYmluYXJ5XCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsICs9IFwiIERFRkFVTFQgXCIgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSBcImRhdGV0aW1lXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsICs9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiIERFRkFVTFQgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBVdGlsLnF1b3RlKFR5cGVzLkRBVEVUSU1FLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkudG9TUUwoeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJhcnJheVwiOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSBcIiBERUZBVUxUIFwiICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgdHlwZSBcIiR7aW5mby50eXBlfVwiYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KFwiYXV0b1wiKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gXCJcIjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSBcImJvb2xlYW5cIiB8fCBpbmZvLnR5cGUgPT09IFwiaW50ZWdlclwiIHx8IGluZm8udHlwZSA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIgREVGQVVMVCAwXCI7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09IFwiZGF0ZXRpbWVcIikge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUFwiO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSBcImVudW1cIikge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gXCIgREVGQVVMVCBcIiArIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vbm90IGV4cGxpY2l0IHNwZWNpZmllZCwgd2lsbCBub3QgdHJlYXRlZCBhcyBjcmVhdGVCeURiXG4gICAgICAgICAgICAgICAgLy9pbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovXG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgXCJfXCIpICsgXCJfXCI7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gR2VtbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyO1xuIl19