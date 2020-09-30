"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const path = require('path');

const Util = require('rk-utils');

const {
  _,
  fs,
  quote,
  putIntoBucket
} = Util;

const GemlUtils = require('../../../lang/GemlUtils');

const {
  pluralize,
  isDotSeparateName,
  extractDotSeparateName
} = GemlUtils;

const Entity = require('../../../lang/Entity');

const {
  Types
} = require('@genx/data');

const UNSUPPORTED_DEFAULT_VALUE = new Set(['BLOB', 'TEXT', 'JSON', 'GEOMETRY']);

class MySQLModeler {
  constructor(context, connector, dbOptions) {
    this.linker = context.linker;
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
      this.linker.log('info', 'Generating mysql scripts for schema "' + schema.name + '"...');
    }

    let modelingSchema = schema.clone();
    this.linker.log('debug', 'Building relations...');
    let pendingEntities = Object.keys(modelingSchema.entities);

    while (pendingEntities.length > 0) {
      let entityName = pendingEntities.shift();
      let entity = modelingSchema.entities[entityName];

      if (!_.isEmpty(entity.info.associations)) {
        this.linker.log('debug', `Processing associations of entity "${entityName}"...`);

        let assocs = this._preProcessAssociations(entity);

        let assocNames = assocs.reduce((result, v) => {
          result[v] = v;
          return result;
        }, {});
        entity.info.associations.forEach(assoc => this._processAssociation(modelingSchema, entity, assoc, assocNames, pendingEntities));
      }
    }

    this._events.emit('afterRelationshipBuilding');

    let sqlFilesDir = path.join('mysql', this.connector.database);
    let dbFilePath = path.join(sqlFilesDir, 'entities.sql');
    let fkFilePath = path.join(sqlFilesDir, 'relations.sql');
    let tableSQL = '',
        relationSQL = '',
        data = {};

