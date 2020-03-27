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
              [destEntityName]: destEntityName,
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
          [localField]: this._toColumnReference(destEntityName + '.' + destFieldName)
        };

        if (assoc.with) {
          Object.assign(joinOn, this._oolConditionToQueryCondition({ ...assocNames,
            [destEntityName]: destEntityName
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJwdXRJbnRvQnVja2V0IiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJzY2hlbWFUb0Nvbm5lY3RvciIsImxvZyIsIm5hbWUiLCJtb2RlbGluZ1NjaGVtYSIsImNsb25lIiwicGVuZGluZ0VudGl0aWVzIiwiT2JqZWN0Iiwia2V5cyIsImVudGl0aWVzIiwibGVuZ3RoIiwiZW50aXR5TmFtZSIsInNoaWZ0IiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJhc3NvY3MiLCJfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyIsImFzc29jTmFtZXMiLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2IiwiZm9yRWFjaCIsImFzc29jIiwiX3Byb2Nlc3NBc3NvY2lhdGlvbiIsImVtaXQiLCJzcWxGaWxlc0RpciIsImpvaW4iLCJkYXRhYmFzZSIsImRiRmlsZVBhdGgiLCJma0ZpbGVQYXRoIiwidGFibGVTUUwiLCJyZWxhdGlvblNRTCIsImRhdGEiLCJlYWNoIiwiYWRkSW5kZXhlcyIsImNvbXBsaWFuY2VDaGVjayIsImVycm9ycyIsIm1lc3NhZ2UiLCJ3YXJuaW5ncyIsIkVycm9yIiwiZmVhdHVyZXMiLCJmb3JPd24iLCJmIiwiZmVhdHVyZU5hbWUiLCJBcnJheSIsImlzQXJyYXkiLCJmZiIsIl9mZWF0dXJlUmVkdWNlciIsIl9jcmVhdGVUYWJsZVN0YXRlbWVudCIsImRhdGFTZXQiLCJydW50aW1lRW52IiwicmVjb3JkcyIsImVudGl0eURhdGEiLCJyZWNvcmQiLCJpc1BsYWluT2JqZWN0IiwiZmllbGRzIiwia2V5RmllbGQiLCJhdXRvIiwiZGVmYXVsdEJ5RGIiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJub2RlcyIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiaW5pdElkeEZpbGVzIiwiZW52RGF0YSIsImVudGl0aWVzRGF0YSIsImluaXRGaWxlTmFtZSIsInBhdGhOb2RlcyIsImluaXRGaWxlUGF0aCIsImlkeEZpbGVQYXRoIiwiSlNPTiIsInN0cmluZ2lmeSIsImxpc3QiLCJmaWxlUGF0aCIsIm1hbnVhbCIsImV4aXN0c1N5bmMiLCJsaW5lcyIsInJlYWRGaWxlU3luYyIsInNwbGl0IiwibGluZSIsInN0YXJ0c1dpdGgiLCJjb25jYXQiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsIl90b0NvbHVtblJlZmVyZW5jZSIsIm9vclR5cGUiLCJfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbiIsImxvY2FsRmllbGQiLCJhbmNob3IiLCJyZW1vdGVGaWVsZCIsIm1hcCIsInJmIiwicmV0IiwiYnkiLCJ3aXRoRXh0cmEiLCJfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbiIsIndpdGgiLCIkYW5kIiwiX2dldEFsbFJlbGF0ZWRGaWVsZHMiLCJ1bmRlZmluZWQiLCJzcmNGaWVsZCIsInR5cGUiLCJkZXN0RW50aXR5IiwiZW50aXR5S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSIsImRlc3RTY2hlbWFOYW1lIiwiYWN0dWFsRGVzdEVudGl0eU5hbWUiLCJkZXN0U2NoZW1hIiwic2NoZW1hcyIsImxpbmtlZCIsImVuc3VyZUdldEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImluY2x1ZGVzIiwiZXhjbHVkZXMiLCJ0eXBlcyIsImFzc29jaWF0aW9uIiwiY2IiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwiaGFzRmVhdHVyZSIsImRlbGV0aW9uQ2hlY2siLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwicmlnaHQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwiZGVzdEZpZWxkTmFtZSIsInJlZmVyZW5jZWRGaWVsZCIsInRhZyIsImRlc3RGaWVsZCIsImhhc0ZpZWxkIiwiam9pbk9uIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJsb2NhbEZpZWxkT2JqIiwiY29uc3RyYWludHMiLCJjb25zdHJhaW50T25VcGRhdGUiLCJvblVwZGF0ZSIsImNvbnN0cmFpbnRPbkRlbGV0ZSIsIm9uRGVsZXRlIiwib3B0aW9uYWwiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsImFyZyIsImFyZ3VtZW50IiwiJG9yIiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwiY29uc29sZSIsInJlZk5hbWUiLCJsZWZ0RmllbGQiLCJyaWdodEZpZWxkIiwibGYiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZ2VuZXJhdG9yIiwiYXV0b0luY3JlbWVudElkIiwiZXh0cmFPcHRzIiwic3RhcnRGcm9tIiwiaXNDcmVhdGVUaW1lc3RhbXAiLCJpc1VwZGF0ZVRpbWVzdGFtcCIsImNoYW5nZUxvZ1NldHRpbmdzIiwiZ2V0VmFsdWVCeVBhdGgiLCJkZXBsb3ltZW50U2V0dGluZ3MiLCJkYXRhU291cmNlIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsInJlbGF0aW9uRW50aXR5TmFtZSIsImVudGl0eTFOYW1lIiwiZW50aXR5Mk5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwiaW5kZXhlcyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJhbGxDYXNjYWRlIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0IiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleCIsInVuaXF1ZSIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlbGF0aW9uIiwicmVmVGFibGUiLCJzY2hlbWFOYW1lIiwicmVmRW50aXR5TmFtZSIsInRhcmdldENvbm5lY3RvciIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwicGFzY2FsQ2FzZSIsImVuZHNXaXRoIiwicXVvdGVTdHJpbmciLCJzdHIiLCJyZXBsYWNlIiwib2JqIiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwidmFsdWVzIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJtb2R1bGUiLCJleHBv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RGM7O0FBMGpEbkI2UyxNQUFNLENBQUNDLE9BQVAsR0FBaUI3VSxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUsIHB1dEludG9CdWNrZXQgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCB7IFR5cGVzIH0gPSByZXF1aXJlKCdAZ2VueC9kYXRhJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgcGVuZGluZ0VudGl0aWVzID0gT2JqZWN0LmtleXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eU5hbWUgPSBwZW5kaW5nRW50aXRpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBtb2RlbGluZ1NjaGVtYS5lbnRpdGllc1tlbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eU5hbWV9XCIuLi5gKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzICAgICAgICBcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgLy9sZXQgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgYXNzZXJ0OiBlbnRpdHlOYW1lID09PSBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgIC8vbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZVtlbnRpdHlOYW1lXSA9IGVudGl0eS5jb2RlO1xuXG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaCgoeyBkYXRhU2V0LCBydW50aW1lRW52LCByZWNvcmRzIH0pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlY29yZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQga2V5RmllbGQgPSBlbnRpdHkuZmllbGRzW2ZpZWxkc1swXV07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFrZXlGaWVsZC5hdXRvICYmICFrZXlGaWVsZC5kZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbm8gZGVmYXVsdCB2YWx1ZSBvciBhdXRvLWdlbmVyYXRlZCB2YWx1ZS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBfLmZvck93bihyZWNvcmRzLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFTZXQgfHwgKGRhdGFTZXQgPSAnX2luaXQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJ1bnRpbWVFbnYgfHwgKHJ1bnRpbWVFbnYgPSAnZGVmYXVsdCcpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbm9kZXMgPSBbIGRhdGFTZXQsIHJ1bnRpbWVFbnYgXTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZXMucHVzaChlbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGtleSA9IG5vZGVzLmpvaW4oJy4nKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChkYXRhLCBrZXksIGVudGl0eURhdGEsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZiwgc2NoZW1hVG9Db25uZWN0b3IvKiwgbWFwT2ZFbnRpdHlOYW1lVG9Db2RlTmFtZSovKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBsZXQgaW5pdElkeEZpbGVzID0ge307XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZm9yT3duKGRhdGEsIChlbnZEYXRhLCBkYXRhU2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW52RGF0YSwgKGVudGl0aWVzRGF0YSwgcnVudGltZUVudikgPT4ge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdGllc0RhdGEsIChyZWNvcmRzLCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgaW5pdEZpbGVOYW1lID0gYDAtJHtlbnRpdHlOYW1lfS5qc29uYDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHBhdGhOb2RlcyA9IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcWxGaWxlc0RpciwgJ2RhdGEnLCBkYXRhU2V0IHx8ICdfaW5pdCdcbiAgICAgICAgICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChydW50aW1lRW52ICE9PSAnZGVmYXVsdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXRoTm9kZXMucHVzaChydW50aW1lRW52KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbiguLi5wYXRoTm9kZXMsIGluaXRGaWxlTmFtZSk7ICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGlkeEZpbGVQYXRoID0gcGF0aC5qb2luKC4uLnBhdGhOb2RlcywgJ2luZGV4Lmxpc3QnKTsgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGluaXRJZHhGaWxlcywgW2lkeEZpbGVQYXRoXSwgaW5pdEZpbGVOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KHsgW2VudGl0eU5hbWVdOiByZWNvcmRzIH0sIG51bGwsIDQpKTtcbiAgICAgICAgICAgICAgICAgICAgfSkgXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICB9IFxuXG4gICAgICAgIC8vY29uc29sZS5kaXIoaW5pdElkeEZpbGVzLCB7ZGVwdGg6IDEwfSk7XG5cbiAgICAgICAgXy5mb3JPd24oaW5pdElkeEZpbGVzLCAobGlzdCwgZmlsZVBhdGgpID0+IHtcbiAgICAgICAgICAgIGxldCBpZHhGaWxlUGF0aCA9IHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZpbGVQYXRoKTtcblxuICAgICAgICAgICAgbGV0IG1hbnVhbCA9IFtdO1xuXG4gICAgICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhpZHhGaWxlUGF0aCkpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMoaWR4RmlsZVBhdGgsICd1dGY4Jykuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgICAgIGxpbmVzLmZvckVhY2gobGluZSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbGluZS5zdGFydHNXaXRoKCcwLScpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYW51YWwucHVzaChsaW5lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShpZHhGaWxlUGF0aCwgbGlzdC5jb25jYXQobWFudWFsKS5qb2luKCdcXG4nKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfdG9Db2x1bW5SZWZlcmVuY2UobmFtZSkge1xuICAgICAgICByZXR1cm4geyBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJywgbmFtZSB9OyAgXG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZC5ieSkgfTtcbiAgICAgICAgICAgIGxldCB3aXRoRXh0cmEgPSB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIHJlbW90ZUZpZWxkLndpdGgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAobG9jYWxGaWVsZCBpbiB3aXRoRXh0cmEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHJldCwgd2l0aEV4dHJhIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQpIH07XG4gICAgfVxuXG4gICAgX2dldEFsbFJlbGF0ZWRGaWVsZHMocmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKCFyZW1vdGVGaWVsZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5ieTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZW1vdGVGaWVsZDtcbiAgICB9XG5cbiAgICBfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpIHtcbiAgICAgICAgcmV0dXJuIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5tYXAoYXNzb2MgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnaGFzTWFueScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGx1cmFsaXplKGFzc29jLmRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtieV0gW3dpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIFwiJHtlbnRpdHkubmFtZX1cIiAke0pTT04uc3RyaW5naWZ5KGFzc29jKX1gKTsgXG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSwgZGVzdEVudGl0eSwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgWyBkZXN0U2NoZW1hTmFtZSwgYWN0dWFsRGVzdEVudGl0eU5hbWUgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVzdFNjaGVtYSA9IHNjaGVtYS5saW5rZXIuc2NoZW1hc1tkZXN0U2NoZW1hTmFtZV07XG4gICAgICAgICAgICBpZiAoIWRlc3RTY2hlbWEubGlua2VkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZGVzdGluYXRpb24gc2NoZW1hICR7ZGVzdFNjaGVtYU5hbWV9IGhhcyBub3QgYmVlbiBsaW5rZWQgeWV0LiBDdXJyZW50bHkgb25seSBzdXBwb3J0IG9uZS13YXkgcmVmZXJlbmNlIGZvciBjcm9zcyBkYiByZWxhdGlvbi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07IFxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGFjdHVhbERlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgZGVzdEVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgXG4gICAgICAgICBcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6IGRlc3RLZXlGaWVsZCwgYEVtcHR5IGtleSBmaWVsZC4gRW50aXR5OiAke2Rlc3RFbnRpdHlOYW1lfWA7IFxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHR5cGVzOiBbICdyZWZlcnNUbycgXSwgXG4gICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uOiBhc3NvYyBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBieTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuYnkuc3BsaXQoJy4nKVswXSBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMud2l0aCA9IGFzc29jLndpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKGFzc29jLnJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogcmVtb3RlRmllbGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkIHx8IChyZW1vdGVGaWVsZCA9IGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmlzTmlsKHJlbW90ZUZpZWxkcykgfHwgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGRzKSA/IHJlbW90ZUZpZWxkcy5pbmRleE9mKHJlbW90ZUZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSByZW1vdGVGaWVsZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIGluY2x1ZGVzLCBleGNsdWRlcyk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wibTJuXCIgYXNzb2NpYXRpb24gcmVxdWlyZXMgXCJieVwiIHByb3BlcnR5LiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcgZGVzdGluYXRpb246ICcgKyBkZXN0RW50aXR5TmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9uZS9tYW55IHRvIG9uZS9tYW55IHJlbGF0aW9uXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gY29ubmVjdGVkIGJ5IGZpZWxkIGlzIHVzdWFsbHkgYSByZWZlcnNUbyBhc3NvY1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lOyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMn1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYW5jaG9yID0gYXNzb2Muc3JjRmllbGQgfHwgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKSA6IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NoZWNrIGlmIHRoZSB0YXJnZXQgZW50aXR5IGhhcyBsb2dpY2FsIGRlbGV0aW9uIGZlYXR1cmVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdEVudGl0eS5oYXNGZWF0dXJlKCdsb2dpY2FsRGVsZXRpb24nKSkge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBkZWxldGlvbkNoZWNrID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb29sVHlwZTogJ0JpbmFyeUV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICchPScsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBgJHtkZXN0RW50aXR5TmFtZX0uJHtkZXN0RW50aXR5LmZlYXR1cmVzWydsb2dpY2FsRGVsZXRpb24nXS5maWVsZH1gIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByaWdodDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZC53aXRoID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9vbFR5cGU6ICdMb2dpY2FsRXhwcmVzc2lvbicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6ICdhbmQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IHJlbW90ZUZpZWxkLndpdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IGRlbGV0aW9uQ2hlY2tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnTG9naWNhbEV4cHJlc3Npb24nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiAnYW5kJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZWZ0OiBhc3NvYy53aXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiBkZWxldGlvbkNoZWNrXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA9IGRlbGV0aW9uQ2hlY2s7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvciwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LCAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGFuY2hvciB9LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkua2V5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IHJlbW90ZUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IHJlbW90ZUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0eXBlb2YgcmVtb3RlRmllbGQgPT09ICdzdHJpbmcnID8geyBmaWVsZDogcmVtb3RlRmllbGQgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICBcbiAgICAgICAgICAgICAgICAgICAgLy8gc2VtaSBhc3NvY2lhdGlvbiBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5ID8gYXNzb2MuYnkuc3BsaXQoJy4nKSA6IFsgT29sVXRpbHMucHJlZml4TmFtaW5nKGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSkgXTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vY3JlYXRlIGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy90b2RvOiBnZXQgYmFjayByZWYgZnJvbSBjb25uZWN0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYxID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBzcmNGaWVsZDogKGYpID0+IF8uaXNOaWwoZikgfHwgZiA9PSBjb25uZWN0ZWRCeUZpZWxkIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtlbnRpdHkubmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYyID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhkZXN0RW50aXR5TmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nIH0sIHsgYXNzb2NpYXRpb246IGNvbm5CYWNrUmVmMSAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2Rlc3RFbnRpdHlOYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gY29ubkJhY2tSZWYyLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBkZXN0RW50aXR5TmFtZSwgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMS13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICAgICAgICAgIGxldCBkZXN0RmllbGROYW1lID0gZGVzdEtleUZpZWxkLm5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RLZXlGaWVsZDtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5kZXN0RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghZGVzdEVudGl0eS5oYXNGaWVsZChhc3NvYy5kZXN0RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZmllbGQgXCIke2Fzc29jLmRlc3RGaWVsZH1cIiBiZWluZyByZWZlcmVuY2VkIGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RGaWVsZE5hbWUgPSBhc3NvYy5kZXN0RmllbGQ7ICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyZW5jZWRGaWVsZCA9IGRlc3RFbnRpdHkuZmllbGRzW2Rlc3RGaWVsZE5hbWVdOyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGFnICs9ICctPicgKyBhc3NvYy5kZXN0RmllbGQ7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCBieSBjb25uZWN0aW9uLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZyk7ICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgd2VlayByZWZlcmVuY2U6ICR7dGFnfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBqb2luT24gPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoZGVzdEVudGl0eU5hbWUgKyAnLicgKyBkZXN0RmllbGROYW1lKSB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihqb2luT24sIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBkZXN0RW50aXR5TmFtZSB9LCBhc3NvYy53aXRoKSk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIHJlZmVyZW5jZWRGaWVsZCwgYXNzb2MuZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IGFzc29jLnR5cGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogZGVzdEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uOiBqb2luT24gXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy9mb3JlaWduIGtleSBjb25zdHJhaXRzXG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGRPYmogPSBlbnRpdHkuZmllbGRzW2xvY2FsRmllbGRdOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGNvbnN0cmFpbnRzID0ge307XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAobG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgPSBsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ1JFU1RSSUNUJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdSRVNUUklDVCcpO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChsb2NhbEZpZWxkT2JqLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnU0VUIE5VTEwnKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnTk8gQUNUSU9OJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ05PIEFDVElPTicpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEZpZWxkTmFtZSwgY29uc3RyYWludHMpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24pIHtcbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJyE9Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckbmUnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJnO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRlcSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyBcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckbmUnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgICAgIFxuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gVW5hcnlFeHByZXNzaW9uIG9wZXJhdG9yOiAnICsgb29sQ29uLm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkb3I6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gc3ludGF4OiAnICsgSlNPTi5zdHJpbmdpZnkob29sQ29uKSk7XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYsIGFzS2V5KSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coY29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmTmFtZSA9IFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG5cbiAgICAgICAgaWYgKGFzS2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmTmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShyZWZOYW1lKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBsZWZ0RmllbGQgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzIH0pOyBcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoc2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmVhdHVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZlYXR1cmUuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NoYW5nZUxvZyc6XG4gICAgICAgICAgICAgICAgbGV0IGNoYW5nZUxvZ1NldHRpbmdzID0gVXRpbC5nZXRWYWx1ZUJ5UGF0aChzY2hlbWEuZGVwbG95bWVudFNldHRpbmdzLCAnZmVhdHVyZXMuY2hhbmdlTG9nJyk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBcImNoYW5nZUxvZ1wiIGZlYXR1cmUgc2V0dGluZ3MgaW4gZGVwbG95bWVudCBjb25maWcgZm9yIHNjaGVtYSBbJHtzY2hlbWEubmFtZX1dLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MuZGF0YVNvdXJjZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY2hhbmdlTG9nLmRhdGFTb3VyY2VcIiBpcyByZXF1aXJlZC4gU2NoZW1hOiAke3NjaGVtYS5uYW1lfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oZmVhdHVyZSwgY2hhbmdlTG9nU2V0dGluZ3MpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnYXV0b0lkJywgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGluZGV4ZXM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwiZmllbGRzXCI6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXSxcbiAgICAgICAgICAgICAgICAgICAgXCJ1bmlxdWVcIjogdHJ1ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBhc3NvY2lhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkxTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkxUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTJOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTJSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IHJlbGF0aW9uRW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTIgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTJOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQyIFxuICAgICAqL1xuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykgeyAgICAgIFxuICAgICAgICAgICAgLy8gY2hlY2sgaWYgdGhlIHJlbGF0aW9uIGVudGl0eSBoYXMgdGhlIHJlZmVyc1RvIGJvdGggc2lkZSBvZiBhc3NvY2lhdGlvbnMgICAgICAgIFxuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MU5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MSA9IHRydWU7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTJOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgLy95ZXMsIGRvbid0IG5lZWQgdG8gYWRkIHJlZmVyc1RvIHRvIHRoZSByZWxhdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdGFnMSA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTFOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZH1gO1xuICAgICAgICBsZXQgdGFnMiA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTJOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZDJ9YDtcblxuICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSkge1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpO1xuXG4gICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG5cbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICBcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMn1gKTtcblxuICAgICAgICBsZXQga2V5RW50aXR5MSA9IGVudGl0eTEuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTFOYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTJOYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBrZXlFbnRpdHkxKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Miwga2V5RW50aXR5Mik7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkxTmFtZSB9XG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTJOYW1lIH1cbiAgICAgICAgKTtcblxuICAgICAgICBsZXQgYWxsQ2FzY2FkZSA9IHsgb25VcGRhdGU6ICdSRVNUUklDVCcsIG9uRGVsZXRlOiAnUkVTVFJJQ1QnIH07XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSwgYWxsQ2FzY2FkZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lLCBhbGxDYXNjYWRlKTsgICAgICAgIFxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICAvKlxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfSovXG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5LyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pIHtcbiAgICAgICAgbGV0IHJlZlRhYmxlID0gcmVsYXRpb24ucmlnaHQ7XG5cbiAgICAgICAgaWYgKHJlZlRhYmxlLmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIHJlZkVudGl0eU5hbWUgXSA9IHJlZlRhYmxlLnNwbGl0KCcuJyk7ICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRDb25uZWN0b3IgPSBzY2hlbWFUb0Nvbm5lY3RvcltzY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGFzc2VydDogdGFyZ2V0Q29ubmVjdG9yO1xuXG4gICAgICAgICAgICByZWZUYWJsZSA9IHRhcmdldENvbm5lY3Rvci5kYXRhYmFzZSArICdgLmAnICsgcmVmRW50aXR5TmFtZTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWZUYWJsZSArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gYE9OIFVQREFURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uVXBkYXRlfSBPTiBERUxFVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vbkRlbGV0ZX07XFxuYDtcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19