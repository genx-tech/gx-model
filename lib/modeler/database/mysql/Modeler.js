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

const OolUtils = require('../../../lang/OolUtils');

const {
  pluralize,
  isDotSeparateName,
  extractDotSeparateName
} = OolUtils;

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
                    [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)
                  };
                } else {
                  record = this.linker.translateOolValue(entity.oolModule, record);
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
                    [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)
                  };
                } else {
                  record = Object.assign({
                    [entity.key]: key
                  }, this.linker.translateOolValue(entity.oolModule, record));
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
      destEntity = schema.ensureGetEntity(entity.oolModule, destEntityName, pendingEntities);

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
            let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

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

            let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

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
          let connectedByParts = assoc.by ? assoc.by.split('.') : [OolUtils.prefixNaming(entity.name, destEntityName)];

          if (!(connectedByParts.length <= 2)) {
            throw new Error("Assertion failed: connectedByParts.length <= 2");
          }

          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

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

          let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

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
    let entity = new Entity(this.linker, relationEntityName, schema.oolModule, entityInfo);
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
        if (!OolUtils.isMemberAccess(ool.name)) {
          if (params && _.find(params, p => p.name === ool.name) !== -1) {
            return 'p' + _.upperFirst(ool.name);
          }

          throw new Error(`Referencing to a non-existing param "${ool.name}".`);
        }

        let {
          entityNode,
          entity,
          field
        } = OolUtils.parseReferenceInDocument(schema, doc, ool.name);
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

    return OolUtils.entityNaming(entityName);
  }

}

