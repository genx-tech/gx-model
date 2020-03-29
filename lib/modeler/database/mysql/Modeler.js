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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJzY2hlbWFUb0Nvbm5lY3RvciIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJub2RlcyIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiaW5pdElkeEZpbGVzIiwiZW52RGF0YSIsImVudGl0aWVzRGF0YSIsImluaXRGaWxlTmFtZSIsInBhdGhOb2RlcyIsImluaXRGaWxlUGF0aCIsImlkeEZpbGVQYXRoIiwiSlNPTiIsInN0cmluZ2lmeSIsImxpc3QiLCJmaWxlUGF0aCIsIm1hbnVhbCIsImV4aXN0c1N5bmMiLCJsaW5lcyIsInJlYWRGaWxlU3luYyIsInNwbGl0IiwibGluZSIsInN0YXJ0c1dpdGgiLCJjb25jYXQiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsIl90b0NvbHVtblJlZmVyZW5jZSIsIm9vclR5cGUiLCJfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbiIsImxvY2FsRmllbGQiLCJhbmNob3IiLCJyZW1vdGVGaWVsZCIsIm1hcCIsInJmIiwicmV0IiwiYnkiLCJ3aXRoRXh0cmEiLCJfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbiIsIndpdGgiLCIkYW5kIiwiX2dldEFsbFJlbGF0ZWRGaWVsZHMiLCJ1bmRlZmluZWQiLCJzcmNGaWVsZCIsInR5cGUiLCJkZXN0RW50aXR5IiwiZW50aXR5S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSIsImRlc3RTY2hlbWFOYW1lIiwiYWN0dWFsRGVzdEVudGl0eU5hbWUiLCJkZXN0U2NoZW1hIiwic2NoZW1hcyIsImxpbmtlZCIsImVuc3VyZUdldEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImluY2x1ZGVzIiwiZXhjbHVkZXMiLCJ0eXBlcyIsImFzc29jaWF0aW9uIiwiY2IiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwiaGFzRmVhdHVyZSIsImRlbGV0aW9uQ2hlY2siLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwicmlnaHQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwiZGVzdEZpZWxkTmFtZSIsInJlZmVyZW5jZWRGaWVsZCIsInRhZyIsImRlc3RGaWVsZCIsImhhc0ZpZWxkIiwiam9pbk9uIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJsb2NhbEZpZWxkT2JqIiwiY29uc3RyYWludHMiLCJjb25zdHJhaW50T25VcGRhdGUiLCJvblVwZGF0ZSIsImNvbnN0cmFpbnRPbkRlbGV0ZSIsIm9uRGVsZXRlIiwib3B0aW9uYWwiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsImFyZyIsImFyZ3VtZW50IiwiJG9yIiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwiY29uc29sZSIsInJlZk5hbWUiLCJsZWZ0RmllbGQiLCJyaWdodEZpZWxkIiwibGYiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZ2VuZXJhdG9yIiwiYXV0b0luY3JlbWVudElkIiwiZXh0cmFPcHRzIiwic3RhcnRGcm9tIiwiaXNDcmVhdGVUaW1lc3RhbXAiLCJpc1VwZGF0ZVRpbWVzdGFtcCIsImNoYW5nZUxvZ1NldHRpbmdzIiwiZ2V0VmFsdWVCeVBhdGgiLCJkZXBsb3ltZW50U2V0dGluZ3MiLCJkYXRhU291cmNlIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsInJlbGF0aW9uRW50aXR5TmFtZSIsImVudGl0eTFOYW1lIiwiZW50aXR5Mk5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwiaW5kZXhlcyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJhbGxDYXNjYWRlIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0IiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleCIsInVuaXF1ZSIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlbGF0aW9uIiwicmVmVGFibGUiLCJzY2hlbWFOYW1lIiwicmVmRW50aXR5TmFtZSIsInRhcmdldENvbm5lY3RvciIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwicGFzY2FsQ2FzZSIsImVuZHNXaXRoIiwicXVvdGVTdHJpbmciLCJzdHIiLCJyZXBsYWNlIiwib2JqIiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwidmFsdWVzIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJtb2R1bGUiLCJleHBv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SCxVQUF0QixDQUFQO0FBQ0g7O0FBdmpEYzs7QUEwakRuQjZTLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjdVLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSwgcHV0SW50b0J1Y2tldCB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCB7IHBsdXJhbGl6ZSwgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUgfSA9IE9vbFV0aWxzO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IHsgVHlwZXMgfSA9IHJlcXVpcmUoJ0BnZW54L2RhdGEnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hLCBzY2hlbWFUb0Nvbm5lY3Rvcikge1xuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBwZW5kaW5nRW50aXRpZXMgPSBPYmplY3Qua2V5cyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgd2hpbGUgKHBlbmRpbmdFbnRpdGllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZXQgZW50aXR5TmFtZSA9IHBlbmRpbmdFbnRpdGllcy5zaGlmdCgpO1xuICAgICAgICAgICAgbGV0IGVudGl0eSA9IG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzW2VudGl0eU5hbWVdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7ICBcbiAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgYXNzb2NpYXRpb25zIG9mIGVudGl0eSBcIiR7ZW50aXR5TmFtZX1cIi4uLmApOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGxldCBhc3NvY3MgPSB0aGlzLl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NOYW1lcyA9IGFzc29jcy5yZWR1Y2UoKHJlc3VsdCwgdikgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbdl0gPSB2O1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH0sIHt9KTsgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHMgICAgICAgIFxuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTsgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICAvL2xldCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGVudGl0eU5hbWUgPT09IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgLy9tYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lW2VudGl0eU5hbWVdID0gZW50aXR5LmNvZGU7XG5cbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKCh7IGRhdGFTZXQsIHJ1bnRpbWVFbnYsIHJlY29yZHMgfSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVjb3JkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IGVudGl0eS5maWVsZHNbZmllbGRzWzBdXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWtleUZpZWxkLmF1dG8gJiYgIWtleUZpZWxkLmRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBrZXkgZmllbGQgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBubyBkZWZhdWx0IHZhbHVlIG9yIGF1dG8tZ2VuZXJhdGVkIHZhbHVlLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKHJlY29yZHMsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVNldCB8fCAoZGF0YVNldCA9ICdfaW5pdCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcnVudGltZUVudiB8fCAocnVudGltZUVudiA9ICdkZWZhdWx0Jyk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlcyA9IFsgZGF0YVNldCwgcnVudGltZUVudiBdOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBub2Rlcy5wdXNoKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQga2V5ID0gbm9kZXMuam9pbignLicpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGRhdGEsIGtleSwgZW50aXR5RGF0YSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGxldCBpbml0SWR4RmlsZXMgPSB7fTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgXy5mb3JPd24oZGF0YSwgKGVudkRhdGEsIGRhdGFTZXQpID0+IHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnZEYXRhLCAoZW50aXRpZXNEYXRhLCBydW50aW1lRW52KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0aWVzRGF0YSwgKHJlY29yZHMsIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBpbml0RmlsZU5hbWUgPSBgMC0ke2VudGl0eU5hbWV9Lmpzb25gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcGF0aE5vZGVzID0gW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNxbEZpbGVzRGlyLCAnZGF0YScsIGRhdGFTZXQgfHwgJ19pbml0J1xuICAgICAgICAgICAgICAgICAgICAgICAgXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHJ1bnRpbWVFbnYgIT09ICdkZWZhdWx0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhdGhOb2Rlcy5wdXNoKHJ1bnRpbWVFbnYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKC4uLnBhdGhOb2RlcywgaW5pdEZpbGVOYW1lKTsgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgaWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oLi4ucGF0aE5vZGVzLCAnaW5kZXgubGlzdCcpOyAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1dEludG9CdWNrZXQoaW5pdElkeEZpbGVzLCBbaWR4RmlsZVBhdGhdLCBpbml0RmlsZU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoeyBbZW50aXR5TmFtZV06IHJlY29yZHMgfSwgbnVsbCwgNCkpO1xuICAgICAgICAgICAgICAgICAgICB9KSBcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH0gXG5cbiAgICAgICAgLy9jb25zb2xlLmRpcihpbml0SWR4RmlsZXMsIHtkZXB0aDogMTB9KTtcblxuICAgICAgICBfLmZvck93bihpbml0SWR4RmlsZXMsIChsaXN0LCBmaWxlUGF0aCkgPT4ge1xuICAgICAgICAgICAgbGV0IGlkeEZpbGVQYXRoID0gcGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmlsZVBhdGgpO1xuXG4gICAgICAgICAgICBsZXQgbWFudWFsID0gW107XG5cbiAgICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGlkeEZpbGVQYXRoKSkge1xuICAgICAgICAgICAgICAgIGxldCBsaW5lcyA9IGZzLnJlYWRGaWxlU3luYyhpZHhGaWxlUGF0aCwgJ3V0ZjgnKS5zcGxpdCgnXFxuJyk7XG4gICAgICAgICAgICAgICAgbGluZXMuZm9yRWFjaChsaW5lID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoJzAtJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hbnVhbC5wdXNoKGxpbmUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKGlkeEZpbGVQYXRoLCBsaXN0LmNvbmNhdChtYW51YWwpLmpvaW4oJ1xcbicpKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90b0NvbHVtblJlZmVyZW5jZShuYW1lKSB7XG4gICAgICAgIHJldHVybiB7IG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLCBuYW1lIH07ICBcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLmJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkO1xuICAgIH1cblxuICAgIF9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSkge1xuICAgICAgICByZXR1cm4gZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLm1hcChhc3NvYyA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHJldHVybiBhc3NvYy5zcmNGaWVsZDtcblxuICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUbyAgICAgIFxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2J5XSBbd2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uICAgICAgIFxuICAgICAqIHJlZmVyc1RvIC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogICAgICBcbiAgICAgKiByZW1vdGVGaWVsZDpcbiAgICAgKiAgIDEuIGZpZWxkTmFtZVxuICAgICAqICAgMi4gYXJyYXkgb2YgZmllbGROYW1lXG4gICAgICogICAzLiB7IGJ5ICwgd2l0aCB9XG4gICAgICogICA0LiBhcnJheSBvZiBmaWVsZE5hbWUgYW5kIHsgYnkgLCB3aXRoIH0gbWl4ZWRcbiAgICAgKiAgXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyBcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgXCIke2VudGl0eS5uYW1lfVwiICR7SlNPTi5zdHJpbmdpZnkoYXNzb2MpfWApOyBcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5LCBkZXN0RW50aXR5LCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICBcbiAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKSkge1xuICAgICAgICAgICAgLy9jcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgICAgIGxldCBbIGRlc3RTY2hlbWFOYW1lLCBhY3R1YWxEZXN0RW50aXR5TmFtZSBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXN0U2NoZW1hID0gc2NoZW1hLmxpbmtlci5zY2hlbWFzW2Rlc3RTY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGlmICghZGVzdFNjaGVtYS5saW5rZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBkZXN0aW5hdGlvbiBzY2hlbWEgJHtkZXN0U2NoZW1hTmFtZX0gaGFzIG5vdCBiZWVuIGxpbmtlZCB5ZXQuIEN1cnJlbnRseSBvbmx5IHN1cHBvcnQgb25lLXdheSByZWZlcmVuY2UgZm9yIGNyb3NzIGRiIHJlbGF0aW9uLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBkZXN0U2NoZW1hLmVudGl0aWVzW2FjdHVhbERlc3RFbnRpdHlOYW1lXTsgXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gYWN0dWFsRGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBkZXN0RW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gZGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gICBcbiAgICAgICAgIFxuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGFzc2VydDogZGVzdEtleUZpZWxkLCBgRW1wdHkga2V5IGZpZWxkLiBFbnRpdHk6ICR7ZGVzdEVudGl0eU5hbWV9YDsgXG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb246IGFzc29jIFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5ieS5zcGxpdCgnLicpWzBdIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy53aXRoID0gYXNzb2Mud2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiByZW1vdGVGaWVsZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQgfHwgKHJlbW90ZUZpZWxkID0gZW50aXR5Lm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YocmVtb3RlRmllbGQpID4gLTEgOiByZW1vdGVGaWVsZHMgPT09IHJlbW90ZUZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignXCJtMm5cIiBhc3NvY2lhdGlvbiByZXF1aXJlcyBcImJ5XCIgcHJvcGVydHkuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJyBkZXN0aW5hdGlvbjogJyArIGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb25lL21hbnkgdG8gb25lL21hbnkgcmVsYXRpb25cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0ZWQgYnkgZmllbGQgaXMgdXN1YWxseSBhIHJlZmVyc1RvIGFzc29jXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7IFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vY3JlYXRlIGFcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGROYW1lID0gYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IHJlbW90ZUZpZWxkTmFtZSB9LCBkZXN0RW50aXR5LmtleSwgcmVtb3RlRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBiYWNrUmVmLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcyfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gYnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBhbmNob3IgPSBhc3NvYy5zcmNGaWVsZCB8fCAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpIDogZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZCA9IGFzc29jLnJlbW90ZUZpZWxkIHx8IGJhY2tSZWYuc3JjRmllbGQgfHwgZW50aXR5Lm5hbWU7XG5cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vY2hlY2sgaWYgdGhlIHRhcmdldCBlbnRpdHkgaGFzIGxvZ2ljYWwgZGVsZXRpb24gZmVhdHVyZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkZXN0RW50aXR5Lmhhc0ZlYXR1cmUoJ2xvZ2ljYWxEZWxldGlvbicpKSB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGRlbGV0aW9uQ2hlY2sgPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnQmluYXJ5RXhwcmVzc2lvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogJyE9JyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IGAke2Rlc3RFbnRpdHlOYW1lfS4ke2Rlc3RFbnRpdHkuZmVhdHVyZXNbJ2xvZ2ljYWxEZWxldGlvbiddLmZpZWxkfWAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiB0cnVlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkLndpdGggPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0xvZ2ljYWxFeHByZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogJ2FuZCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDogcmVtb3RlRmllbGQud2l0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogZGVsZXRpb25DaGVja1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdMb2dpY2FsRXhwcmVzc2lvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICdhbmQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IGFzc29jLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IGRlbGV0aW9uQ2hlY2tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID0gZGVsZXRpb25DaGVjaztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogcmVtb3RlRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogcmVtb3RlRmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHR5cGVvZiByZW1vdGVGaWVsZCA9PT0gJ3N0cmluZycgPyB7IGZpZWxkOiByZW1vdGVGaWVsZCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGguIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJywgYXNzb2NpYXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMikpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgIFxuICAgICAgICAgICAgICAgICAgICAvLyBzZW1pIGFzc29jaWF0aW9uIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkgPyBhc3NvYy5ieS5zcGxpdCgnLicpIDogWyBPb2xVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKSBdO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3RvZG86IGdldCBiYWNrIHJlZiBmcm9tIGNvbm5lY3Rpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjEgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycsIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2VudGl0eS5uYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGRlc3RFbnRpdHlOYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycgfSwgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuIERldGFpbDogJyArIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmM6IGVudGl0eS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3Q6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiBhc3NvYy5zcmNGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lICsgJy4nICsgY29ubmVjdGVkQnlGaWVsZDIsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDEtd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZGVzdEZpZWxkTmFtZSA9IGRlc3RLZXlGaWVsZC5uYW1lO1xuICAgICAgICAgICAgICAgIGxldCByZWZlcmVuY2VkRmllbGQgPSBkZXN0S2V5RmllbGQ7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnID0gYCR7ZW50aXR5Lm5hbWV9OjEtJHtkZXN0RW50aXR5TmFtZX06KiAke2xvY2FsRmllbGR9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuZGVzdEZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkuaGFzRmllbGQoYXNzb2MuZGVzdEZpZWxkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlIGZpZWxkIFwiJHthc3NvYy5kZXN0RmllbGR9XCIgYmVpbmcgcmVmZXJlbmNlZCBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RmllbGROYW1lID0gYXNzb2MuZGVzdEZpZWxkOyAgXG4gICAgICAgICAgICAgICAgICAgICAgICByZWZlcmVuY2VkRmllbGQgPSBkZXN0RW50aXR5LmZpZWxkc1tkZXN0RmllbGROYW1lXTsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRhZyArPSAnLT4nICsgYXNzb2MuZGVzdEZpZWxkO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZykpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQgYnkgY29ubmVjdGlvbiwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcpOyAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIHdlZWsgcmVmZXJlbmNlOiAke3RhZ31gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgam9pbk9uID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyAnLicgKyBkZXN0RmllbGROYW1lKSB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihqb2luT24sIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBsb2NhbEZpZWxkIH0sIGFzc29jLndpdGgpKTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jRmllbGQobG9jYWxGaWVsZCwgZGVzdEVudGl0eSwgcmVmZXJlbmNlZEZpZWxkLCBhc3NvYy5maWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogYXNzb2MudHlwZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBkZXN0RmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgb246IGpvaW5PbiBcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAvL2ZvcmVpZ24ga2V5IGNvbnN0cmFpdHNcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE9iaiA9IGVudGl0eS5maWVsZHNbbG9jYWxGaWVsZF07ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgY29uc3RyYWludHMgPSB7fTtcblxuICAgICAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSA9IGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uVXBkYXRlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSA9IGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnUkVTVFJJQ1QnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ1JFU1RSSUNUJyk7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGxvY2FsRmllbGRPYmoub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ1NFVCBOVUxMJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdOTyBBQ1RJT04nKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnTk8gQUNUSU9OJyk7XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0RmllbGROYW1lLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnIT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRuZSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmc7XG5cbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJGVxJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07IFxuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRuZSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgXG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBVbmFyeUV4cHJlc3Npb24gb3BlcmF0b3I6ICcgKyBvb2xDb24ub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRvcjogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2gobGYgPT4gdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxmLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMgfSk7IFxuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY2hhbmdlTG9nJzpcbiAgICAgICAgICAgICAgICBsZXQgY2hhbmdlTG9nU2V0dGluZ3MgPSBVdGlsLmdldFZhbHVlQnlQYXRoKHNjaGVtYS5kZXBsb3ltZW50U2V0dGluZ3MsICdmZWF0dXJlcy5jaGFuZ2VMb2cnKTtcblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIFwiY2hhbmdlTG9nXCIgZmVhdHVyZSBzZXR0aW5ncyBpbiBkZXBsb3ltZW50IGNvbmZpZyBmb3Igc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncy5kYXRhU291cmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjaGFuZ2VMb2cuZGF0YVNvdXJjZVwiIGlzIHJlcXVpcmVkLiBTY2hlbWE6ICR7c2NoZW1hLm5hbWV9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihmZWF0dXJlLCBjaGFuZ2VMb2dTZXR0aW5ncyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdhdXRvSWQnLCAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAgaW5kZXhlczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJmaWVsZHNcIjogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdLFxuICAgICAgICAgICAgICAgICAgICBcInVuaXF1ZVwiOiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTFOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTFSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5Mk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MlJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MiBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5Mk5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDIgXG4gICAgICovXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgXG4gICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgcmVsYXRpb24gZW50aXR5IGhhcyB0aGUgcmVmZXJzVG8gYm90aCBzaWRlIG9mIGFzc29jaWF0aW9ucyAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTFOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkxTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mk5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTJOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc1JlZlRvRW50aXR5MSAmJiBoYXNSZWZUb0VudGl0eTIpIHtcbiAgICAgICAgICAgICAgICAvL3llcywgZG9uJ3QgbmVlZCB0byBhZGQgcmVmZXJzVG8gdG8gdGhlIHJlbGF0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0YWcxID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5MU5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkfWA7XG4gICAgICAgIGxldCB0YWcyID0gYCR7cmVsYXRpb25FbnRpdHlOYW1lfToxLSR7ZW50aXR5Mk5hbWV9OiogJHtjb25uZWN0ZWRCeUZpZWxkMn1gO1xuXG4gICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMik7XG5cbiAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICBcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMX1gKTtcblxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgIFxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcyfWApO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MU5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mk5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEsIGtleUVudGl0eTEpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBrZXlFbnRpdHkyKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTFOYW1lIH1cbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5Mk5hbWUgfVxuICAgICAgICApO1xuXG4gICAgICAgIGxldCBhbGxDYXNjYWRlID0geyBvblVwZGF0ZTogJ1JFU1RSSUNUJywgb25EZWxldGU6ICdSRVNUUklDVCcgfTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUsIGFsbENhc2NhZGUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9Ki9cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24sIHNjaGVtYVRvQ29ubmVjdG9yLyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykge1xuICAgICAgICBsZXQgcmVmVGFibGUgPSByZWxhdGlvbi5yaWdodDtcblxuICAgICAgICBpZiAocmVmVGFibGUuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgcmVmRW50aXR5TmFtZSBdID0gcmVmVGFibGUuc3BsaXQoJy4nKTsgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHRhcmdldENvbm5lY3RvciA9IHNjaGVtYVRvQ29ubmVjdG9yW3NjaGVtYU5hbWVdO1xuICAgICAgICAgICAgYXNzZXJ0OiB0YXJnZXRDb25uZWN0b3I7XG5cbiAgICAgICAgICAgIHJlZlRhYmxlID0gdGFyZ2V0Q29ubmVjdG9yLmRhdGFiYXNlICsgJ2AuYCcgKyByZWZFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlZlRhYmxlICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSBgT04gVVBEQVRFICR7cmVsYXRpb24uY29uc3RyYWludHMub25VcGRhdGV9IE9OIERFTEVURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uRGVsZXRlfTtcXG5gO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=