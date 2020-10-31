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

        if (typeof defaultValue === 'object' && defaultValue.oorType === 'SymbolToken') {
          const tokenName = defaultValue.name.toUpperCase();

          switch (tokenName) {
            case 'NOW':
              sql += ' DEFAULT NOW()';
              info.createByDb = true;
              break;

            default:
              throw new Error(`Unsupported symbol token "${tokenName}".`);
          }
        } else {
          switch (info.type) {
            case 'boolean':
              sql += ' DEFAULT ' + (Types.BOOLEAN.sanitize(defaultValue) ? '1' : '0');
              break;

            case 'integer':
              if (_.isInteger(defaultValue)) {
                sql += ' DEFAULT ' + defaultValue.toString();
              } else {
                sql += ' DEFAULT ' + parseInt(defaultValue).toString();
              }

              break;

            case 'text':
            case 'enum':
              sql += ' DEFAULT ' + Util.quote(defaultValue);
              break;

            case 'number':
              if (_.isNumber(defaultValue)) {
                sql += ' DEFAULT ' + defaultValue.toString();
              } else {
                sql += ' DEFAULT ' + parseFloat(defaultValue).toString();
              }

              break;

            case 'binary':
              sql += ' DEFAULT ' + Util.bin2Hex(defaultValue);
              break;

            case 'datetime':
              sql += ' DEFAULT ' + Util.quote(Types.DATETIME.sanitize(defaultValue).toSQL({
                includeOffset: false
              }));
              break;

            case 'object':
            case 'array':
              sql += ' DEFAULT ' + Util.quote(JSON.stringify(defaultValue));
              break;

            default:
              throw new Error(`Invalid type "${info.type}"`);
          }
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
      removeTablePrefix = _.trimEnd(_.snakeCase(removeTablePrefix), '_') + '_';

      if (_.startsWith(entityName, removeTablePrefix)) {
        entityName = entityName.substr(removeTablePrefix.length);
      }
    }

    return GemlUtils.entityNaming(entityName);
  }

}