module.exports = MySQLModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJzY2hlbWFUb0Nvbm5lY3RvciIsInNraXBHZW5lcmF0aW9uIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJrZXlzIiwiZW50aXRpZXMiLCJsZW5ndGgiLCJlbnRpdHlOYW1lIiwic2hpZnQiLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVhY2giLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZGF0YVNldCIsInJ1bnRpbWVFbnYiLCJyZWNvcmRzIiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlGaWVsZCIsImF1dG8iLCJkZWZhdWx0QnlEYiIsInRyYW5zbGF0ZU9vbFZhbHVlIiwib29sTW9kdWxlIiwicHVzaCIsImFzc2lnbiIsIm5vZGVzIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJpbml0SWR4RmlsZXMiLCJlbnZEYXRhIiwiZW50aXRpZXNEYXRhIiwiaW5pdEZpbGVOYW1lIiwicGF0aE5vZGVzIiwiaW5pdEZpbGVQYXRoIiwiaWR4RmlsZVBhdGgiLCJKU09OIiwic3RyaW5naWZ5IiwibGlzdCIsImZpbGVQYXRoIiwibWFudWFsIiwiZXhpc3RzU3luYyIsImxpbmVzIiwicmVhZEZpbGVTeW5jIiwic3BsaXQiLCJsaW5lIiwic3RhcnRzV2l0aCIsImNvbmNhdCIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lIiwiZGVzdFNjaGVtYU5hbWUiLCJhY3R1YWxEZXN0RW50aXR5TmFtZSIsImRlc3RTY2hlbWEiLCJzY2hlbWFzIiwibGlua2VkIiwiZW5zdXJlR2V0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjYiIsInJlbW90ZUZpZWxkcyIsImlzTmlsIiwiaW5kZXhPZiIsImJhY2tSZWYiLCJnZXRSZWZlcmVuY2VUbyIsImNvbm5lY3RlZEJ5UGFydHMiLCJjb25uZWN0ZWRCeUZpZWxkIiwiY29ubkVudGl0eU5hbWUiLCJlbnRpdHlOYW1pbmciLCJ0YWcxIiwidGFnMiIsImhhcyIsImNvbm5lY3RlZEJ5UGFydHMyIiwiY29ubmVjdGVkQnlGaWVsZDIiLCJjb25uRW50aXR5IiwiX2FkZFJlbGF0aW9uRW50aXR5IiwiX3VwZGF0ZVJlbGF0aW9uRW50aXR5IiwibG9jYWxGaWVsZE5hbWUiLCJhZGRBc3NvY2lhdGlvbiIsIm9uIiwiZmllbGQiLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJoYXNGZWF0dXJlIiwiZGVsZXRpb25DaGVjayIsIm9vbFR5cGUiLCJvcGVyYXRvciIsImxlZnQiLCJyaWdodCIsInByZWZpeE5hbWluZyIsImNvbm5CYWNrUmVmMSIsImNvbm5CYWNrUmVmMiIsInNyYyIsImRlc3QiLCJkZXN0RmllbGROYW1lIiwicmVmZXJlbmNlZEZpZWxkIiwidGFnIiwiZGVzdEZpZWxkIiwiaGFzRmllbGQiLCJqb2luT24iLCJhZGRBc3NvY0ZpZWxkIiwiZmllbGRQcm9wcyIsImxvY2FsRmllbGRPYmoiLCJjb25zdHJhaW50cyIsImNvbnN0cmFpbnRPblVwZGF0ZSIsIm9uVXBkYXRlIiwiY29uc3RyYWludE9uRGVsZXRlIiwib25EZWxldGUiLCJvcHRpb25hbCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJfdHJhbnNsYXRlUmVmZXJlbmNlIiwiYXJnIiwiYXJndW1lbnQiLCIkb3IiLCJhc0tleSIsImJhc2UiLCJvdGhlciIsInRyYW5zbGF0ZWQiLCJjb25zb2xlIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJsZiIsInJlZnM0TGVmdEVudGl0eSIsImZvdW5kIiwiZmluZCIsIml0ZW0iLCJfZ2V0UmVmZXJlbmNlT2ZGaWVsZCIsInJlZmVyZW5jZSIsIl9oYXNSZWZlcmVuY2VPZkZpZWxkIiwiX2dldFJlZmVyZW5jZUJldHdlZW4iLCJfaGFzUmVmZXJlbmNlQmV0d2VlbiIsImZlYXR1cmUiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRlcGxveW1lbnRTZXR0aW5ncyIsImRhdGFTb3VyY2UiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MU5hbWUiLCJlbnRpdHkyTmFtZSIsImVudGl0eTFSZWZGaWVsZCIsImVudGl0eTJSZWZGaWVsZCIsImVudGl0eUluZm8iLCJpbmRleGVzIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsImFsbENhc2NhZGUiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4IiwidW5pcXVlIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJyZWZFbnRpdHlOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVu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QUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUlyVixDQUFDLENBQUN5SCxVQUFGLENBQWE3RSxVQUFiLEVBQXlCeVMsaUJBQXpCLENBQUosRUFBaUQ7QUFDN0N6UyxRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQzhQLE1BQVgsQ0FBa0IyQyxpQkFBaUIsQ0FBQzFTLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU92QyxRQUFRLENBQUNvSyxZQUFULENBQXNCNUgsVUFBdEIsQ0FBUDtBQUNIOztBQWprRGM7O0FBb2tEbkI2UyxNQUFNLENBQUNDLE9BQVAsR0FBaUI5VSxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUsIHB1dEludG9CdWNrZXQgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCB7IFR5cGVzIH0gPSByZXF1aXJlKCdAZ2VueC9kYXRhJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSwgc2NoZW1hVG9Db25uZWN0b3IsIHNraXBHZW5lcmF0aW9uKSB7XG4gICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgcGVuZGluZ0VudGl0aWVzID0gT2JqZWN0LmtleXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eU5hbWUgPSBwZW5kaW5nRW50aXRpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBtb2RlbGluZ1NjaGVtYS5lbnRpdGllc1tlbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eU5hbWV9XCIuLi5gKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzICAgICAgICBcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgLy9sZXQgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBlbnRpdHlOYW1lID09PSBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgIC8vbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZVtlbnRpdHlOYW1lXSA9IGVudGl0eS5jb2RlO1xuXG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIXNraXBHZW5lcmF0aW9uKSB7XG5cbiAgICAgICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuXG4gICAgICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKCh7IGRhdGFTZXQsIHJ1bnRpbWVFbnYsIHJlY29yZHMgfSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlY29yZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gZW50aXR5LmZpZWxkc1tmaWVsZHNbMF1dO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWtleUZpZWxkLmF1dG8gJiYgIWtleUZpZWxkLmRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbm8gZGVmYXVsdCB2YWx1ZSBvciBhdXRvLWdlbmVyYXRlZCB2YWx1ZS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBfLmZvck93bihyZWNvcmRzLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFTZXQgfHwgKGRhdGFTZXQgPSAnX2luaXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW50aW1lRW52IHx8IChydW50aW1lRW52ID0gJ2RlZmF1bHQnKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlcyA9IFsgZGF0YVNldCwgcnVudGltZUVudiBdOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXkgPSBub2Rlcy5qb2luKCcuJyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGRhdGEsIGtleSwgZW50aXR5RGF0YSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmICghc2tpcEdlbmVyYXRpb24pIHtcbiAgICAgICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICAgICAgbGV0IGluaXRJZHhGaWxlcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIF8uZm9yT3duKGRhdGEsIChlbnZEYXRhLCBkYXRhU2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudkRhdGEsIChlbnRpdGllc0RhdGEsIHJ1bnRpbWVFbnYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0aWVzRGF0YSwgKHJlY29yZHMsIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVOYW1lID0gYDAtJHtlbnRpdHlOYW1lfS5qc29uYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBwYXRoTm9kZXMgPSBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEZpbGVzRGlyLCAnZGF0YScsIGRhdGFTZXQgfHwgJ19pbml0J1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocnVudGltZUVudiAhPT0gJ2RlZmF1bHQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGhOb2Rlcy5wdXNoKHJ1bnRpbWVFbnYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCBpbml0RmlsZU5hbWUpOyAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgaWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCAnaW5kZXgubGlzdCcpOyAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChpbml0SWR4RmlsZXMsIFtpZHhGaWxlUGF0aF0sIGluaXRGaWxlTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoeyBbZW50aXR5TmFtZV06IHJlY29yZHMgfSwgbnVsbCwgNCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSkgXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL2NvbnNvbGUuZGlyKGluaXRJZHhGaWxlcywge2RlcHRoOiAxMH0pO1xuXG4gICAgICAgICAgICBfLmZvck93bihpbml0SWR4RmlsZXMsIChsaXN0LCBmaWxlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgICAgIGxldCBtYW51YWwgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGlkeEZpbGVQYXRoKSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMoaWR4RmlsZVBhdGgsICd1dGY4Jykuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgICAgICAgICBsaW5lcy5mb3JFYWNoKGxpbmUgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoJzAtJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYW51YWwucHVzaChsaW5lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKGlkeEZpbGVQYXRoLCBsaXN0LmNvbmNhdChtYW51YWwpLmpvaW4oJ1xcbicpKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfdG9Db2x1bW5SZWZlcmVuY2UobmFtZSkge1xuICAgICAgICByZXR1cm4geyBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJywgbmFtZSB9OyAgXG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZC5ieSkgfTtcbiAgICAgICAgICAgIGxldCB3aXRoRXh0cmEgPSB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIHJlbW90ZUZpZWxkLndpdGgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAobG9jYWxGaWVsZCBpbiB3aXRoRXh0cmEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHJldCwgd2l0aEV4dHJhIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQpIH07XG4gICAgfVxuXG4gICAgX2dldEFsbFJlbGF0ZWRGaWVsZHMocmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKCFyZW1vdGVGaWVsZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5ieTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZW1vdGVGaWVsZDtcbiAgICB9XG5cbiAgICBfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpIHtcbiAgICAgICAgcmV0dXJuIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5tYXAoYXNzb2MgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnaGFzTWFueScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGx1cmFsaXplKGFzc29jLmRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtieV0gW3dpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIFwiJHtlbnRpdHkubmFtZX1cIiAke0pTT04uc3RyaW5naWZ5KGFzc29jKX1gKTsgXG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSwgZGVzdEVudGl0eSwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgWyBkZXN0U2NoZW1hTmFtZSwgYWN0dWFsRGVzdEVudGl0eU5hbWUgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVzdFNjaGVtYSA9IHNjaGVtYS5saW5rZXIuc2NoZW1hc1tkZXN0U2NoZW1hTmFtZV07XG4gICAgICAgICAgICBpZiAoIWRlc3RTY2hlbWEubGlua2VkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZGVzdGluYXRpb24gc2NoZW1hICR7ZGVzdFNjaGVtYU5hbWV9IGhhcyBub3QgYmVlbiBsaW5rZWQgeWV0LiBDdXJyZW50bHkgb25seSBzdXBwb3J0IG9uZS13YXkgcmVmZXJlbmNlIGZvciBjcm9zcyBkYiByZWxhdGlvbi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07IFxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGFjdHVhbERlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgZGVzdEVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgXG4gICAgICAgICBcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6IGRlc3RLZXlGaWVsZCwgYEVtcHR5IGtleSBmaWVsZCBcIiR7ZGVzdEVudGl0eS5rZXlGaWVsZH1cIi4gRGVzdCBlbnRpdHk6ICR7ZGVzdEVudGl0eU5hbWV9LCBjdXJyZW50IGVudGl0eTogJHtlbnRpdHkubmFtZX1gOyBcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLndpdGggPSBhc3NvYy53aXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiYnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvbmUvbWFueSB0byBvbmUvbWFueSByZWxhdGlvblxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sIGRlc3RFbnRpdHkua2V5LCByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzJ9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBieS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSkgOiBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcblxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jaGVjayBpZiB0aGUgdGFyZ2V0IGVudGl0eSBoYXMgbG9naWNhbCBkZWxldGlvbiBmZWF0dXJlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRlc3RFbnRpdHkuaGFzRmVhdHVyZSgnbG9naWNhbERlbGV0aW9uJykpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZGVsZXRpb25DaGVjayA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdCaW5hcnlFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnIT0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogYCR7ZGVzdEVudGl0eU5hbWV9LiR7ZGVzdEVudGl0eS5mZWF0dXJlc1snbG9naWNhbERlbGV0aW9uJ10uZmllbGR9YCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiByZW1vdGVGaWVsZC53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0xvZ2ljYWxFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogJ2FuZCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogYXNzb2Mud2l0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogZGVsZXRpb25DaGVja1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPSBkZWxldGlvbkNoZWNrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSwgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBhbmNob3IgfSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmtleSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiByZW1vdGVGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogZ2V0IGJhY2sgcmVmIGZyb20gY29ubmVjdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMSA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJywgc3JjRmllbGQ6IChmKSA9PiBfLmlzTmlsKGYpIHx8IGYgPT0gY29ubmVjdGVkQnlGaWVsZCB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZW50aXR5Lm5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMiA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZGVzdEVudGl0eU5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJyB9LCB7IGFzc29jaWF0aW9uOiBjb25uQmFja1JlZjEgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtkZXN0RW50aXR5TmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGNvbm5CYWNrUmVmMi5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4gRGV0YWlsOiAnICsgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdDogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IGFzc29jLnNyY0ZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgKyAnLicgKyBjb25uZWN0ZWRCeUZpZWxkMiwgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMS13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RmllbGROYW1lID0gZGVzdEtleUZpZWxkLm5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RLZXlGaWVsZDtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5kZXN0RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghZGVzdEVudGl0eS5oYXNGaWVsZChhc3NvYy5kZXN0RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZmllbGQgXCIke2Fzc29jLmRlc3RGaWVsZH1cIiBiZWluZyByZWZlcmVuY2VkIGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RGaWVsZE5hbWUgPSBhc3NvYy5kZXN0RmllbGQ7ICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RFbnRpdHkuZmllbGRzW2Rlc3RGaWVsZE5hbWVdOyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGFnICs9ICctPicgKyBhc3NvYy5kZXN0RmllbGQ7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCBieSBjb25uZWN0aW9uLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZyk7ICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgd2VlayByZWZlcmVuY2U6ICR7dGFnfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBqb2luT24gPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UobG9jYWxGaWVsZCArICcuJyArIGRlc3RGaWVsZE5hbWUpIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGpvaW5PbiwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGxvY2FsRmllbGQgfSwgYXNzb2Mud2l0aCkpOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCByZWZlcmVuY2VkRmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBhc3NvYy50eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGRlc3RGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogam9pbk9uIFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIC8vZm9yZWlnbiBrZXkgY29uc3RyYWl0c1xuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkT2JqID0gZW50aXR5LmZpZWxkc1tsb2NhbEZpZWxkXTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBjb25zdHJhaW50cyA9IHt9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGU7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnUkVTVFJJQ1QnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ1JFU1RSSUNUJyk7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGxvY2FsRmllbGRPYmoub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ1NFVCBOVUxMJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdOTyBBQ1RJT04nKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnTk8gQUNUSU9OJyk7XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0RmllbGROYW1lLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnIT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRuZSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmc7XG5cbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJGVxJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07IFxuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRuZSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgXG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBVbmFyeUV4cHJlc3Npb24gb3BlcmF0b3I6ICcgKyBvb2xDb24ub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRvcjogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2gobGYgPT4gdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxmLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMgfSk7IFxuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXNlckVkaXRUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjaGFuZ2VMb2cnOlxuICAgICAgICAgICAgICAgIGxldCBjaGFuZ2VMb2dTZXR0aW5ncyA9IFV0aWwuZ2V0VmFsdWVCeVBhdGgoc2NoZW1hLmRlcGxveW1lbnRTZXR0aW5ncywgJ2ZlYXR1cmVzLmNoYW5nZUxvZycpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgXCJjaGFuZ2VMb2dcIiBmZWF0dXJlIHNldHRpbmdzIGluIGRlcGxveW1lbnQgY29uZmlnIGZvciBzY2hlbWEgWyR7c2NoZW1hLm5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzLmRhdGFTb3VyY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNoYW5nZUxvZy5kYXRhU291cmNlXCIgaXMgcmVxdWlyZWQuIFNjaGVtYTogJHtzY2hlbWEubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGZlYXR1cmUsIGNoYW5nZUxvZ1NldHRpbmdzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2F1dG9JZCcsICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBpbmRleGVzOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcImZpZWxkc1wiOiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF0sXG4gICAgICAgICAgICAgICAgICAgIFwidW5pcXVlXCI6IHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5MU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MVJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkyUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSByZWxhdGlvbkVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MU5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkMiBcbiAgICAgKi9cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHsgICAgICBcbiAgICAgICAgICAgIC8vIGNoZWNrIGlmIHRoZSByZWxhdGlvbiBlbnRpdHkgaGFzIHRoZSByZWZlcnNUbyBib3RoIHNpZGUgb2YgYXNzb2NpYXRpb25zICAgICAgICBcbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5lYWNoKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zLCBhc3NvYyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5MU5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTFOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5Mk5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIC8veWVzLCBkb24ndCBuZWVkIHRvIGFkZCByZWZlcnNUbyB0byB0aGUgcmVsYXRpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRhZzEgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkxTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGR9YDtcbiAgICAgICAgbGV0IHRhZzIgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkyTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGQyfWA7XG5cbiAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkpIHtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKTtcblxuICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgIFxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxTmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyTmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwga2V5RW50aXR5MSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIGtleUVudGl0eTIpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5MU5hbWUgfVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkyTmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgbGV0IGFsbENhc2NhZGUgPSB7IG9uVXBkYXRlOiAnUkVTVFJJQ1QnLCBvbkRlbGV0ZTogJ1JFU1RSSUNUJyB9O1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTFOYW1lLCBrZXlFbnRpdHkxLm5hbWUsIGFsbENhc2NhZGUpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Mk5hbWUsIGtleUVudGl0eTIubmFtZSwgYWxsQ2FzY2FkZSk7ICAgICAgICBcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbE9wVG9TcWwob3ApIHtcbiAgICAgICAgc3dpdGNoIChvcCkge1xuICAgICAgICAgICAgY2FzZSAnPSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuICc9JztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbE9wVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7ICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLCBwYXJhbXMpIHtcbiAgICAgICAgaWYgKCFvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9vbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAob29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgIGxldCBsZWZ0LCByaWdodDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAob29sLmxlZnQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wubGVmdCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gb29sLmxlZnQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5yaWdodC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wucmlnaHQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBvb2wucmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgJyAnICsgTXlTUUxNb2RlbGVyLm9vbE9wVG9TcWwob29sLm9wZXJhdG9yKSArICcgJyArIHJpZ2h0O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdPYmplY3RSZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgIGlmICghT29sVXRpbHMuaXNNZW1iZXJBY2Nlc3Mob29sLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJhbXMgJiYgXy5maW5kKHBhcmFtcywgcCA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAncCcgKyBfLnVwcGVyRmlyc3Qob29sLm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCB7IGVudGl0eU5vZGUsIGVudGl0eSwgZmllbGQgfSA9IE9vbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgLypcbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH0qL1xuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbiwgc2NoZW1hVG9Db25uZWN0b3IvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCByZWZUYWJsZSA9IHJlbGF0aW9uLnJpZ2h0O1xuXG4gICAgICAgIGlmIChyZWZUYWJsZS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCByZWZFbnRpdHlOYW1lIF0gPSByZWZUYWJsZS5zcGxpdCgnLicpOyAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0Q29ubmVjdG9yID0gc2NoZW1hVG9Db25uZWN0b3Jbc2NoZW1hTmFtZV07XG4gICAgICAgICAgICBhc3NlcnQ6IHRhcmdldENvbm5lY3RvcjtcblxuICAgICAgICAgICAgcmVmVGFibGUgPSB0YXJnZXRDb25uZWN0b3IuZGF0YWJhc2UgKyAnYC5gJyArIHJlZkVudGl0eU5hbWU7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVmVGFibGUgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9IGBPTiBVUERBVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vblVwZGF0ZX0gT04gREVMRVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25EZWxldGV9O1xcbmA7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdudW1iZXInICYmIGluZm8uZXhhY3QpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIEFVVE9fSU5DUkVNRU5UJztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBPTiBVUERBVEUgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICcnO1xuXG4gICAgICAgIGlmICghaW5mby5vcHRpb25hbCkgeyAgICAgIFxuICAgICAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvWydkZWZhdWx0J107XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFR5cGVzLkJPT0xFQU4uc2FuaXRpemUoZGVmYXVsdFZhbHVlKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdG9kbzogb3RoZXIgdHlwZXNcblxuICAgICAgICAgICAgfSBlbHNlIGlmICghaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicgfHwgaW5mby50eXBlID09PSAnaW50ZWdlcicgfHwgaW5mby50eXBlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZW51bScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICB9ICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gT29sVXRpbHMuZW50aXR5TmFtaW5nKGVudGl0eU5hbWUpO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyOyJdfQ==