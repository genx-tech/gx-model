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
            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);
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
          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);
          let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += ' ' + assoc.srcField;
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
          constraints.onUpdate || (constraints.onUpdate = 'CASCADE');
          constraints.onDelete || (constraints.onDelete = 'CASCADE');
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
            this._events.once('setTableOptions:' + entity.name, extraOpts => {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiR2VtbFV0aWxzIiwicGx1cmFsaXplIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwibGlua2VyIiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwib3V0cHV0UGF0aCIsInNjcmlwdFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwic2NoZW1hVG9Db25uZWN0b3IiLCJza2lwR2VuZXJhdGlvbiIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsImdlbWxNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwibm9kZXMiLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsImluaXRJZHhGaWxlcyIsImVudkRhdGEiLCJlbnRpdGllc0RhdGEiLCJpbml0RmlsZU5hbWUiLCJwYXRoTm9kZXMiLCJpbml0RmlsZVBhdGgiLCJpZHhGaWxlUGF0aCIsIkpTT04iLCJzdHJpbmdpZnkiLCJsaXN0IiwiZmlsZVBhdGgiLCJtYW51YWwiLCJleGlzdHNTeW5jIiwibGluZXMiLCJyZWFkRmlsZVN5bmMiLCJzcGxpdCIsImxpbmUiLCJzdGFydHNXaXRoIiwiY29uY2F0IiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJfdG9Db2x1bW5SZWZlcmVuY2UiLCJvb3JUeXBlIiwiX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24iLCJsb2NhbEZpZWxkIiwiYW5jaG9yIiwicmVtb3RlRmllbGQiLCJtYXAiLCJyZiIsInJldCIsImJ5Iiwid2l0aEV4dHJhIiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJ3aXRoIiwiJGFuZCIsIl9nZXRBbGxSZWxhdGVkRmllbGRzIiwidW5kZWZpbmVkIiwic3JjRmllbGQiLCJ0eXBlIiwiZGVzdEVudGl0eSIsImVudGl0eUtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUiLCJkZXN0U2NoZW1hTmFtZSIsImFjdHVhbERlc3RFbnRpdHlOYW1lIiwiZGVzdFNjaGVtYSIsInNjaGVtYXMiLCJsaW5rZWQiLCJlbnN1cmVHZXRFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNiIiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsImhhc0ZlYXR1cmUiLCJkZWxldGlvbkNoZWNrIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsInJpZ2h0IiwicHJlZml4TmFtaW5nIiwiY29ubkJhY2tSZWYxIiwiY29ubkJhY2tSZWYyIiwic3JjIiwiZGVzdCIsImRlc3RGaWVsZE5hbWUiLCJyZWZlcmVuY2VkRmllbGQiLCJ0YWciLCJkZXN0RmllbGQiLCJoYXNGaWVsZCIsImpvaW5PbiIsImFkZEFzc29jRmllbGQiLCJmaWVsZFByb3BzIiwibG9jYWxGaWVsZE9iaiIsImNvbnN0cmFpbnRzIiwiY29uc3RyYWludE9uVXBkYXRlIiwib25VcGRhdGUiLCJjb25zdHJhaW50T25EZWxldGUiLCJvbkRlbGV0ZSIsIm9wdGlvbmFsIiwiX2FkZFJlZmVyZW5jZSIsIm9vbENvbiIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJhcmciLCJhcmd1bWVudCIsIiRvciIsImFzS2V5IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImNvbnNvbGUiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsIm9uY2UiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRlcGxveW1lbnRTZXR0aW5ncyIsImRhdGFTb3VyY2UiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MU5hbWUiLCJlbnRpdHkyTmFtZSIsImVudGl0eTFSZWZGaWVsZCIsImVudGl0eTJSZWZGaWVsZCIsImVudGl0eUluZm8iLCJpbmRleGVzIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsImFsbENhc2NhZGUiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4IiwidW5pcXVlIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJyZWZFbnRpdHlOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNl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QUFPMkQscUJBQVAsQ0FBNkJ6UyxVQUE3QixFQUF5QzBTLGlCQUF6QyxFQUE0RDtBQUN4RCxRQUFJQSxpQkFBSixFQUF1QjtBQUNuQjFTLE1BQUFBLFVBQVUsR0FBRzVDLENBQUMsQ0FBQ3VWLElBQUYsQ0FBT3ZWLENBQUMsQ0FBQ3dWLFNBQUYsQ0FBWTVTLFVBQVosQ0FBUCxDQUFiO0FBRUEwUyxNQUFBQSxpQkFBaUIsR0FBR3RWLENBQUMsQ0FBQ3lWLE9BQUYsQ0FBVXpWLENBQUMsQ0FBQ3dWLFNBQUYsQ0FBWUYsaUJBQVosQ0FBVixFQUEwQyxHQUExQyxJQUFpRCxHQUFyRTs7QUFFQSxVQUFJdFYsQ0FBQyxDQUFDeUgsVUFBRixDQUFhN0UsVUFBYixFQUF5QjBTLGlCQUF6QixDQUFKLEVBQWlEO0FBQzdDMVMsUUFBQUEsVUFBVSxHQUFHQSxVQUFVLENBQUMrUCxNQUFYLENBQWtCMkMsaUJBQWlCLENBQUMzUyxNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPdkMsU0FBUyxDQUFDb0ssWUFBVixDQUF1QjVILFVBQXZCLENBQVA7QUFDSDs7QUFqa0RjOztBQW9rRG5COFMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCL1UsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlLCBwdXRJbnRvQnVja2V0IH0gPSBVdGlsO1xuXG5jb25zdCBHZW1sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0dlbWxVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBHZW1sVXRpbHM7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgeyBUeXBlcyB9ID0gcmVxdWlyZSgnQGdlbngvZGF0YScpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBsaW5rZXIsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubGlua2VyID0gbGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEsIHNjaGVtYVRvQ29ubmVjdG9yLCBza2lwR2VuZXJhdGlvbikge1xuICAgICAgICBpZiAoIXNraXBHZW5lcmF0aW9uKSB7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IHBlbmRpbmdFbnRpdGllcyA9IE9iamVjdC5rZXlzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICB3aGlsZSAocGVuZGluZ0VudGl0aWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxldCBlbnRpdHlOYW1lID0gcGVuZGluZ0VudGl0aWVzLnNoaWZ0KCk7XG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gbW9kZWxpbmdTY2hlbWEuZW50aXRpZXNbZW50aXR5TmFtZV07XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHsgIFxuICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgUHJvY2Vzc2luZyBhc3NvY2lhdGlvbnMgb2YgZW50aXR5IFwiJHtlbnRpdHlOYW1lfVwiLi4uYCk7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jcyA9IHRoaXMuX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBhc3NvY05hbWVzID0gYXNzb2NzLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHY7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0cyAgICAgICAgXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpOyAgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIC8vbGV0IG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGFzc2VydDogZW50aXR5TmFtZSA9PT0gZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAvL21hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWVbZW50aXR5TmFtZV0gPSBlbnRpdHkuY29kZTtcblxuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFza2lwR2VuZXJhdGlvbikge1xuXG4gICAgICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5LyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykgKyAnXFxuJztcblxuICAgICAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaCgoeyBkYXRhU2V0LCBydW50aW1lRW52LCByZWNvcmRzIH0pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZWNvcmRzKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IGVudGl0eS5maWVsZHNbZmllbGRzWzBdXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFrZXlGaWVsZC5hdXRvICYmICFrZXlGaWVsZC5kZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlIGtleSBmaWVsZCBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG5vIGRlZmF1bHQgdmFsdWUgb3IgYXV0by1nZW5lcmF0ZWQgdmFsdWUuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5nZW1sTW9kdWxlLCByZWNvcmQpIH07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkuZ2VtbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBfLmZvck93bihyZWNvcmRzLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5LmdlbWxNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkuZ2VtbE1vZHVsZSwgcmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVNldCB8fCAoZGF0YVNldCA9ICdfaW5pdCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ1bnRpbWVFbnYgfHwgKHJ1bnRpbWVFbnYgPSAnZGVmYXVsdCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG5vZGVzID0gWyBkYXRhU2V0LCBydW50aW1lRW52IF07ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2Rlcy5wdXNoKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGtleSA9IG5vZGVzLmpvaW4oJy4nKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHB1dEludG9CdWNrZXQoZGF0YSwga2V5LCBlbnRpdHlEYXRhLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKCFza2lwR2VuZXJhdGlvbikge1xuICAgICAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYsIHNjaGVtYVRvQ29ubmVjdG9yLyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgICAgICBsZXQgaW5pdElkeEZpbGVzID0ge307XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZGF0YSwgKGVudkRhdGEsIGRhdGFTZXQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW52RGF0YSwgKGVudGl0aWVzRGF0YSwgcnVudGltZUVudikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXRpZXNEYXRhLCAocmVjb3JkcywgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbml0RmlsZU5hbWUgPSBgMC0ke2VudGl0eU5hbWV9Lmpzb25gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHBhdGhOb2RlcyA9IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3FsRmlsZXNEaXIsICdkYXRhJywgZGF0YVNldCB8fCAnX2luaXQnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChydW50aW1lRW52ICE9PSAnZGVmYXVsdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGF0aE5vZGVzLnB1c2gocnVudGltZUVudik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbiguLi5wYXRoTm9kZXMsIGluaXRGaWxlTmFtZSk7ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbiguLi5wYXRoTm9kZXMsICdpbmRleC5saXN0Jyk7ICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGluaXRJZHhGaWxlcywgW2lkeEZpbGVQYXRoXSwgaW5pdEZpbGVOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeSh7IFtlbnRpdHlOYW1lXTogcmVjb3JkcyB9LCBudWxsLCA0KSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KSBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vY29uc29sZS5kaXIoaW5pdElkeEZpbGVzLCB7ZGVwdGg6IDEwfSk7XG5cbiAgICAgICAgICAgIF8uZm9yT3duKGluaXRJZHhGaWxlcywgKGxpc3QsIGZpbGVQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGlkeEZpbGVQYXRoID0gcGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmlsZVBhdGgpO1xuXG4gICAgICAgICAgICAgICAgbGV0IG1hbnVhbCA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZzLmV4aXN0c1N5bmMoaWR4RmlsZVBhdGgpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBsaW5lcyA9IGZzLnJlYWRGaWxlU3luYyhpZHhGaWxlUGF0aCwgJ3V0ZjgnKS5zcGxpdCgnXFxuJyk7XG4gICAgICAgICAgICAgICAgICAgIGxpbmVzLmZvckVhY2gobGluZSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWxpbmUuc3RhcnRzV2l0aCgnMC0nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1hbnVhbC5wdXNoKGxpbmUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUoaWR4RmlsZVBhdGgsIGxpc3QuY29uY2F0KG1hbnVhbCkuam9pbignXFxuJykpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90b0NvbHVtblJlZmVyZW5jZShuYW1lKSB7XG4gICAgICAgIHJldHVybiB7IG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLCBuYW1lIH07ICBcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLmJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkO1xuICAgIH1cblxuICAgIF9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSkge1xuICAgICAgICByZXR1cm4gZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLm1hcChhc3NvYyA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHJldHVybiBhc3NvYy5zcmNGaWVsZDtcblxuICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUbyAgICAgIFxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2J5XSBbd2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uICAgICAgIFxuICAgICAqIHJlZmVyc1RvIC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogICAgICBcbiAgICAgKiByZW1vdGVGaWVsZDpcbiAgICAgKiAgIDEuIGZpZWxkTmFtZVxuICAgICAqICAgMi4gYXJyYXkgb2YgZmllbGROYW1lXG4gICAgICogICAzLiB7IGJ5ICwgd2l0aCB9XG4gICAgICogICA0LiBhcnJheSBvZiBmaWVsZE5hbWUgYW5kIHsgYnkgLCB3aXRoIH0gbWl4ZWRcbiAgICAgKiAgXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyBcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgXCIke2VudGl0eS5uYW1lfVwiICR7SlNPTi5zdHJpbmdpZnkoYXNzb2MpfWApOyBcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5LCBkZXN0RW50aXR5LCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICBcbiAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKSkge1xuICAgICAgICAgICAgLy9jcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgICAgIGxldCBbIGRlc3RTY2hlbWFOYW1lLCBhY3R1YWxEZXN0RW50aXR5TmFtZSBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXN0U2NoZW1hID0gc2NoZW1hLmxpbmtlci5zY2hlbWFzW2Rlc3RTY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGlmICghZGVzdFNjaGVtYS5saW5rZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBkZXN0aW5hdGlvbiBzY2hlbWEgJHtkZXN0U2NoZW1hTmFtZX0gaGFzIG5vdCBiZWVuIGxpbmtlZCB5ZXQuIEN1cnJlbnRseSBvbmx5IHN1cHBvcnQgb25lLXdheSByZWZlcmVuY2UgZm9yIGNyb3NzIGRiIHJlbGF0aW9uLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBkZXN0U2NoZW1hLmVudGl0aWVzW2FjdHVhbERlc3RFbnRpdHlOYW1lXTsgXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gYWN0dWFsRGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkuZ2VtbE1vZHVsZSwgZGVzdEVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgXG4gICAgICAgICBcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6IGRlc3RLZXlGaWVsZCwgYEVtcHR5IGtleSBmaWVsZCBcIiR7ZGVzdEVudGl0eS5rZXlGaWVsZH1cIi4gRGVzdCBlbnRpdHk6ICR7ZGVzdEVudGl0eU5hbWV9LCBjdXJyZW50IGVudGl0eTogJHtlbnRpdHkubmFtZX1gOyBcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLndpdGggPSBhc3NvYy53aXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiYnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvbmUvbWFueSB0byBvbmUvbWFueSByZWxhdGlvblxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBHZW1sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkuZ2VtbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMn1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYW5jaG9yID0gYXNzb2Muc3JjRmllbGQgfHwgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKSA6IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NoZWNrIGlmIHRoZSB0YXJnZXQgZW50aXR5IGhhcyBsb2dpY2FsIGRlbGV0aW9uIGZlYXR1cmVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eS5oYXNGZWF0dXJlKCdsb2dpY2FsRGVsZXRpb24nKSkge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBkZWxldGlvbkNoZWNrID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0JpbmFyeUV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICchPScsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBgJHtkZXN0RW50aXR5TmFtZX0uJHtkZXN0RW50aXR5LmZlYXR1cmVzWydsb2dpY2FsRGVsZXRpb24nXS5maWVsZH1gIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZC53aXRoID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdMb2dpY2FsRXhwcmVzc2lvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICdhbmQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IHJlbW90ZUZpZWxkLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IGRlbGV0aW9uQ2hlY2tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiBhc3NvYy53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IGRlbGV0aW9uQ2hlY2s7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvciwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LCAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGFuY2hvciB9LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkua2V5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IHJlbW90ZUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IHJlbW90ZUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0eXBlb2YgcmVtb3RlRmllbGQgPT09ICdzdHJpbmcnID8geyBmaWVsZDogcmVtb3RlRmllbGQgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICBcbiAgICAgICAgICAgICAgICAgICAgLy8gc2VtaSBhc3NvY2lhdGlvbiBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5ID8gYXNzb2MuYnkuc3BsaXQoJy4nKSA6IFsgR2VtbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IEdlbWxVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5LmdlbWxNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vY3JlYXRlIGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy90b2RvOiBnZXQgYmFjayByZWYgZnJvbSBjb25uZWN0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYxID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBzcmNGaWVsZDogKGYpID0+IF8uaXNOaWwoZikgfHwgZiA9PSBjb25uZWN0ZWRCeUZpZWxkIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtlbnRpdHkubmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYyID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhkZXN0RW50aXR5TmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nIH0sIHsgYXNzb2NpYXRpb246IGNvbm5CYWNrUmVmMSAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2Rlc3RFbnRpdHlOYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gY29ubkJhY2tSZWYyLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSArICcuJyArIGNvbm5lY3RlZEJ5RmllbGQyLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAxLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGRlc3RGaWVsZE5hbWUgPSBkZXN0S2V5RmllbGQubmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgcmVmZXJlbmNlZEZpZWxkID0gZGVzdEtleUZpZWxkO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZyA9IGAke2VudGl0eS5uYW1lfToxLSR7ZGVzdEVudGl0eU5hbWV9OiogJHtsb2NhbEZpZWxkfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmRlc3RGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFkZXN0RW50aXR5Lmhhc0ZpZWxkKGFzc29jLmRlc3RGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBmaWVsZCBcIiR7YXNzb2MuZGVzdEZpZWxkfVwiIGJlaW5nIHJlZmVyZW5jZWQgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEZpZWxkTmFtZSA9IGFzc29jLmRlc3RGaWVsZDsgIFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJlbmNlZEZpZWxkID0gZGVzdEVudGl0eS5maWVsZHNbZGVzdEZpZWxkTmFtZV07ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0YWcgKz0gJy0+JyArIGFzc29jLmRlc3RGaWVsZDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkIGJ5IGNvbm5lY3Rpb24sIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnKTsgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCB3ZWVrIHJlZmVyZW5jZTogJHt0YWd9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGpvaW5PbiA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShsb2NhbEZpZWxkICsgJy4nICsgZGVzdEZpZWxkTmFtZSkgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oam9pbk9uLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogbG9jYWxGaWVsZCB9LCBhc3NvYy53aXRoKSk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIHJlZmVyZW5jZWRGaWVsZCwgYXNzb2MuZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogZGVzdEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uOiBqb2luT24gXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy9mb3JlaWduIGtleSBjb25zdHJhaXRzXG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGRPYmogPSBlbnRpdHkuZmllbGRzW2xvY2FsRmllbGRdOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGNvbnN0cmFpbnRzID0ge307XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGU7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnQ0FTQ0FERScpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnQ0FTQ0FERScpO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChsb2NhbEZpZWxkT2JqLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnU0VUIE5VTEwnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnTk8gQUNUSU9OJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ05PIEFDVElPTicpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEZpZWxkTmFtZSwgY29uc3RyYWludHMpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24pIHtcbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJyE9Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckbmUnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJnO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRlcSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyBcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckbmUnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgICAgIFxuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gVW5hcnlFeHByZXNzaW9uIG9wZXJhdG9yOiAnICsgb29sQ29uLm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkb3I6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gc3ludGF4OiAnICsgSlNPTi5zdHJpbmdpZnkob29sQ29uKSk7XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYsIGFzS2V5KSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coY29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmTmFtZSA9IFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG5cbiAgICAgICAgaWYgKGFzS2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmTmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShyZWZOYW1lKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBsZWZ0RmllbGQgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzIH0pOyBcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoc2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmVhdHVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uY2UoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXNlckVkaXRUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjaGFuZ2VMb2cnOlxuICAgICAgICAgICAgICAgIGxldCBjaGFuZ2VMb2dTZXR0aW5ncyA9IFV0aWwuZ2V0VmFsdWVCeVBhdGgoc2NoZW1hLmRlcGxveW1lbnRTZXR0aW5ncywgJ2ZlYXR1cmVzLmNoYW5nZUxvZycpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgXCJjaGFuZ2VMb2dcIiBmZWF0dXJlIHNldHRpbmdzIGluIGRlcGxveW1lbnQgY29uZmlnIGZvciBzY2hlbWEgWyR7c2NoZW1hLm5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzLmRhdGFTb3VyY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNoYW5nZUxvZy5kYXRhU291cmNlXCIgaXMgcmVxdWlyZWQuIFNjaGVtYTogJHtzY2hlbWEubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGZlYXR1cmUsIGNoYW5nZUxvZ1NldHRpbmdzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2F1dG9JZCcsICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBpbmRleGVzOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcImZpZWxkc1wiOiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF0sXG4gICAgICAgICAgICAgICAgICAgIFwidW5pcXVlXCI6IHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5MU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MVJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkyUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLmdlbWxNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MiBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5Mk5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDIgXG4gICAgICovXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgXG4gICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgcmVsYXRpb24gZW50aXR5IGhhcyB0aGUgcmVmZXJzVG8gYm90aCBzaWRlIG9mIGFzc29jaWF0aW9ucyAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTFOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkxTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mk5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTJOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc1JlZlRvRW50aXR5MSAmJiBoYXNSZWZUb0VudGl0eTIpIHtcbiAgICAgICAgICAgICAgICAvL3llcywgZG9uJ3QgbmVlZCB0byBhZGQgcmVmZXJzVG8gdG8gdGhlIHJlbGF0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0YWcxID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5MU5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkfWA7XG4gICAgICAgIGxldCB0YWcyID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5Mk5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkMn1gO1xuXG4gICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMik7XG5cbiAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICBcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMX1gKTtcblxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgIFxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcyfWApO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MU5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mk5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEsIGtleUVudGl0eTEpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBrZXlFbnRpdHkyKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTFOYW1lIH1cbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5Mk5hbWUgfVxuICAgICAgICApO1xuXG4gICAgICAgIGxldCBhbGxDYXNjYWRlID0geyBvblVwZGF0ZTogJ1JFU1RSSUNUJywgb25EZWxldGU6ICdSRVNUUklDVCcgfTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUsIGFsbENhc2NhZGUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIUdlbWxVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gR2VtbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgLypcbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH0qL1xuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbiwgc2NoZW1hVG9Db25uZWN0b3IvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCByZWZUYWJsZSA9IHJlbGF0aW9uLnJpZ2h0O1xuXG4gICAgICAgIGlmIChyZWZUYWJsZS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCByZWZFbnRpdHlOYW1lIF0gPSByZWZUYWJsZS5zcGxpdCgnLicpOyAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0Q29ubmVjdG9yID0gc2NoZW1hVG9Db25uZWN0b3Jbc2NoZW1hTmFtZV07XG4gICAgICAgICAgICBhc3NlcnQ6IHRhcmdldENvbm5lY3RvcjtcblxuICAgICAgICAgICAgcmVmVGFibGUgPSB0YXJnZXRDb25uZWN0b3IuZGF0YWJhc2UgKyAnYC5gJyArIHJlZkVudGl0eU5hbWU7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVmVGFibGUgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9IGBPTiBVUERBVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vblVwZGF0ZX0gT04gREVMRVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25EZWxldGV9O1xcbmA7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdudW1iZXInICYmIGluZm8uZXhhY3QpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIEFVVE9fSU5DUkVNRU5UJztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBPTiBVUERBVEUgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICcnO1xuXG4gICAgICAgIGlmICghaW5mby5vcHRpb25hbCkgeyAgICAgIFxuICAgICAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvWydkZWZhdWx0J107XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFR5cGVzLkJPT0xFQU4uc2FuaXRpemUoZGVmYXVsdFZhbHVlKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdG9kbzogb3RoZXIgdHlwZXNcblxuICAgICAgICAgICAgfSBlbHNlIGlmICghaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicgfHwgaW5mby50eXBlID09PSAnaW50ZWdlcicgfHwgaW5mby50eXBlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZW51bScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICB9ICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gR2VtbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=