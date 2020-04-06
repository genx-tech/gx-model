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

  modeling(schema, schemaToConnector) {
    this.linker.log('info', 'Generating mysql scripts for schema "' + schema.name + '"...');
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
    });

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
      throw new Error(`Empty key field. Entity: ${destEntityName}`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJzY2hlbWFUb0Nvbm5lY3RvciIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJub2RlcyIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiaW5pdElkeEZpbGVzIiwiZW52RGF0YSIsImVudGl0aWVzRGF0YSIsImluaXRGaWxlTmFtZSIsInBhdGhOb2RlcyIsImluaXRGaWxlUGF0aCIsImlkeEZpbGVQYXRoIiwiSlNPTiIsInN0cmluZ2lmeSIsImxpc3QiLCJmaWxlUGF0aCIsIm1hbnVhbCIsImV4aXN0c1N5bmMiLCJsaW5lcyIsInJlYWRGaWxlU3luYyIsInNwbGl0IiwibGluZSIsInN0YXJ0c1dpdGgiLCJjb25jYXQiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsIl90b0NvbHVtblJlZmVyZW5jZSIsIm9vclR5cGUiLCJfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbiIsImxvY2FsRmllbGQiLCJhbmNob3IiLCJyZW1vdGVGaWVsZCIsIm1hcCIsInJmIiwicmV0IiwiYnkiLCJ3aXRoRXh0cmEiLCJfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbiIsIndpdGgiLCIkYW5kIiwiX2dldEFsbFJlbGF0ZWRGaWVsZHMiLCJ1bmRlZmluZWQiLCJzcmNGaWVsZCIsInR5cGUiLCJkZXN0RW50aXR5IiwiZW50aXR5S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSIsImRlc3RTY2hlbWFOYW1lIiwiYWN0dWFsRGVzdEVudGl0eU5hbWUiLCJkZXN0U2NoZW1hIiwic2NoZW1hcyIsImxpbmtlZCIsImVuc3VyZUdldEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImluY2x1ZGVzIiwiZXhjbHVkZXMiLCJ0eXBlcyIsImFzc29jaWF0aW9uIiwiY2IiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwiaGFzRmVhdHVyZSIsImRlbGV0aW9uQ2hlY2siLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwicmlnaHQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwiZGVzdEZpZWxkTmFtZSIsInJlZmVyZW5jZWRGaWVsZCIsInRhZyIsImRlc3RGaWVsZCIsImhhc0ZpZWxkIiwiam9pbk9uIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJsb2NhbEZpZWxkT2JqIiwiY29uc3RyYWludHMiLCJjb25zdHJhaW50T25VcGRhdGUiLCJvblVwZGF0ZSIsImNvbnN0cmFpbnRPbkRlbGV0ZSIsIm9uRGVsZXRlIiwib3B0aW9uYWwiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsImFyZyIsImFyZ3VtZW50IiwiJG9yIiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwiY29uc29sZSIsInJlZk5hbWUiLCJsZWZ0RmllbGQiLCJyaWdodEZpZWxkIiwibGYiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZ2VuZXJhdG9yIiwiYXV0b0luY3JlbWVudElkIiwiZXh0cmFPcHRzIiwic3RhcnRGcm9tIiwiaXNDcmVhdGVUaW1lc3RhbXAiLCJpc1VwZGF0ZVRpbWVzdGFtcCIsImNoYW5nZUxvZ1NldHRpbmdzIiwiZ2V0VmFsdWVCeVBhdGgiLCJkZXBsb3ltZW50U2V0dGluZ3MiLCJkYXRhU291cmNlIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsInJlbGF0aW9uRW50aXR5TmFtZSIsImVudGl0eTFOYW1lIiwiZW50aXR5Mk5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwiaW5kZXhlcyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJhbGxDYXNjYWRlIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0IiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleCIsInVuaXF1ZSIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlbGF0aW9uIiwicmVmVGFibGUiLCJzY2hlbWFOYW1lIiwicmVmRW50aXR5TmFtZSIsInRhcmdldENvbm5lY3RvciIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwicGFzY2FsQ2FzZSIsImVuZHNXaXRoIiwicXVvdGVTdHJpbmciLCJzdHIiLCJyZXBsYWNlIiwib2JqIiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwidmFsdWVzIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJtb2R1bGUiLCJleHBv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QUFRLENBQUNtSyxZQUFULENBQXNCNUgsVUFBdEIsQ0FBUDtBQUNIOztBQTFqRGM7O0FBNmpEbkI2UyxNQUFNLENBQUNDLE9BQVAsR0FBaUI3VSxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUsIHB1dEludG9CdWNrZXQgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCB7IFR5cGVzIH0gPSByZXF1aXJlKCdAZ2VueC9kYXRhJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgcGVuZGluZ0VudGl0aWVzID0gT2JqZWN0LmtleXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eU5hbWUgPSBwZW5kaW5nRW50aXRpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBtb2RlbGluZ1NjaGVtYS5lbnRpdGllc1tlbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eU5hbWV9XCIuLi5gKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzICAgICAgICBcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgLy9sZXQgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBlbnRpdHlOYW1lID09PSBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgIC8vbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZVtlbnRpdHlOYW1lXSA9IGVudGl0eS5jb2RlO1xuXG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaCgoeyBkYXRhU2V0LCBydW50aW1lRW52LCByZWNvcmRzIH0pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlY29yZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQga2V5RmllbGQgPSBlbnRpdHkuZmllbGRzW2ZpZWxkc1swXV07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFrZXlGaWVsZC5hdXRvICYmICFrZXlGaWVsZC5kZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbm8gZGVmYXVsdCB2YWx1ZSBvciBhdXRvLWdlbmVyYXRlZCB2YWx1ZS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBfLmZvck93bihyZWNvcmRzLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFTZXQgfHwgKGRhdGFTZXQgPSAnX2luaXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJ1bnRpbWVFbnYgfHwgKHJ1bnRpbWVFbnYgPSAnZGVmYXVsdCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbm9kZXMgPSBbIGRhdGFTZXQsIHJ1bnRpbWVFbnYgXTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGtleSA9IG5vZGVzLmpvaW4oJy4nKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChkYXRhLCBrZXksIGVudGl0eURhdGEsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZiwgc2NoZW1hVG9Db25uZWN0b3IvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBsZXQgaW5pdElkeEZpbGVzID0ge307XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZm9yT3duKGRhdGEsIChlbnZEYXRhLCBkYXRhU2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW52RGF0YSwgKGVudGl0aWVzRGF0YSwgcnVudGltZUVudikgPT4ge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdGllc0RhdGEsIChyZWNvcmRzLCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVOYW1lID0gYDAtJHtlbnRpdHlOYW1lfS5qc29uYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHBhdGhOb2RlcyA9IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxGaWxlc0RpciwgJ2RhdGEnLCBkYXRhU2V0IHx8ICdfaW5pdCdcbiAgICAgICAgICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChydW50aW1lRW52ICE9PSAnZGVmYXVsdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXRoTm9kZXMucHVzaChydW50aW1lRW52KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbiguLi5wYXRoTm9kZXMsIGluaXRGaWxlTmFtZSk7ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGlkeEZpbGVQYXRoID0gcGF0aC5qb2luKC4uLnBhdGhOb2RlcywgJ2luZGV4Lmxpc3QnKTsgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGluaXRJZHhGaWxlcywgW2lkeEZpbGVQYXRoXSwgaW5pdEZpbGVOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KHsgW2VudGl0eU5hbWVdOiByZWNvcmRzIH0sIG51bGwsIDQpKTtcbiAgICAgICAgICAgICAgICAgICAgfSkgXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICB9IFxuXG4gICAgICAgIC8vY29uc29sZS5kaXIoaW5pdElkeEZpbGVzLCB7ZGVwdGg6IDEwfSk7XG5cbiAgICAgICAgXy5mb3JPd24oaW5pdElkeEZpbGVzLCAobGlzdCwgZmlsZVBhdGgpID0+IHtcbiAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgbGV0IG1hbnVhbCA9IFtdO1xuXG4gICAgICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhpZHhGaWxlUGF0aCkpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMoaWR4RmlsZVBhdGgsICd1dGY4Jykuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgICAgIGxpbmVzLmZvckVhY2gobGluZSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGluZS5zdGFydHNXaXRoKCcwLScpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYW51YWwucHVzaChsaW5lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShpZHhGaWxlUGF0aCwgbGlzdC5jb25jYXQobWFudWFsKS5qb2luKCdcXG4nKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfdG9Db2x1bW5SZWZlcmVuY2UobmFtZSkge1xuICAgICAgICByZXR1cm4geyBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJywgbmFtZSB9OyAgXG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZC5ieSkgfTtcbiAgICAgICAgICAgIGxldCB3aXRoRXh0cmEgPSB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIHJlbW90ZUZpZWxkLndpdGgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAobG9jYWxGaWVsZCBpbiB3aXRoRXh0cmEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHJldCwgd2l0aEV4dHJhIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQpIH07XG4gICAgfVxuXG4gICAgX2dldEFsbFJlbGF0ZWRGaWVsZHMocmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKCFyZW1vdGVGaWVsZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5ieTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZW1vdGVGaWVsZDtcbiAgICB9XG5cbiAgICBfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpIHtcbiAgICAgICAgcmV0dXJuIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5tYXAoYXNzb2MgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnaGFzTWFueScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGx1cmFsaXplKGFzc29jLmRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtieV0gW3dpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIFwiJHtlbnRpdHkubmFtZX1cIiAke0pTT04uc3RyaW5naWZ5KGFzc29jKX1gKTsgXG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSwgZGVzdEVudGl0eSwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgWyBkZXN0U2NoZW1hTmFtZSwgYWN0dWFsRGVzdEVudGl0eU5hbWUgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVzdFNjaGVtYSA9IHNjaGVtYS5saW5rZXIuc2NoZW1hc1tkZXN0U2NoZW1hTmFtZV07XG4gICAgICAgICAgICBpZiAoIWRlc3RTY2hlbWEubGlua2VkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZGVzdGluYXRpb24gc2NoZW1hICR7ZGVzdFNjaGVtYU5hbWV9IGhhcyBub3QgYmVlbiBsaW5rZWQgeWV0LiBDdXJyZW50bHkgb25seSBzdXBwb3J0IG9uZS13YXkgcmVmZXJlbmNlIGZvciBjcm9zcyBkYiByZWxhdGlvbi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07IFxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGFjdHVhbERlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgZGVzdEVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgXG4gICAgICAgICBcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6IGRlc3RLZXlGaWVsZCwgYEVtcHR5IGtleSBmaWVsZC4gRW50aXR5OiAke2Rlc3RFbnRpdHlOYW1lfWA7IFxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHR5cGVzOiBbICdyZWZlcnNUbycgXSwgXG4gICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uOiBhc3NvYyBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBieTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuYnkuc3BsaXQoJy4nKVswXSBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMud2l0aCA9IGFzc29jLndpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKGFzc29jLnJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogcmVtb3RlRmllbGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkIHx8IChyZW1vdGVGaWVsZCA9IGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmlzTmlsKHJlbW90ZUZpZWxkcykgfHwgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGRzKSA/IHJlbW90ZUZpZWxkcy5pbmRleE9mKHJlbW90ZUZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSByZW1vdGVGaWVsZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIGluY2x1ZGVzLCBleGNsdWRlcyk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wibTJuXCIgYXNzb2NpYXRpb24gcmVxdWlyZXMgXCJieVwiIHByb3BlcnR5LiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcgZGVzdGluYXRpb246ICcgKyBkZXN0RW50aXR5TmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9uZS9tYW55IHRvIG9uZS9tYW55IHJlbGF0aW9uXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gY29ubmVjdGVkIGJ5IGZpZWxkIGlzIHVzdWFsbHkgYSByZWZlcnNUbyBhc3NvY1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lOyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMn1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYW5jaG9yID0gYXNzb2Muc3JjRmllbGQgfHwgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKSA6IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NoZWNrIGlmIHRoZSB0YXJnZXQgZW50aXR5IGhhcyBsb2dpY2FsIGRlbGV0aW9uIGZlYXR1cmVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eS5oYXNGZWF0dXJlKCdsb2dpY2FsRGVsZXRpb24nKSkge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBkZWxldGlvbkNoZWNrID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0JpbmFyeUV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICchPScsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBgJHtkZXN0RW50aXR5TmFtZX0uJHtkZXN0RW50aXR5LmZlYXR1cmVzWydsb2dpY2FsRGVsZXRpb24nXS5maWVsZH1gIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZC53aXRoID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdMb2dpY2FsRXhwcmVzc2lvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICdhbmQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IHJlbW90ZUZpZWxkLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IGRlbGV0aW9uQ2hlY2tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiBhc3NvYy53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IGRlbGV0aW9uQ2hlY2s7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvciwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LCAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGFuY2hvciB9LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkua2V5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IHJlbW90ZUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IHJlbW90ZUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0eXBlb2YgcmVtb3RlRmllbGQgPT09ICdzdHJpbmcnID8geyBmaWVsZDogcmVtb3RlRmllbGQgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICBcbiAgICAgICAgICAgICAgICAgICAgLy8gc2VtaSBhc3NvY2lhdGlvbiBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5ID8gYXNzb2MuYnkuc3BsaXQoJy4nKSA6IFsgT29sVXRpbHMucHJlZml4TmFtaW5nKGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSkgXTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vY3JlYXRlIGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy90b2RvOiBnZXQgYmFjayByZWYgZnJvbSBjb25uZWN0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYxID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBzcmNGaWVsZDogKGYpID0+IF8uaXNOaWwoZikgfHwgZiA9PSBjb25uZWN0ZWRCeUZpZWxkIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtlbnRpdHkubmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYyID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhkZXN0RW50aXR5TmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nIH0sIHsgYXNzb2NpYXRpb246IGNvbm5CYWNrUmVmMSAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2Rlc3RFbnRpdHlOYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gY29ubkJhY2tSZWYyLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSArICcuJyArIGNvbm5lY3RlZEJ5RmllbGQyLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAxLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGRlc3RGaWVsZE5hbWUgPSBkZXN0S2V5RmllbGQubmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgcmVmZXJlbmNlZEZpZWxkID0gZGVzdEtleUZpZWxkO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZyA9IGAke2VudGl0eS5uYW1lfToxLSR7ZGVzdEVudGl0eU5hbWV9OiogJHtsb2NhbEZpZWxkfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmRlc3RGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFkZXN0RW50aXR5Lmhhc0ZpZWxkKGFzc29jLmRlc3RGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBmaWVsZCBcIiR7YXNzb2MuZGVzdEZpZWxkfVwiIGJlaW5nIHJlZmVyZW5jZWQgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEZpZWxkTmFtZSA9IGFzc29jLmRlc3RGaWVsZDsgIFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJlbmNlZEZpZWxkID0gZGVzdEVudGl0eS5maWVsZHNbZGVzdEZpZWxkTmFtZV07ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0YWcgKz0gJy0+JyArIGFzc29jLmRlc3RGaWVsZDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkIGJ5IGNvbm5lY3Rpb24sIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnKTsgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCB3ZWVrIHJlZmVyZW5jZTogJHt0YWd9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGpvaW5PbiA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShsb2NhbEZpZWxkICsgJy4nICsgZGVzdEZpZWxkTmFtZSkgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oam9pbk9uLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogbG9jYWxGaWVsZCB9LCBhc3NvYy53aXRoKSk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIHJlZmVyZW5jZWRGaWVsZCwgYXNzb2MuZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogZGVzdEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uOiBqb2luT24gXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy9mb3JlaWduIGtleSBjb25zdHJhaXRzXG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGRPYmogPSBlbnRpdHkuZmllbGRzW2xvY2FsRmllbGRdOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGNvbnN0cmFpbnRzID0ge307XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ1JFU1RSSUNUJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdSRVNUUklDVCcpO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChsb2NhbEZpZWxkT2JqLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnU0VUIE5VTEwnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnTk8gQUNUSU9OJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ05PIEFDVElPTicpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEZpZWxkTmFtZSwgY29uc3RyYWludHMpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24pIHtcbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJyE9Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckbmUnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJnO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRlcSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyBcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckbmUnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgICAgIFxuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gVW5hcnlFeHByZXNzaW9uIG9wZXJhdG9yOiAnICsgb29sQ29uLm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkb3I6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gc3ludGF4OiAnICsgSlNPTi5zdHJpbmdpZnkob29sQ29uKSk7XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYsIGFzS2V5KSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coY29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmTmFtZSA9IFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG5cbiAgICAgICAgaWYgKGFzS2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmTmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShyZWZOYW1lKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBsZWZ0RmllbGQgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzIH0pOyBcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoc2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmVhdHVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZlYXR1cmUuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VzZXJFZGl0VHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY2hhbmdlTG9nJzpcbiAgICAgICAgICAgICAgICBsZXQgY2hhbmdlTG9nU2V0dGluZ3MgPSBVdGlsLmdldFZhbHVlQnlQYXRoKHNjaGVtYS5kZXBsb3ltZW50U2V0dGluZ3MsICdmZWF0dXJlcy5jaGFuZ2VMb2cnKTtcblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIFwiY2hhbmdlTG9nXCIgZmVhdHVyZSBzZXR0aW5ncyBpbiBkZXBsb3ltZW50IGNvbmZpZyBmb3Igc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncy5kYXRhU291cmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjaGFuZ2VMb2cuZGF0YVNvdXJjZVwiIGlzIHJlcXVpcmVkLiBTY2hlbWE6ICR7c2NoZW1hLm5hbWV9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihmZWF0dXJlLCBjaGFuZ2VMb2dTZXR0aW5ncyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdhdXRvSWQnLCAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAgaW5kZXhlczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJmaWVsZHNcIjogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdLFxuICAgICAgICAgICAgICAgICAgICBcInVuaXF1ZVwiOiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTFOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTFSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5Mk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MlJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MiBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5Mk5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDIgXG4gICAgICovXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgXG4gICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgcmVsYXRpb24gZW50aXR5IGhhcyB0aGUgcmVmZXJzVG8gYm90aCBzaWRlIG9mIGFzc29jaWF0aW9ucyAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTFOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkxTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mk5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTJOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc1JlZlRvRW50aXR5MSAmJiBoYXNSZWZUb0VudGl0eTIpIHtcbiAgICAgICAgICAgICAgICAvL3llcywgZG9uJ3QgbmVlZCB0byBhZGQgcmVmZXJzVG8gdG8gdGhlIHJlbGF0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0YWcxID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5MU5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkfWA7XG4gICAgICAgIGxldCB0YWcyID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5Mk5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkMn1gO1xuXG4gICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMik7XG5cbiAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICBcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMX1gKTtcblxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgIFxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcyfWApO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MU5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mk5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEsIGtleUVudGl0eTEpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBrZXlFbnRpdHkyKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTFOYW1lIH1cbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5Mk5hbWUgfVxuICAgICAgICApO1xuXG4gICAgICAgIGxldCBhbGxDYXNjYWRlID0geyBvblVwZGF0ZTogJ1JFU1RSSUNUJywgb25EZWxldGU6ICdSRVNUUklDVCcgfTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUsIGFsbENhc2NhZGUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9Ki9cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24sIHNjaGVtYVRvQ29ubmVjdG9yLyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykge1xuICAgICAgICBsZXQgcmVmVGFibGUgPSByZWxhdGlvbi5yaWdodDtcblxuICAgICAgICBpZiAocmVmVGFibGUuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgcmVmRW50aXR5TmFtZSBdID0gcmVmVGFibGUuc3BsaXQoJy4nKTsgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHRhcmdldENvbm5lY3RvciA9IHNjaGVtYVRvQ29ubmVjdG9yW3NjaGVtYU5hbWVdO1xuICAgICAgICAgICAgYXNzZXJ0OiB0YXJnZXRDb25uZWN0b3I7XG5cbiAgICAgICAgICAgIHJlZlRhYmxlID0gdGFyZ2V0Q29ubmVjdG9yLmRhdGFiYXNlICsgJ2AuYCcgKyByZWZFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlZlRhYmxlICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSBgT04gVVBEQVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25VcGRhdGV9IE9OIERFTEVURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uRGVsZXRlfTtcXG5gO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=