    _.each(modelingSchema.entities, (entity, entityName) => {
      if (!(entityName === entity.name)) {
        throw new Error("Assertion failed: entityName === entity.name");
      }

      entity.addIndexes();
      let result = MySQLModeler.complianceCheck(entity);

      if (result.errors.length) {
        let message = '';

        if (result.warnings.length > 0) {
          message += 'Warnings: \n' + result.warnings.join('\n') + '\n';
        }

        message += result.errors.join('\n');
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
        tableSQL += this._createTableStatement(entityName, entity) + '\n';

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
              dataSet || (dataSet = '_init');
              runtimeEnv || (runtimeEnv = 'default');
              let nodes = [dataSet, runtimeEnv];
              nodes.push(entityName);
              let key = nodes.join('.');
              putIntoBucket(data, key, entityData, true);
            }
          });
        }
      }
    });

    if (!skipGeneration) {
      _.forOwn(this._references, (refs, srcEntityName) => {
        _.each(refs, ref => {
          relationSQL += this._addForeignKeyStatement(srcEntityName, ref, schemaToConnector) + '\n';
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
              let pathNodes = [sqlFilesDir, 'data', dataSet || '_init'];

              if (runtimeEnv !== 'default') {
                pathNodes.push(runtimeEnv);
              }

              let initFilePath = path.join(...pathNodes, initFileName);
              let idxFilePath = path.join(...pathNodes, 'index.list');
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
          let lines = fs.readFileSync(idxFilePath, 'utf8').split('\n');
          lines.forEach(line => {
            if (!line.startsWith('0-')) {
              manual.push(line);
            }
          });
        }

        this._writeFile(idxFilePath, list.concat(manual).join('\n'));
      });

      let funcSQL = '';
      let spFilePath = path.join(sqlFilesDir, 'procedures.sql');

      this._writeFile(path.join(this.outputPath, spFilePath), funcSQL);
    }

    return modelingSchema;
  }

  _toColumnReference(name) {
    return {
      oorType: 'ColumnReference',
      name
    };
  }

  _translateJoinCondition(context, localField, anchor, remoteField) {
    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._translateJoinCondition(context, localField, anchor, rf));
    }

    if (_.isPlainObject(remoteField)) {
      let ret = {
        [localField]: this._toColumnReference(anchor + '.' + remoteField.by)
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
      [localField]: this._toColumnReference(anchor + '.' + remoteField)
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

      if (assoc.type === 'hasMany') {
        return pluralize(assoc.destEntity);
      }

      return assoc.destEntity;
    });
  }

  _processAssociation(schema, entity, assoc, assocNames, pendingEntities) {
    let entityKeyField = entity.getKeyField();

    if (!!Array.isArray(entityKeyField)) {
      throw new Error("Assertion failed: !Array.isArray(entityKeyField)");
    }

    this.linker.log('debug', `Processing "${entity.name}" ${JSON.stringify(assoc)}`);
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

    if (!destKeyField) {
      throw new Error(`Empty key field "${destEntity.keyField}". Dest entity: ${destEntityName}, current entity: ${entity.name}`);
    }

    if (Array.isArray(destKeyField)) {
      throw new Error(`Destination entity "${destEntityName}" with combination primary key is not supported.`);
    }

    switch (assoc.type) {
      case 'hasOne':
      case 'hasMany':
        let includes;
        let excludes = {
          types: ['refersTo'],
          association: assoc
        };

        if (assoc.by) {
          excludes.types.push('belongsTo');
          includes = {
            by: cb => cb && cb.split('.')[0] === assoc.by.split('.')[0]
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
          if (backRef.type === 'hasMany' || backRef.type === 'hasOne') {
            if (!assoc.by) {
              throw new Error('"m2n" association requires "by" property. Entity: ' + entity.name + ' destination: ' + destEntityName);
            }

            let connectedByParts = assoc.by.split('.');

            if (!(connectedByParts.length <= 2)) {
              throw new Error("Assertion failed: connectedByParts.length <= 2");
            }

            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);

            if (!connEntityName) {
              throw new Error("Assertion failed: connEntityName");
            }

            let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:${backRef.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === 'hasMany' ? 'm' : '1'}-${entity.name}:${assoc.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;

            if (assoc.srcField) {
              tag1 += ' ' + assoc.srcField;
            }

            if (backRef.srcField) {
              tag2 += ' ' + backRef.srcField;
            }

            if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
              return;
            }

            let connectedByParts2 = backRef.by.split('.');
            let connectedByField2 = connectedByParts2.length > 1 && connectedByParts2[1] || destEntityNameAsFieldName;

            if (connectedByField === connectedByField2) {
              throw new Error('Cannot use the same "by" field in a relation entity.');
            }

            let connEntity = schema.ensureGetEntity(entity.gemlModule, connEntityName, pendingEntities);

            if (!connEntity) {
              connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, connectedByField2);
              pendingEntities.push(connEntity.name);
              this.linker.log('debug', `New entity "${connEntity.name}" added by association.`);
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
              ...(assoc.type === 'hasMany' ? {
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
              ...(backRef.type === 'hasMany' ? {
                list: true
              } : {}),
              assoc: connectedByField
            });

            this._processedRef.add(tag1);

            this.linker.log('verbose', `Processed 2-way reference: ${tag1}`);

            this._processedRef.add(tag2);

            this.linker.log('verbose', `Processed 2-way reference: ${tag2}`);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.by) {
              throw new Error('todo: belongsTo by. entity: ' + entity.name);
            } else {
              let anchor = assoc.srcField || (assoc.type === 'hasMany' ? pluralize(destEntityNameAsFieldName) : destEntityNameAsFieldName);
              let remoteField = assoc.remoteField || backRef.srcField || entity.name;

              if (destEntity.hasFeature('logicalDeletion')) {
                let deletionCheck = {
                  oolType: 'BinaryExpression',
                  operator: '!=',
                  left: {
                    oolType: 'ObjectReference',
                    name: `${destEntityName}.${destEntity.features['logicalDeletion'].field}`
                  },
                  right: true
                };

                if (_.isPlainObject(remoteField)) {
                  remoteField.with = {
                    oolType: 'LogicalExpression',
                    operator: 'and',
                    left: remoteField.with,
                    right: deletionCheck
                  };
                } else if (assoc.with) {
                  assoc.with = {
                    oolType: 'LogicalExpression',
                    operator: 'and',
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
                ...(typeof remoteField === 'string' ? {
                  field: remoteField
                } : {}),
                ...(assoc.type === 'hasMany' ? {
                  list: true
                } : {})
              });
            }
          } else {
            throw new Error('Unexpected path. Entity: ' + entity.name + ', association: ' + JSON.stringify(assoc, null, 2));
          }
        } else {
          let connectedByParts = assoc.by ? assoc.by.split('.') : [GemlUtils.prefixNaming(entity.name, destEntityName)];

          if (!(connectedByParts.length <= 2)) {
            throw new Error("Assertion failed: connectedByParts.length <= 2");
          }

          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);

          if (!connEntityName) {
            throw new Error("Assertion failed: connEntityName");
          }

          let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += ' ' + assoc.srcField;
          }

          if (!!this._processedRef.has(tag1)) {
            throw new Error("Assertion failed: !this._processedRef.has(tag1)");
          }

          let connEntity = schema.ensureGetEntity(entity.gemlModule, connEntityName, pendingEntities);

          if (!connEntity) {
            connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, destEntityNameAsFieldName);
            pendingEntities.push(connEntity.name);
            this.linker.log('debug', `New entity "${connEntity.name}" added by association.`);
          }

          let connBackRef1 = connEntity.getReferenceTo(entity.name, {
            type: 'refersTo',
            srcField: f => _.isNil(f) || f == connectedByField
          });

          if (!connBackRef1) {
            throw new Error(`Cannot find back reference to "${entity.name}" from relation entity "${connEntityName}".`);
          }

          let connBackRef2 = connEntity.getReferenceTo(destEntityName, {
            type: 'refersTo'
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
              [destEntityName]: localFieldName + '.' + connectedByField2,
              [connEntityName]: localFieldName
            }, entity.key, localFieldName, assoc.with ? {
              by: connectedByField,
              with: assoc.with
            } : connectedByField),
            field: connectedByField,
            ...(assoc.type === 'hasMany' ? {
              list: true
            } : {}),
            assoc: connectedByField2
          });

          this._processedRef.add(tag1);

          this.linker.log('verbose', `Processed 1-way reference: ${tag1}`);
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityNameAsFieldName;
        let destFieldName = destKeyField.name;
        let referencedField = destKeyField;

        if (assoc.type === 'refersTo') {
          let tag = `${entity.name}:1-${destEntityName}:* ${localField}`;

          if (assoc.destField) {
            if (!destEntity.hasField(assoc.destField)) {
              throw new Error(`The field "${assoc.destField}" being referenced is not a field of entity "${destEntityName}".`);
            }

            destFieldName = assoc.destField;
            referencedField = destEntity.fields[destFieldName];
          }

          tag += '->' + assoc.destField;

          if (this._processedRef.has(tag)) {
            return;
          }

          this._processedRef.add(tag);

          this.linker.log('verbose', `Processed week reference: ${tag}`);
        }

        let joinOn = {
          [localField]: this._toColumnReference(localField + '.' + destFieldName)
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

        if (assoc.type === 'belongsTo') {
          constraints.onUpdate || (constraints.onUpdate = 'RESTRICT');
          constraints.onDelete || (constraints.onDelete = 'RESTRICT');
        } else if (localFieldObj.optional) {
          constraints.onUpdate || (constraints.onUpdate = 'SET NULL');
          constraints.onDelete || (constraints.onDelete = 'SET NULL');
        }

        constraints.onUpdate || (constraints.onUpdate = 'NO ACTION');
        constraints.onDelete || (constraints.onDelete = 'NO ACTION');

        this._addReference(entity.name, localField, destEntityName, destFieldName, constraints);

        break;
    }
  }

  _oolConditionToQueryCondition(context, oolCon) {
    if (!oolCon.oolType) {
      throw new Error("Assertion failed: oolCon.oolType");
    }

    if (oolCon.oolType === 'BinaryExpression') {
      if (oolCon.operator === '==') {
        let left = oolCon.left;

        if (left.oolType && left.oolType === 'ObjectReference') {
          left = this._translateReference(context, left.name, true);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === 'ObjectReference') {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            '$eq': right
          }
        };
      } else if (oolCon.operator === '!=') {
        let left = oolCon.left;

        if (left.oolType && left.oolType === 'ObjectReference') {
          left = this._translateReference(context, left.name, true);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === 'ObjectReference') {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            '$ne': right
          }
        };
      }
    } else if (oolCon.oolType === 'UnaryExpression') {
      let arg;

      switch (oolCon.operator) {
        case 'is-null':
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === 'ObjectReference') {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              '$eq': null
            }
          };

        case 'is-not-null':
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === 'ObjectReference') {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              '$ne': null
            }
          };

        default:
          throw new Error('Unknown UnaryExpression operator: ' + oolCon.operator);
      }
    } else if (oolCon.oolType === 'LogicalExpression') {
      switch (oolCon.operator) {
        case 'and':
          return {
            $and: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };

        case 'or':
          return {
            $or: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };
      }
    }

    throw new Error('Unknown syntax: ' + JSON.stringify(oolCon));
  }

  _translateReference(context, ref, asKey) {
    let [base, ...other] = ref.split('.');
    let translated = context[base];

    if (!translated) {
      console.log(context);
      throw new Error(`Referenced object "${ref}" not found in context.`);
    }

    let refName = [translated, ...other].join('.');

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

    if (!(typeof leftField === 'string')) {
      throw new Error("Assertion failed: typeof leftField === 'string'");
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
      case 'autoId':
        field = entity.fields[feature.field];

        if (field.type === 'integer' && !field.generator) {
          field.autoIncrementId = true;

          if ('startFrom' in feature) {
            this._events.on('setTableOptions:' + entity.name, extraOpts => {
              extraOpts['AUTO_INCREMENT'] = feature.startFrom;
            });
          }
        }

        break;

      case 'createTimestamp':
        field = entity.fields[feature.field];
        field.isCreateTimestamp = true;
        break;

      case 'updateTimestamp':
        field = entity.fields[feature.field];
        field.isUpdateTimestamp = true;
        break;

      case 'userEditTracking':
        break;

      case 'logicalDeletion':
        break;

      case 'atLeastOneNotNull':
        break;

      case 'validateAllFieldsOnCreation':
        break;

      case 'stateTracking':
        break;

      case 'i18n':
        break;

      case 'changeLog':
        let changeLogSettings = Util.getValueByPath(schema.deploymentSettings, 'features.changeLog');

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
    this.linker.log('info', 'Generated db script: ' + filePath);
  }

  _addRelationEntity(schema, relationEntityName, entity1Name, entity2Name, entity1RefField, entity2RefField) {
    let entityInfo = {
      features: ['autoId', 'createTimestamp'],
      indexes: [{
        "fields": [entity1RefField, entity2RefField],
        "unique": true
      }],
      associations: [{
        "type": "refersTo",
        "destEntity": entity1Name,
        "srcField": entity1RefField
      }, {
        "type": "refersTo",
        "destEntity": entity2Name,
        "srcField": entity2RefField
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
        if (assoc.type === 'refersTo' && assoc.destEntity === entity1Name && (assoc.srcField || entity1Name) === connectedByField) {
          hasRefToEntity1 = true;
        }

        if (assoc.type === 'refersTo' && assoc.destEntity === entity2Name && (assoc.srcField || entity2Name) === connectedByField2) {
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
      if (!this._processedRef.has(tag2)) {
        throw new Error("Assertion failed: this._processedRef.has(tag2)");
      }

      return;
    }

    this._processedRef.add(tag1);

    this.linker.log('verbose', `Processed bridging reference: ${tag1}`);

    this._processedRef.add(tag2);

    this.linker.log('verbose', `Processed bridging reference: ${tag2}`);
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
      onUpdate: 'RESTRICT',
      onDelete: 'RESTRICT'
    };

    this._addReference(relationEntityName, connectedByField, entity1Name, keyEntity1.name, allCascade);

    this._addReference(relationEntityName, connectedByField2, entity2Name, keyEntity2.name, allCascade);
  }

  static oolOpToSql(op) {
    switch (op) {
      case '=':
        return '=';

      default:
        throw new Error('oolOpToSql to be implemented.');
    }
  }

  static oolToSql(schema, doc, ool, params) {
    if (!ool.oolType) {
      return ool;
    }

    switch (ool.oolType) {
      case 'BinaryExpression':
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

        return left + ' ' + MySQLModeler.oolOpToSql(ool.operator) + ' ' + right;

      case 'ObjectReference':
        if (!GemlUtils.isMemberAccess(ool.name)) {
          if (params && _.find(params, p => p.name === ool.name) !== -1) {
            return 'p' + _.upperFirst(ool.name);
          }

          throw new Error(`Referencing to a non-existing param "${ool.name}".`);
        }

        let {
          entityNode,
          entity,
          field
        } = GemlUtils.parseReferenceInDocument(schema, doc, ool.name);
        return entityNode.alias + '.' + MySQLModeler.quoteIdentifier(field.name);

      default:
        throw new Error('oolToSql to be implemented.');
    }
  }

  static _orderByToSql(schema, doc, ool) {
    return MySQLModeler.oolToSql(schema, doc, {
      oolType: 'ObjectReference',
      name: ool.field
    }) + (ool.ascend ? '' : ' DESC');
  }

  _viewDocumentToSQL(modelingSchema, view) {
    let sql = '  ';

    let doc = _.cloneDeep(view.getDocumentHierarchy(modelingSchema));

    let [colList, alias, joins] = this._buildViewSelect(modelingSchema, doc, 0);

    sql += 'SELECT ' + colList.join(', ') + ' FROM ' + MySQLModeler.quoteIdentifier(doc.entity) + ' AS ' + alias;

    if (!_.isEmpty(joins)) {
      sql += ' ' + joins.join(' ');
    }

    if (!_.isEmpty(view.selectBy)) {
      sql += ' WHERE ' + view.selectBy.map(select => MySQLModeler.oolToSql(modelingSchema, doc, select, view.params)).join(' AND ');
    }

    if (!_.isEmpty(view.groupBy)) {
      sql += ' GROUP BY ' + view.groupBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(', ');
    }

    if (!_.isEmpty(view.orderBy)) {
      sql += ' ORDER BY ' + view.orderBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(', ');
    }

    let skip = view.skip || 0;

    if (view.limit) {
      sql += ' LIMIT ' + MySQLModeler.oolToSql(modelingSchema, doc, skip, view.params) + ', ' + MySQLModeler.oolToSql(modelingSchema, doc, view.limit, view.params);
    } else if (view.skip) {
      sql += ' OFFSET ' + MySQLModeler.oolToSql(modelingSchema, doc, view.skip, view.params);
    }

    return sql;
  }

  _createTableStatement(entityName, entity) {
    let sql = 'CREATE TABLE IF NOT EXISTS `' + entityName + '` (\n';

    _.each(entity.fields, (field, name) => {
      sql += '  ' + MySQLModeler.quoteIdentifier(name) + ' ' + MySQLModeler.columnDefinition(field) + ',\n';
    });

    sql += '  PRIMARY KEY (' + MySQLModeler.quoteListOrValue(entity.key) + '),\n';

    if (entity.indexes && entity.indexes.length > 0) {
      entity.indexes.forEach(index => {
        sql += '  ';

        if (index.unique) {
          sql += 'UNIQUE ';
        }

        sql += 'KEY (' + MySQLModeler.quoteListOrValue(index.fields) + '),\n';
      });
    }

    let lines = [];

    this._events.emit('beforeEndColumnDefinition:' + entityName, lines);

    if (lines.length > 0) {
      sql += '  ' + lines.join(',\n  ');
    } else {
      sql = sql.substr(0, sql.length - 2);
    }

    sql += '\n)';
    let extraProps = {};

    this._events.emit('setTableOptions:' + entityName, extraProps);

    let props = Object.assign({}, this._dbOptions.table, extraProps);
    sql = _.reduce(props, function (result, value, key) {
      return result + ' ' + key + '=' + value;
    }, sql);
    sql += ';\n';
    return sql;
  }

  _addForeignKeyStatement(entityName, relation, schemaToConnector) {
    let refTable = relation.right;

    if (refTable.indexOf('.') > 0) {
      let [schemaName, refEntityName] = refTable.split('.');
      let targetConnector = schemaToConnector[schemaName];

      if (!targetConnector) {
        throw new Error("Assertion failed: targetConnector");
      }

      refTable = targetConnector.database + '`.`' + refEntityName;
    }

    let sql = 'ALTER TABLE `' + entityName + '` ADD FOREIGN KEY (`' + relation.leftField + '`) ' + 'REFERENCES `' + refTable + '` (`' + relation.rightField + '`) ';
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
    return _.isArray(obj) ? obj.map(v => MySQLModeler.quoteIdentifier(v)).join(', ') : MySQLModeler.quoteIdentifier(obj);
  }

  static complianceCheck(entity) {
    let result = {
      errors: [],
      warnings: []
    };

    if (!entity.key) {
      result.errors.push('Primary key is not specified.');
    }

    return result;
  }

  static columnDefinition(field, isProc) {
    let col;

    switch (field.type) {
      case 'integer':
        col = MySQLModeler.intColumnDefinition(field);
        break;

      case 'number':
        col = MySQLModeler.floatColumnDefinition(field);
        break;

      case 'text':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case 'boolean':
        col = MySQLModeler.boolColumnDefinition(field);
        break;

      case 'binary':
        col = MySQLModeler.binaryColumnDefinition(field);
        break;

      case 'datetime':
        col = MySQLModeler.datetimeColumnDefinition(field);
        break;

      case 'object':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case 'enum':
        col = MySQLModeler.enumColumnDefinition(field);
        break;

      case 'array':
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
        type = sql = 'BIGINT';
      } else if (info.digits > 7) {
        type = sql = 'INT';
      } else if (info.digits > 4) {
        type = sql = 'MEDIUMINT';
      } else if (info.digits > 2) {
        type = sql = 'SMALLINT';
      } else {
        type = sql = 'TINYINT';
      }

      sql += `(${info.digits})`;
    } else {
      type = sql = 'INT';
    }

    if (info.unsigned) {
      sql += ' UNSIGNED';
    }

    return {
      sql,
      type
    };
  }

  static floatColumnDefinition(info) {
    let sql = '',
        type;

    if (info.type == 'number' && info.exact) {
      type = sql = 'DECIMAL';

      if (info.totalDigits > 65) {
        throw new Error('Total digits exceed maximum limit.');
      }
    } else {
      if (info.totalDigits > 23) {
        type = sql = 'DOUBLE';

        if (info.totalDigits > 53) {
          throw new Error('Total digits exceed maximum limit.');
        }
      } else {
        type = sql = 'FLOAT';
      }
    }

    if ('totalDigits' in info) {
      sql += '(' + info.totalDigits;

      if ('decimalDigits' in info) {
        sql += ', ' + info.decimalDigits;
      }

      sql += ')';
    } else {
      if ('decimalDigits' in info) {
        if (info.decimalDigits > 23) {
          sql += '(53, ' + info.decimalDigits + ')';
        } else {
          sql += '(23, ' + info.decimalDigits + ')';
        }
      }
    }

    return {
      sql,
      type
    };
  }

  static textColumnDefinition(info) {
    let sql = '',
        type;

    if (info.fixedLength && info.fixedLength <= 255) {
      sql = 'CHAR(' + info.fixedLength + ')';
      type = 'CHAR';
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = 'LONGTEXT';
      } else if (info.maxLength > 65535) {
        type = sql = 'MEDIUMTEXT';
      } else if (info.maxLength > 2000) {
        type = sql = 'TEXT';
      } else {
        type = sql = 'VARCHAR';

        if (info.fixedLength) {
          sql += '(' + info.fixedLength + ')';
        } else {
          sql += '(' + info.maxLength + ')';
        }
      }
    } else {
      type = sql = 'TEXT';
    }

    return {
      sql,
      type
    };
  }

  static binaryColumnDefinition(info) {
    let sql = '',
        type;

    if (info.fixedLength <= 255) {
      sql = 'BINARY(' + info.fixedLength + ')';
      type = 'BINARY';
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = 'LONGBLOB';
      } else if (info.maxLength > 65535) {
        type = sql = 'MEDIUMBLOB';
      } else {
        type = sql = 'VARBINARY';

        if (info.fixedLength) {
          sql += '(' + info.fixedLength + ')';
        } else {
          sql += '(' + info.maxLength + ')';
        }
      }
    } else {
      type = sql = 'BLOB';
    }

    return {
      sql,
      type
    };
  }

  static boolColumnDefinition() {
    return {
      sql: 'TINYINT(1)',
      type: 'TINYINT'
    };
  }

  static datetimeColumnDefinition(info) {
    let sql;

    if (!info.range || info.range === 'datetime') {
      sql = 'DATETIME';
    } else if (info.range === 'date') {
      sql = 'DATE';
    } else if (info.range === 'time') {
      sql = 'TIME';
    } else if (info.range === 'year') {
      sql = 'YEAR';
    } else if (info.range === 'timestamp') {
      sql = 'TIMESTAMP';
    }

    return {
      sql,
      type: sql
    };
  }

  static enumColumnDefinition(info) {
    return {
      sql: 'ENUM(' + _.map(info.values, v => MySQLModeler.quoteString(v)).join(', ') + ')',
      type: 'ENUM'
    };
  }

  static columnNullable(info) {
    if (info.hasOwnProperty('optional') && info.optional) {
      return ' NULL';
    }

    return ' NOT NULL';
  }

  static defaultValue(info, type) {
    if (info.isCreateTimestamp) {
      info.createByDb = true;
      return ' DEFAULT CURRENT_TIMESTAMP';
    }

    if (info.autoIncrementId) {
      info.createByDb = true;
      return ' AUTO_INCREMENT';
    }

    if (info.isUpdateTimestamp) {
      info.updateByDb = true;
      return ' ON UPDATE CURRENT_TIMESTAMP';
    }

    let sql = '';

    if (!info.optional) {
      if (info.hasOwnProperty('default')) {
        let defaultValue = info['default'];

        if (info.type === 'boolean') {
          sql += ' DEFAULT ' + (Types.BOOLEAN.sanitize(defaultValue) ? '1' : '0');
        }
      } else if (!info.hasOwnProperty('auto')) {
        if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
          return '';
        }

        if (info.type === 'boolean' || info.type === 'integer' || info.type === 'number') {
          sql += ' DEFAULT 0';
        } else if (info.type === 'datetime') {
          sql += ' DEFAULT CURRENT_TIMESTAMP';
        } else if (info.type === 'enum') {
          sql += ' DEFAULT ' + quote(info.values[0]);
        } else {
          sql += ' DEFAULT ""';
        }

        info.createByDb = true;
      }
    }

    return sql;
  }

  static removeTableNamePrefix(entityName, removeTablePrefix) {
    if (removeTablePrefix) {
      entityName = _.trim(_.snakeCase(entityName));
      removeTablePrefix = _.trimEnd(_.snakeCase(removeTablePrefix), '_') + '_';

      if (_.startsWith(entityName, removeTablePrefix)) {
        entityName = entityName.substr(removeTablePrefix.length);
      }
    }

    return GemlUtils.entityNaming(entityName);
  }

}