module.exports = MySQLModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiR2VtbFV0aWxzIiwicGx1cmFsaXplIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwibGlua2VyIiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwib3V0cHV0UGF0aCIsInNjcmlwdFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwic2NoZW1hVG9Db25uZWN0b3IiLCJza2lwR2VuZXJhdGlvbiIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsImdlbWxNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwibm9kZXMiLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsImluaXRJZHhGaWxlcyIsImVudkRhdGEiLCJlbnRpdGllc0RhdGEiLCJpbml0RmlsZU5hbWUiLCJwYXRoTm9kZXMiLCJpbml0RmlsZVBhdGgiLCJpZHhGaWxlUGF0aCIsIkpTT04iLCJzdHJpbmdpZnkiLCJsaXN0IiwiZmlsZVBhdGgiLCJtYW51YWwiLCJleGlzdHNTeW5jIiwibGluZXMiLCJyZWFkRmlsZVN5bmMiLCJzcGxpdCIsImxpbmUiLCJzdGFydHNXaXRoIiwiY29uY2F0IiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJfdG9Db2x1bW5SZWZlcmVuY2UiLCJvb3JUeXBlIiwiX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24iLCJsb2NhbEZpZWxkIiwiYW5jaG9yIiwicmVtb3RlRmllbGQiLCJtYXAiLCJyZiIsInJldCIsImJ5Iiwid2l0aEV4dHJhIiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJ3aXRoIiwiJGFuZCIsIl9nZXRBbGxSZWxhdGVkRmllbGRzIiwidW5kZWZpbmVkIiwic3JjRmllbGQiLCJ0eXBlIiwiZGVzdEVudGl0eSIsImVudGl0eUtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUiLCJkZXN0U2NoZW1hTmFtZSIsImFjdHVhbERlc3RFbnRpdHlOYW1lIiwiZGVzdFNjaGVtYSIsInNjaGVtYXMiLCJsaW5rZWQiLCJlbnN1cmVHZXRFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNiIiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsImhhc0ZlYXR1cmUiLCJkZWxldGlvbkNoZWNrIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsInJpZ2h0IiwicHJlZml4TmFtaW5nIiwiY29ubkJhY2tSZWYxIiwiY29ubkJhY2tSZWYyIiwic3JjIiwiZGVzdCIsImRlc3RGaWVsZE5hbWUiLCJyZWZlcmVuY2VkRmllbGQiLCJ0YWciLCJkZXN0RmllbGQiLCJoYXNGaWVsZCIsImpvaW5PbiIsImFkZEFzc29jRmllbGQiLCJmaWVsZFByb3BzIiwibG9jYWxGaWVsZE9iaiIsImNvbnN0cmFpbnRzIiwiY29uc3RyYWludE9uVXBkYXRlIiwib25VcGRhdGUiLCJjb25zdHJhaW50T25EZWxldGUiLCJvbkRlbGV0ZSIsIm9wdGlvbmFsIiwiX2FkZFJlZmVyZW5jZSIsIm9vbENvbiIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJhcmciLCJhcmd1bWVudCIsIiRvciIsImFzS2V5IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImNvbnNvbGUiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsIm9uY2UiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRlcGxveW1lbnRTZXR0aW5ncyIsImRhdGFTb3VyY2UiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MU5hbWUiLCJlbnRpdHkyTmFtZSIsImVudGl0eTFSZWZGaWVsZCIsImVudGl0eTJSZWZGaWVsZCIsImVudGl0eUluZm8iLCJpbmRleGVzIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsImFsbENhc2NhZGUiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4IiwidW5pcXVlIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJyZWZFbnRpdHlOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwidG9rZW5OYW1lIiwidG9VcHBlckNhc2UiLCJCT09MRUFOIiwic2FuaXRpemUiLCJpc0ludGVnZXIiLCJ0b1N0cmluZyIsInBhcnNlSW50IiwiaXNOdW1iZXIiLCJwYXJzZUZsb2F0IiwiYmluMkhleCIsIkRBVEVUSU1FIiwidG9TUUwiLCJpbmNsdWRlT2Zmc2V0IiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUVBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFRyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUEsS0FBVDtBQUFnQkMsRUFBQUE7QUFBaEIsSUFBa0NKLElBQXhDOztBQUVBLE1BQU1LLFNBQVMsR0FBR1AsT0FBTyxDQUFDLHlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRVEsRUFBQUEsU0FBRjtBQUFhQyxFQUFBQSxpQkFBYjtBQUFnQ0MsRUFBQUE7QUFBaEMsSUFBMkRILFNBQWpFOztBQUNBLE1BQU1JLE1BQU0sR0FBR1gsT0FBTyxDQUFDLHNCQUFELENBQXRCOztBQUNBLE1BQU07QUFBRVksRUFBQUE7QUFBRixJQUFZWixPQUFPLENBQUMsWUFBRCxDQUF6Qjs7QUFFQSxNQUFNYSx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMsTUFBVCxFQUFpQixNQUFqQixFQUF5QixVQUF6QixDQUFSLENBQWxDOztBQU1BLE1BQU1DLFlBQU4sQ0FBbUI7QUFTZkMsRUFBQUEsV0FBVyxDQUFDQyxPQUFELEVBQVVDLE1BQVYsRUFBa0JDLFNBQWxCLEVBQTZCQyxTQUE3QixFQUF3QztBQUMvQyxTQUFLRixNQUFMLEdBQWNBLE1BQWQ7QUFDQSxTQUFLRyxVQUFMLEdBQWtCSixPQUFPLENBQUNLLFVBQTFCO0FBQ0EsU0FBS0gsU0FB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RUFBeUJxVCxpQkFBekIsQ0FBSixFQUFpRDtBQUM3Q3JULFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDK1AsTUFBWCxDQUFrQnNELGlCQUFpQixDQUFDdFQsTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBT3ZDLFNBQVMsQ0FBQ29LLFlBQVYsQ0FBdUI1SCxVQUF2QixDQUFQO0FBQ0g7O0FBem5EYzs7QUE0bkRuQnlULE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjFWLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSwgcHV0SW50b0J1Y2tldCB9ID0gVXRpbDtcblxuY29uc3QgR2VtbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9HZW1sVXRpbHMnKTtcbmNvbnN0IHsgcGx1cmFsaXplLCBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSB9ID0gR2VtbFV0aWxzO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IHsgVHlwZXMgfSA9IHJlcXVpcmUoJ0BnZW54L2RhdGEnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgbGlua2VyLCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxpbmtlciA9IGxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hLCBzY2hlbWFUb0Nvbm5lY3Rvciwgc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgaWYgKCFza2lwR2VuZXJhdGlvbikge1xuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBwZW5kaW5nRW50aXRpZXMgPSBPYmplY3Qua2V5cyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgd2hpbGUgKHBlbmRpbmdFbnRpdGllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZXQgZW50aXR5TmFtZSA9IHBlbmRpbmdFbnRpdGllcy5zaGlmdCgpO1xuICAgICAgICAgICAgbGV0IGVudGl0eSA9IG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzW2VudGl0eU5hbWVdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7ICBcbiAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgYXNzb2NpYXRpb25zIG9mIGVudGl0eSBcIiR7ZW50aXR5TmFtZX1cIi4uLmApOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGxldCBhc3NvY3MgPSB0aGlzLl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NOYW1lcyA9IGFzc29jcy5yZWR1Y2UoKHJlc3VsdCwgdikgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbdl0gPSB2O1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH0sIHt9KTsgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHMgICAgICAgIFxuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTsgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICAvL2xldCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGVudGl0eU5hbWUgPT09IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgLy9tYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lW2VudGl0eU5hbWVdID0gZW50aXR5LmNvZGU7XG5cbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcblxuICAgICAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG5cbiAgICAgICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2goKHsgZGF0YVNldCwgcnVudGltZUVudiwgcmVjb3JkcyB9KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVjb3JkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQga2V5RmllbGQgPSBlbnRpdHkuZmllbGRzW2ZpZWxkc1swXV07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICgha2V5RmllbGQuYXV0byAmJiAha2V5RmllbGQuZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBrZXkgZmllbGQgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBubyBkZWZhdWx0IHZhbHVlIG9yIGF1dG8tZ2VuZXJhdGVkIHZhbHVlLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkuZ2VtbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5LmdlbWxNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24ocmVjb3JkcywgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5nZW1sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5LmdlbWxNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFTZXQgfHwgKGRhdGFTZXQgPSAnX2luaXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW50aW1lRW52IHx8IChydW50aW1lRW52ID0gJ2RlZmF1bHQnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlcyA9IFsgZGF0YVNldCwgcnVudGltZUVudiBdOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXkgPSBub2Rlcy5qb2luKCcuJyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGRhdGEsIGtleSwgZW50aXR5RGF0YSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICAgICAgbGV0IGluaXRJZHhGaWxlcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIF8uZm9yT3duKGRhdGEsIChlbnZEYXRhLCBkYXRhU2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudkRhdGEsIChlbnRpdGllc0RhdGEsIHJ1bnRpbWVFbnYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0aWVzRGF0YSwgKHJlY29yZHMsIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVOYW1lID0gYDAtJHtlbnRpdHlOYW1lfS5qc29uYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBwYXRoTm9kZXMgPSBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEZpbGVzRGlyLCAnZGF0YScsIGRhdGFTZXQgfHwgJ19pbml0J1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocnVudGltZUVudiAhPT0gJ2RlZmF1bHQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGhOb2Rlcy5wdXNoKHJ1bnRpbWVFbnYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCBpbml0RmlsZU5hbWUpOyAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCAnaW5kZXgubGlzdCcpOyAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChpbml0SWR4RmlsZXMsIFtpZHhGaWxlUGF0aF0sIGluaXRGaWxlTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoeyBbZW50aXR5TmFtZV06IHJlY29yZHMgfSwgbnVsbCwgNCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSkgXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL2NvbnNvbGUuZGlyKGluaXRJZHhGaWxlcywge2RlcHRoOiAxMH0pO1xuXG4gICAgICAgICAgICBfLmZvck93bihpbml0SWR4RmlsZXMsIChsaXN0LCBmaWxlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgICAgIGxldCBtYW51YWwgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGlkeEZpbGVQYXRoKSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMoaWR4RmlsZVBhdGgsICd1dGY4Jykuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgICAgICAgICBsaW5lcy5mb3JFYWNoKGxpbmUgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoJzAtJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYW51YWwucHVzaChsaW5lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKGlkeEZpbGVQYXRoLCBsaXN0LmNvbmNhdChtYW51YWwpLmpvaW4oJ1xcbicpKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfdG9Db2x1bW5SZWZlcmVuY2UobmFtZSkge1xuICAgICAgICByZXR1cm4geyBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJywgbmFtZSB9OyAgXG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZC5ieSkgfTtcbiAgICAgICAgICAgIGxldCB3aXRoRXh0cmEgPSB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIHJlbW90ZUZpZWxkLndpdGgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAobG9jYWxGaWVsZCBpbiB3aXRoRXh0cmEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHJldCwgd2l0aEV4dHJhIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQpIH07XG4gICAgfVxuXG4gICAgX2dldEFsbFJlbGF0ZWRGaWVsZHMocmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKCFyZW1vdGVGaWVsZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5ieTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZW1vdGVGaWVsZDtcbiAgICB9XG5cbiAgICBfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpIHtcbiAgICAgICAgcmV0dXJuIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5tYXAoYXNzb2MgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnaGFzTWFueScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGx1cmFsaXplKGFzc29jLmRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtieV0gW3dpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIFwiJHtlbnRpdHkubmFtZX1cIiAke0pTT04uc3RyaW5naWZ5KGFzc29jKX1gKTsgXG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSwgZGVzdEVudGl0eSwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgWyBkZXN0U2NoZW1hTmFtZSwgYWN0dWFsRGVzdEVudGl0eU5hbWUgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVzdFNjaGVtYSA9IHNjaGVtYS5saW5rZXIuc2NoZW1hc1tkZXN0U2NoZW1hTmFtZV07XG4gICAgICAgICAgICBpZiAoIWRlc3RTY2hlbWEubGlua2VkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZGVzdGluYXRpb24gc2NoZW1hICR7ZGVzdFNjaGVtYU5hbWV9IGhhcyBub3QgYmVlbiBsaW5rZWQgeWV0LiBDdXJyZW50bHkgb25seSBzdXBwb3J0IG9uZS13YXkgcmVmZXJlbmNlIGZvciBjcm9zcyBkYiByZWxhdGlvbi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07IFxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGFjdHVhbERlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5LmdlbWxNb2R1bGUsIGRlc3RFbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSAgIFxuICAgICAgICAgXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQsIGBFbXB0eSBrZXkgZmllbGQgXCIke2Rlc3RFbnRpdHkua2V5RmllbGR9XCIuIERlc3QgZW50aXR5OiAke2Rlc3RFbnRpdHlOYW1lfSwgY3VycmVudCBlbnRpdHk6ICR7ZW50aXR5Lm5hbWV9YDsgXG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb246IGFzc29jIFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5ieS5zcGxpdCgnLicpWzBdIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy53aXRoID0gYXNzb2Mud2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiByZW1vdGVGaWVsZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQgfHwgKHJlbW90ZUZpZWxkID0gZW50aXR5Lm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YocmVtb3RlRmllbGQpID4gLTEgOiByZW1vdGVGaWVsZHMgPT09IHJlbW90ZUZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignXCJtMm5cIiBhc3NvY2lhdGlvbiByZXF1aXJlcyBcImJ5XCIgcHJvcGVydHkuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJyBkZXN0aW5hdGlvbjogJyArIGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb25lL21hbnkgdG8gb25lL21hbnkgcmVsYXRpb25cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0ZWQgYnkgZmllbGQgaXMgdXN1YWxseSBhIHJlZmVyc1RvIGFzc29jXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7IFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gR2VtbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5LmdlbWxNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sIGRlc3RFbnRpdHkua2V5LCByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzJ9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBieS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSkgOiBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcblxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jaGVjayBpZiB0aGUgdGFyZ2V0IGVudGl0eSBoYXMgbG9naWNhbCBkZWxldGlvbiBmZWF0dXJlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHkuaGFzRmVhdHVyZSgnbG9naWNhbERlbGV0aW9uJykpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZGVsZXRpb25DaGVjayA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdCaW5hcnlFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnIT0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogYCR7ZGVzdEVudGl0eU5hbWV9LiR7ZGVzdEVudGl0eS5mZWF0dXJlc1snbG9naWNhbERlbGV0aW9uJ10uZmllbGR9YCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiByZW1vdGVGaWVsZC53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0xvZ2ljYWxFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogJ2FuZCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogYXNzb2Mud2l0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogZGVsZXRpb25DaGVja1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSBkZWxldGlvbkNoZWNrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSwgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBhbmNob3IgfSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmtleSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiByZW1vdGVGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIEdlbWxVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKSBdO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBHZW1sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5nZW1sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogZ2V0IGJhY2sgcmVmIGZyb20gY29ubmVjdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMSA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJywgc3JjRmllbGQ6IChmKSA9PiBfLmlzTmlsKGYpIHx8IGYgPT0gY29ubmVjdGVkQnlGaWVsZCB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZW50aXR5Lm5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMiA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZGVzdEVudGl0eU5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJyB9LCB7IGFzc29jaWF0aW9uOiBjb25uQmFja1JlZjEgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtkZXN0RW50aXR5TmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGNvbm5CYWNrUmVmMi5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4gRGV0YWlsOiAnICsgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdDogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IGFzc29jLnNyY0ZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgKyAnLicgKyBjb25uZWN0ZWRCeUZpZWxkMiwgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMS13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RmllbGROYW1lID0gZGVzdEtleUZpZWxkLm5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RLZXlGaWVsZDtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5kZXN0RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghZGVzdEVudGl0eS5oYXNGaWVsZChhc3NvYy5kZXN0RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZmllbGQgXCIke2Fzc29jLmRlc3RGaWVsZH1cIiBiZWluZyByZWZlcmVuY2VkIGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RGaWVsZE5hbWUgPSBhc3NvYy5kZXN0RmllbGQ7ICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RFbnRpdHkuZmllbGRzW2Rlc3RGaWVsZE5hbWVdOyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGFnICs9ICctPicgKyBhc3NvYy5kZXN0RmllbGQ7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCBieSBjb25uZWN0aW9uLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZyk7ICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgd2VlayByZWZlcmVuY2U6ICR7dGFnfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBqb2luT24gPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UobG9jYWxGaWVsZCArICcuJyArIGRlc3RGaWVsZE5hbWUpIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGpvaW5PbiwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGxvY2FsRmllbGQgfSwgYXNzb2Mud2l0aCkpOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCByZWZlcmVuY2VkRmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGRlc3RGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogam9pbk9uIFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIC8vZm9yZWlnbiBrZXkgY29uc3RyYWl0c1xuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkT2JqID0gZW50aXR5LmZpZWxkc1tsb2NhbEZpZWxkXTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBjb25zdHJhaW50cyA9IHt9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGU7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSA9IGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ0NBU0NBREUnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ0NBU0NBREUnKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobG9jYWxGaWVsZE9iai5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnU0VUIE5VTEwnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ1NFVCBOVUxMJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ05PIEFDVElPTicpO1xuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdOTyBBQ1RJT04nKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RGaWVsZE5hbWUsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uKSB7XG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICchPScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJG5lJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZztcblxuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckZXEnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgXG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJG5lJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07ICAgICBcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIFVuYXJ5RXhwcmVzc2lvbiBvcGVyYXRvcjogJyArIG9vbENvbi5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgJG9yOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIHN5bnRheDogJyArIEpTT04uc3RyaW5naWZ5KG9vbENvbikpO1xuICAgIH1cblxuICAgIF90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmVmLCBhc0tleSkge1xuICAgICAgICBsZXQgWyBiYXNlLCAuLi5vdGhlciBdID0gcmVmLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgbGV0IHRyYW5zbGF0ZWQgPSBjb250ZXh0W2Jhc2VdO1xuICAgICAgICBpZiAoIXRyYW5zbGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGNvbnRleHQpO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZk5hbWUgPSBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuXG4gICAgICAgIGlmIChhc0tleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZk5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UocmVmTmFtZSk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkLCBjb25zdHJhaW50cykge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICBsZWZ0RmllbGQuZm9yRWFjaChsZiA9PiB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGYsIHJpZ2h0LCByaWdodEZpZWxkLCBjb25zdHJhaW50cykpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLmJ5LCByaWdodC4gcmlnaHRGaWVsZCwgY29uc3RyYWludHMpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgbGVmdEZpZWxkID09PSAnc3RyaW5nJztcblxuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSByZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkLCBjb25zdHJhaW50cyB9KTsgXG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKHNjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZlYXR1cmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbmNlKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZlYXR1cmUuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VzZXJFZGl0VHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY2hhbmdlTG9nJzpcbiAgICAgICAgICAgICAgICBsZXQgY2hhbmdlTG9nU2V0dGluZ3MgPSBVdGlsLmdldFZhbHVlQnlQYXRoKHNjaGVtYS5kZXBsb3ltZW50U2V0dGluZ3MsICdmZWF0dXJlcy5jaGFuZ2VMb2cnKTtcblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIFwiY2hhbmdlTG9nXCIgZmVhdHVyZSBzZXR0aW5ncyBpbiBkZXBsb3ltZW50IGNvbmZpZyBmb3Igc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncy5kYXRhU291cmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjaGFuZ2VMb2cuZGF0YVNvdXJjZVwiIGlzIHJlcXVpcmVkLiBTY2hlbWE6ICR7c2NoZW1hLm5hbWV9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihmZWF0dXJlLCBjaGFuZ2VMb2dTZXR0aW5ncyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdhdXRvSWQnLCAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAgaW5kZXhlczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJmaWVsZHNcIjogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdLFxuICAgICAgICAgICAgICAgICAgICBcInVuaXF1ZVwiOiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTFOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTFSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5Mk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MlJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5nZW1sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IHJlbGF0aW9uRW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTIgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTJOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQyIFxuICAgICAqL1xuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykgeyAgICAgIFxuICAgICAgICAgICAgLy8gY2hlY2sgaWYgdGhlIHJlbGF0aW9uIGVudGl0eSBoYXMgdGhlIHJlZmVyc1RvIGJvdGggc2lkZSBvZiBhc3NvY2lhdGlvbnMgICAgICAgIFxuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MU5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MSA9IHRydWU7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTJOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgLy95ZXMsIGRvbid0IG5lZWQgdG8gYWRkIHJlZmVyc1RvIHRvIHRoZSByZWxhdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdGFnMSA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTFOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZH1gO1xuICAgICAgICBsZXQgdGFnMiA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTJOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZDJ9YDtcblxuICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSkge1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpO1xuXG4gICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG5cbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICBcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMn1gKTtcblxuICAgICAgICBsZXQga2V5RW50aXR5MSA9IGVudGl0eTEuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTFOYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTJOYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBrZXlFbnRpdHkxKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Miwga2V5RW50aXR5Mik7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkxTmFtZSB9XG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTJOYW1lIH1cbiAgICAgICAgKTtcblxuICAgICAgICBsZXQgYWxsQ2FzY2FkZSA9IHsgb25VcGRhdGU6ICdSRVNUUklDVCcsIG9uRGVsZXRlOiAnUkVTVFJJQ1QnIH07XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSwgYWxsQ2FzY2FkZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lLCBhbGxDYXNjYWRlKTsgICAgICAgIFxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFHZW1sVXRpbHMuaXNNZW1iZXJBY2Nlc3Mob29sLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJhbXMgJiYgXy5maW5kKHBhcmFtcywgcCA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAncCcgKyBfLnVwcGVyRmlyc3Qob29sLm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCB7IGVudGl0eU5vZGUsIGVudGl0eSwgZmllbGQgfSA9IEdlbWxVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9Ki9cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24sIHNjaGVtYVRvQ29ubmVjdG9yLyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykge1xuICAgICAgICBsZXQgcmVmVGFibGUgPSByZWxhdGlvbi5yaWdodDtcblxuICAgICAgICBpZiAocmVmVGFibGUuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgcmVmRW50aXR5TmFtZSBdID0gcmVmVGFibGUuc3BsaXQoJy4nKTsgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHRhcmdldENvbm5lY3RvciA9IHNjaGVtYVRvQ29ubmVjdG9yW3NjaGVtYU5hbWVdO1xuICAgICAgICAgICAgYXNzZXJ0OiB0YXJnZXRDb25uZWN0b3I7XG5cbiAgICAgICAgICAgIHJlZlRhYmxlID0gdGFyZ2V0Q29ubmVjdG9yLmRhdGFiYXNlICsgJ2AuYCcgKyByZWZFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlZlRhYmxlICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSBgT04gVVBEQVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25VcGRhdGV9IE9OIERFTEVURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uRGVsZXRlfTtcXG5gO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdvYmplY3QnICYmIGRlZmF1bHRWYWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHRva2VuTmFtZSA9IGRlZmF1bHRWYWx1ZS5uYW1lLnRvVXBwZXJDYXNlKCk7XG5cbiAgICAgICAgICAgICAgICAgICAgc3dpdGNoICh0b2tlbk5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ05PVyc6XG4gICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVygpJztcbiAgICAgICAgICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHN5bWJvbCB0b2tlbiBcIiR7dG9rZW5OYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG5cbiAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChpbmZvLnR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoVHlwZXMuREFURVRJTUUuc2FuaXRpemUoZGVmYXVsdFZhbHVlKS50b1NRTCh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrOyAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDogICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgdHlwZSBcIiR7aW5mby50eXBlfVwiYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL25vdCBleHBsaWNpdCBzcGVjaWZpZWQsIHdpbGwgbm90IHRyZWF0ZWQgYXMgY3JlYXRlQnlEYlxuICAgICAgICAgICAgICAgIC8vaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gR2VtbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=