module.exports = MySQLModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiR2VtbFV0aWxzIiwicGx1cmFsaXplIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwic2NoZW1hVG9Db25uZWN0b3IiLCJza2lwR2VuZXJhdGlvbiIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsImdlbWxNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwibm9kZXMiLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsImluaXRJZHhGaWxlcyIsImVudkRhdGEiLCJlbnRpdGllc0RhdGEiLCJpbml0RmlsZU5hbWUiLCJwYXRoTm9kZXMiLCJpbml0RmlsZVBhdGgiLCJpZHhGaWxlUGF0aCIsIkpTT04iLCJzdHJpbmdpZnkiLCJsaXN0IiwiZmlsZVBhdGgiLCJtYW51YWwiLCJleGlzdHNTeW5jIiwibGluZXMiLCJyZWFkRmlsZVN5bmMiLCJzcGxpdCIsImxpbmUiLCJzdGFydHNXaXRoIiwiY29uY2F0IiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJfdG9Db2x1bW5SZWZlcmVuY2UiLCJvb3JUeXBlIiwiX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24iLCJsb2NhbEZpZWxkIiwiYW5jaG9yIiwicmVtb3RlRmllbGQiLCJtYXAiLCJyZiIsInJldCIsImJ5Iiwid2l0aEV4dHJhIiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJ3aXRoIiwiJGFuZCIsIl9nZXRBbGxSZWxhdGVkRmllbGRzIiwidW5kZWZpbmVkIiwic3JjRmllbGQiLCJ0eXBlIiwiZGVzdEVudGl0eSIsImVudGl0eUtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUiLCJkZXN0U2NoZW1hTmFtZSIsImFjdHVhbERlc3RFbnRpdHlOYW1lIiwiZGVzdFNjaGVtYSIsInNjaGVtYXMiLCJsaW5rZWQiLCJlbnN1cmVHZXRFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNiIiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsImhhc0ZlYXR1cmUiLCJkZWxldGlvbkNoZWNrIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsInJpZ2h0IiwicHJlZml4TmFtaW5nIiwiY29ubkJhY2tSZWYxIiwiY29ubkJhY2tSZWYyIiwic3JjIiwiZGVzdCIsImRlc3RGaWVsZE5hbWUiLCJyZWZlcmVuY2VkRmllbGQiLCJ0YWciLCJkZXN0RmllbGQiLCJoYXNGaWVsZCIsImpvaW5PbiIsImFkZEFzc29jRmllbGQiLCJmaWVsZFByb3BzIiwibG9jYWxGaWVsZE9iaiIsImNvbnN0cmFpbnRzIiwiY29uc3RyYWludE9uVXBkYXRlIiwib25VcGRhdGUiLCJjb25zdHJhaW50T25EZWxldGUiLCJvbkRlbGV0ZSIsIm9wdGlvbmFsIiwiX2FkZFJlZmVyZW5jZSIsIm9vbENvbiIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJhcmciLCJhcmd1bWVudCIsIiRvciIsImFzS2V5IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImNvbnNvbGUiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJjaGFuZ2VMb2dTZXR0aW5ncyIsImdldFZhbHVlQnlQYXRoIiwiZGVwbG95bWVudFNldHRpbmdzIiwiZGF0YVNvdXJjZSIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxTmFtZSIsImVudGl0eTJOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImluZGV4ZXMiLCJsaW5rIiwiYWRkRW50aXR5IiwicmVsYXRpb25FbnRpdHkiLCJlbnRpdHkxIiwiZW50aXR5MiIsImhhc1JlZlRvRW50aXR5MSIsImhhc1JlZlRvRW50aXR5MiIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwiYWxsQ2FzY2FkZSIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsImNvbHVtbkRlZmluaXRpb24iLCJxdW90ZUxpc3RPclZhbHVlIiwiaW5kZXgiLCJ1bmlxdWUiLCJzdWJzdHIiLCJleHRyYVByb3BzIiwicHJvcHMiLCJyZWxhdGlvbiIsInJlZlRhYmxlIiwic2NoZW1hTmFtZSIsInJlZkVudGl0eU5hbWUiLCJ0YXJnZXRDb25uZWN0b3IiLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsImlzUHJvYyIsImludENvbHVtbkRlZmluaXRpb24iLCJmbG9hdENvbHVtbkRlZmluaXRpb24iLCJ0ZXh0Q29sdW1uRGVmaW5pdGlvbiIsImJvb2xDb2x1bW5EZWZpbml0aW9uIiwiYmluYXJ5Q29sdW1uRGVmaW5pdGlvbiIsImRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbiIsImVudW1Db2x1bW5EZWZpbml0aW9uIiwiY29sdW1uTnVsbGFibGUiLCJkZWZhdWx0VmFsdWUiLCJkaWdpdHMiLCJ1bnNpZ25lZCIsImV4YWN0IiwidG90YWxEaWdpdHMiLCJkZWNpbWFsRGlnaXRzIiwiZml4ZWRMZW5ndGgiLCJtYXhMZW5ndGgiLCJyYW5nZSIsInZhbHVlcyIsImhhc093blByb3BlcnR5IiwiY3JlYXRlQnlEYiIsInVwZGF0ZUJ5RGIiLCJCT09MRUFOIiwic2FuaXRpemUiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmlt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LENBQVYsRUFBMEMsR0FBMUMsSUFBaUQsR0FBckU7O0FBRUEsVUFBSXJWLENBQUMsQ0FBQ3lILFVBQUYsQ0FBYTdFLFVBQWIsRUFBeUJ5UyxpQkFBekIsQ0FBSixFQUFpRDtBQUM3Q3pTLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDOFAsTUFBWCxDQUFrQjJDLGlCQUFpQixDQUFDMVMsTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBT3ZDLFNBQVMsQ0FBQ29LLFlBQVYsQ0FBdUI1SCxVQUF2QixDQUFQO0FBQ0g7O0FBamtEYzs7QUFva0RuQjZTLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjlVLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSwgcHV0SW50b0J1Y2tldCB9ID0gVXRpbDtcblxuY29uc3QgR2VtbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9HZW1sVXRpbHMnKTtcbmNvbnN0IHsgcGx1cmFsaXplLCBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSB9ID0gR2VtbFV0aWxzO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IHsgVHlwZXMgfSA9IHJlcXVpcmUoJ0BnZW54L2RhdGEnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hLCBzY2hlbWFUb0Nvbm5lY3Rvciwgc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgaWYgKCFza2lwR2VuZXJhdGlvbikge1xuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBwZW5kaW5nRW50aXRpZXMgPSBPYmplY3Qua2V5cyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgd2hpbGUgKHBlbmRpbmdFbnRpdGllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZXQgZW50aXR5TmFtZSA9IHBlbmRpbmdFbnRpdGllcy5zaGlmdCgpO1xuICAgICAgICAgICAgbGV0IGVudGl0eSA9IG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzW2VudGl0eU5hbWVdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7ICBcbiAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgYXNzb2NpYXRpb25zIG9mIGVudGl0eSBcIiR7ZW50aXR5TmFtZX1cIi4uLmApOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGxldCBhc3NvY3MgPSB0aGlzLl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NOYW1lcyA9IGFzc29jcy5yZWR1Y2UoKHJlc3VsdCwgdikgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbdl0gPSB2O1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH0sIHt9KTsgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHMgICAgICAgIFxuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTsgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICAvL2xldCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGVudGl0eU5hbWUgPT09IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgLy9tYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lW2VudGl0eU5hbWVdID0gZW50aXR5LmNvZGU7XG5cbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcblxuICAgICAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG5cbiAgICAgICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2goKHsgZGF0YVNldCwgcnVudGltZUVudiwgcmVjb3JkcyB9KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVjb3JkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQga2V5RmllbGQgPSBlbnRpdHkuZmllbGRzW2ZpZWxkc1swXV07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICgha2V5RmllbGQuYXV0byAmJiAha2V5RmllbGQuZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBrZXkgZmllbGQgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBubyBkZWZhdWx0IHZhbHVlIG9yIGF1dG8tZ2VuZXJhdGVkIHZhbHVlLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkuZ2VtbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5LmdlbWxNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24ocmVjb3JkcywgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5nZW1sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5LmdlbWxNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFTZXQgfHwgKGRhdGFTZXQgPSAnX2luaXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW50aW1lRW52IHx8IChydW50aW1lRW52ID0gJ2RlZmF1bHQnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlcyA9IFsgZGF0YVNldCwgcnVudGltZUVudiBdOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXkgPSBub2Rlcy5qb2luKCcuJyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGRhdGEsIGtleSwgZW50aXR5RGF0YSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICAgICAgbGV0IGluaXRJZHhGaWxlcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIF8uZm9yT3duKGRhdGEsIChlbnZEYXRhLCBkYXRhU2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudkRhdGEsIChlbnRpdGllc0RhdGEsIHJ1bnRpbWVFbnYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0aWVzRGF0YSwgKHJlY29yZHMsIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVOYW1lID0gYDAtJHtlbnRpdHlOYW1lfS5qc29uYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBwYXRoTm9kZXMgPSBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEZpbGVzRGlyLCAnZGF0YScsIGRhdGFTZXQgfHwgJ19pbml0J1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocnVudGltZUVudiAhPT0gJ2RlZmF1bHQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGhOb2Rlcy5wdXNoKHJ1bnRpbWVFbnYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCBpbml0RmlsZU5hbWUpOyAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCAnaW5kZXgubGlzdCcpOyAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChpbml0SWR4RmlsZXMsIFtpZHhGaWxlUGF0aF0sIGluaXRGaWxlTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoeyBbZW50aXR5TmFtZV06IHJlY29yZHMgfSwgbnVsbCwgNCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSkgXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL2NvbnNvbGUuZGlyKGluaXRJZHhGaWxlcywge2RlcHRoOiAxMH0pO1xuXG4gICAgICAgICAgICBfLmZvck93bihpbml0SWR4RmlsZXMsIChsaXN0LCBmaWxlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgICAgIGxldCBtYW51YWwgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGlkeEZpbGVQYXRoKSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMoaWR4RmlsZVBhdGgsICd1dGY4Jykuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgICAgICAgICBsaW5lcy5mb3JFYWNoKGxpbmUgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoJzAtJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYW51YWwucHVzaChsaW5lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKGlkeEZpbGVQYXRoLCBsaXN0LmNvbmNhdChtYW51YWwpLmpvaW4oJ1xcbicpKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfdG9Db2x1bW5SZWZlcmVuY2UobmFtZSkge1xuICAgICAgICByZXR1cm4geyBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJywgbmFtZSB9OyAgXG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZC5ieSkgfTtcbiAgICAgICAgICAgIGxldCB3aXRoRXh0cmEgPSB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIHJlbW90ZUZpZWxkLndpdGgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAobG9jYWxGaWVsZCBpbiB3aXRoRXh0cmEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHJldCwgd2l0aEV4dHJhIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQpIH07XG4gICAgfVxuXG4gICAgX2dldEFsbFJlbGF0ZWRGaWVsZHMocmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKCFyZW1vdGVGaWVsZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5ieTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZW1vdGVGaWVsZDtcbiAgICB9XG5cbiAgICBfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpIHtcbiAgICAgICAgcmV0dXJuIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5tYXAoYXNzb2MgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnaGFzTWFueScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGx1cmFsaXplKGFzc29jLmRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtieV0gW3dpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIFwiJHtlbnRpdHkubmFtZX1cIiAke0pTT04uc3RyaW5naWZ5KGFzc29jKX1gKTsgXG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSwgZGVzdEVudGl0eSwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgWyBkZXN0U2NoZW1hTmFtZSwgYWN0dWFsRGVzdEVudGl0eU5hbWUgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVzdFNjaGVtYSA9IHNjaGVtYS5saW5rZXIuc2NoZW1hc1tkZXN0U2NoZW1hTmFtZV07XG4gICAgICAgICAgICBpZiAoIWRlc3RTY2hlbWEubGlua2VkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZGVzdGluYXRpb24gc2NoZW1hICR7ZGVzdFNjaGVtYU5hbWV9IGhhcyBub3QgYmVlbiBsaW5rZWQgeWV0LiBDdXJyZW50bHkgb25seSBzdXBwb3J0IG9uZS13YXkgcmVmZXJlbmNlIGZvciBjcm9zcyBkYiByZWxhdGlvbi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07IFxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGFjdHVhbERlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5LmdlbWxNb2R1bGUsIGRlc3RFbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSAgIFxuICAgICAgICAgXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQsIGBFbXB0eSBrZXkgZmllbGQgXCIke2Rlc3RFbnRpdHkua2V5RmllbGR9XCIuIERlc3QgZW50aXR5OiAke2Rlc3RFbnRpdHlOYW1lfSwgY3VycmVudCBlbnRpdHk6ICR7ZW50aXR5Lm5hbWV9YDsgXG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb246IGFzc29jIFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5ieS5zcGxpdCgnLicpWzBdIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy53aXRoID0gYXNzb2Mud2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiByZW1vdGVGaWVsZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQgfHwgKHJlbW90ZUZpZWxkID0gZW50aXR5Lm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YocmVtb3RlRmllbGQpID4gLTEgOiByZW1vdGVGaWVsZHMgPT09IHJlbW90ZUZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignXCJtMm5cIiBhc3NvY2lhdGlvbiByZXF1aXJlcyBcImJ5XCIgcHJvcGVydHkuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJyBkZXN0aW5hdGlvbjogJyArIGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb25lL21hbnkgdG8gb25lL21hbnkgcmVsYXRpb25cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0ZWQgYnkgZmllbGQgaXMgdXN1YWxseSBhIHJlZmVyc1RvIGFzc29jXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7IFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gR2VtbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5LmdlbWxNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sIGRlc3RFbnRpdHkua2V5LCByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzJ9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBieS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSkgOiBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcblxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jaGVjayBpZiB0aGUgdGFyZ2V0IGVudGl0eSBoYXMgbG9naWNhbCBkZWxldGlvbiBmZWF0dXJlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHkuaGFzRmVhdHVyZSgnbG9naWNhbERlbGV0aW9uJykpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZGVsZXRpb25DaGVjayA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdCaW5hcnlFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnIT0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogYCR7ZGVzdEVudGl0eU5hbWV9LiR7ZGVzdEVudGl0eS5mZWF0dXJlc1snbG9naWNhbERlbGV0aW9uJ10uZmllbGR9YCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiByZW1vdGVGaWVsZC53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0xvZ2ljYWxFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogJ2FuZCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogYXNzb2Mud2l0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogZGVsZXRpb25DaGVja1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSBkZWxldGlvbkNoZWNrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSwgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBhbmNob3IgfSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmtleSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiByZW1vdGVGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIEdlbWxVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKSBdO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBHZW1sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5nZW1sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogZ2V0IGJhY2sgcmVmIGZyb20gY29ubmVjdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMSA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJywgc3JjRmllbGQ6IChmKSA9PiBfLmlzTmlsKGYpIHx8IGYgPT0gY29ubmVjdGVkQnlGaWVsZCB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZW50aXR5Lm5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMiA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZGVzdEVudGl0eU5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJyB9LCB7IGFzc29jaWF0aW9uOiBjb25uQmFja1JlZjEgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtkZXN0RW50aXR5TmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGNvbm5CYWNrUmVmMi5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4gRGV0YWlsOiAnICsgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdDogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IGFzc29jLnNyY0ZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgKyAnLicgKyBjb25uZWN0ZWRCeUZpZWxkMiwgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMS13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RmllbGROYW1lID0gZGVzdEtleUZpZWxkLm5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RLZXlGaWVsZDtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5kZXN0RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghZGVzdEVudGl0eS5oYXNGaWVsZChhc3NvYy5kZXN0RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZmllbGQgXCIke2Fzc29jLmRlc3RGaWVsZH1cIiBiZWluZyByZWZlcmVuY2VkIGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RGaWVsZE5hbWUgPSBhc3NvYy5kZXN0RmllbGQ7ICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RFbnRpdHkuZmllbGRzW2Rlc3RGaWVsZE5hbWVdOyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGFnICs9ICctPicgKyBhc3NvYy5kZXN0RmllbGQ7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCBieSBjb25uZWN0aW9uLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZyk7ICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgd2VlayByZWZlcmVuY2U6ICR7dGFnfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBqb2luT24gPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UobG9jYWxGaWVsZCArICcuJyArIGRlc3RGaWVsZE5hbWUpIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGpvaW5PbiwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGxvY2FsRmllbGQgfSwgYXNzb2Mud2l0aCkpOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCByZWZlcmVuY2VkRmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGRlc3RGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogam9pbk9uIFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIC8vZm9yZWlnbiBrZXkgY29uc3RyYWl0c1xuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkT2JqID0gZW50aXR5LmZpZWxkc1tsb2NhbEZpZWxkXTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBjb25zdHJhaW50cyA9IHt9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGU7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnUkVTVFJJQ1QnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ1JFU1RSSUNUJyk7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGxvY2FsRmllbGRPYmoub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ1NFVCBOVUxMJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdOTyBBQ1RJT04nKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnTk8gQUNUSU9OJyk7XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0RmllbGROYW1lLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnIT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRuZSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmc7XG5cbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJGVxJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07IFxuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRuZSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgXG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBVbmFyeUV4cHJlc3Npb24gb3BlcmF0b3I6ICcgKyBvb2xDb24ub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRvcjogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2gobGYgPT4gdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxmLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMgfSk7IFxuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXNlckVkaXRUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjaGFuZ2VMb2cnOlxuICAgICAgICAgICAgICAgIGxldCBjaGFuZ2VMb2dTZXR0aW5ncyA9IFV0aWwuZ2V0VmFsdWVCeVBhdGgoc2NoZW1hLmRlcGxveW1lbnRTZXR0aW5ncywgJ2ZlYXR1cmVzLmNoYW5nZUxvZycpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgXCJjaGFuZ2VMb2dcIiBmZWF0dXJlIHNldHRpbmdzIGluIGRlcGxveW1lbnQgY29uZmlnIGZvciBzY2hlbWEgWyR7c2NoZW1hLm5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzLmRhdGFTb3VyY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNoYW5nZUxvZy5kYXRhU291cmNlXCIgaXMgcmVxdWlyZWQuIFNjaGVtYTogJHtzY2hlbWEubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGZlYXR1cmUsIGNoYW5nZUxvZ1NldHRpbmdzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2F1dG9JZCcsICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBpbmRleGVzOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcImZpZWxkc1wiOiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF0sXG4gICAgICAgICAgICAgICAgICAgIFwidW5pcXVlXCI6IHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5MU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MVJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkyUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLmdlbWxNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MiBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5Mk5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDIgXG4gICAgICovXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgXG4gICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgcmVsYXRpb24gZW50aXR5IGhhcyB0aGUgcmVmZXJzVG8gYm90aCBzaWRlIG9mIGFzc29jaWF0aW9ucyAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTFOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkxTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mk5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTJOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc1JlZlRvRW50aXR5MSAmJiBoYXNSZWZUb0VudGl0eTIpIHtcbiAgICAgICAgICAgICAgICAvL3llcywgZG9uJ3QgbmVlZCB0byBhZGQgcmVmZXJzVG8gdG8gdGhlIHJlbGF0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0YWcxID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5MU5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkfWA7XG4gICAgICAgIGxldCB0YWcyID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5Mk5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkMn1gO1xuXG4gICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMik7XG5cbiAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICBcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMX1gKTtcblxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgIFxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcyfWApO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MU5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mk5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEsIGtleUVudGl0eTEpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBrZXlFbnRpdHkyKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTFOYW1lIH1cbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5Mk5hbWUgfVxuICAgICAgICApO1xuXG4gICAgICAgIGxldCBhbGxDYXNjYWRlID0geyBvblVwZGF0ZTogJ1JFU1RSSUNUJywgb25EZWxldGU6ICdSRVNUUklDVCcgfTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUsIGFsbENhc2NhZGUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIUdlbWxVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gR2VtbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgLypcbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH0qL1xuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbiwgc2NoZW1hVG9Db25uZWN0b3IvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCByZWZUYWJsZSA9IHJlbGF0aW9uLnJpZ2h0O1xuXG4gICAgICAgIGlmIChyZWZUYWJsZS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCByZWZFbnRpdHlOYW1lIF0gPSByZWZUYWJsZS5zcGxpdCgnLicpOyAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0Q29ubmVjdG9yID0gc2NoZW1hVG9Db25uZWN0b3Jbc2NoZW1hTmFtZV07XG4gICAgICAgICAgICBhc3NlcnQ6IHRhcmdldENvbm5lY3RvcjtcblxuICAgICAgICAgICAgcmVmVGFibGUgPSB0YXJnZXRDb25uZWN0b3IuZGF0YWJhc2UgKyAnYC5gJyArIHJlZkVudGl0eU5hbWU7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVmVGFibGUgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9IGBPTiBVUERBVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vblVwZGF0ZX0gT04gREVMRVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25EZWxldGV9O1xcbmA7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdudW1iZXInICYmIGluZm8uZXhhY3QpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIEFVVE9fSU5DUkVNRU5UJztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBPTiBVUERBVEUgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICcnO1xuXG4gICAgICAgIGlmICghaW5mby5vcHRpb25hbCkgeyAgICAgIFxuICAgICAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvWydkZWZhdWx0J107XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFR5cGVzLkJPT0xFQU4uc2FuaXRpemUoZGVmYXVsdFZhbHVlKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdG9kbzogb3RoZXIgdHlwZXNcblxuICAgICAgICAgICAgfSBlbHNlIGlmICghaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicgfHwgaW5mby50eXBlID09PSAnaW50ZWdlcicgfHwgaW5mby50eXBlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZW51bScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICB9ICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gR2VtbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=