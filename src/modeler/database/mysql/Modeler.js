"use strict";

const EventEmitter = require("events");
const path = require("path");

const Util = require("rk-utils");
const { _, fs, quote, putIntoBucket } = Util;

const GemlUtils = require("../../../lang/GemlUtils");
const { pluralize, isDotSeparateName, extractDotSeparateName } = GemlUtils;
const Entity = require("../../../lang/Entity");
const { Types } = require("@genx/data");

const UNSUPPORTED_DEFAULT_VALUE = new Set(["BLOB", "TEXT", "JSON", "GEOMETRY"]);

/**
 * Ooolong database modeler for mysql db.
 * @class
 */
class MySQLModeler {
    /**
     * @param {object} context
     * @property {OolongLinker} context.linker - Oolong DSL linker
     * @property {string} context.scriptPath - Generated script path
     * @param {object} dbOptions
     * @property {object} dbOptions.db
     * @property {object} dbOptions.table
     */
    constructor(context, linker, connector, dbOptions) {
        this.linker = linker;
        this.outputPath = context.scriptPath;
        this.connector = connector;

        this._events = new EventEmitter();

        this._dbOptions = dbOptions
            ? {
                  db: _.mapKeys(dbOptions.db, (value, key) => _.upperCase(key)),
                  table: _.mapKeys(dbOptions.table, (value, key) => _.upperCase(key)),
              }
            : {};

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

                entity.info.associations.forEach((assoc) =>
                    this._processAssociation(modelingSchema, entity, assoc, assocNames, pendingEntities)
                );
            }
        }

        this._events.emit("afterRelationshipBuilding");

        //build SQL scripts
        let sqlFilesDir = path.join("mysql", this.connector.database);
        let dbFilePath = path.join(sqlFilesDir, "entities.sql");
        let fkFilePath = path.join(sqlFilesDir, "relations.sql");

        let tableSQL = "",
            relationSQL = "",
            data = {};

        //let mapOfEntityNameToCodeName = {};

        _.each(modelingSchema.entities, (entity, entityName) => {
            assert: entityName === entity.name;
            //mapOfEntityNameToCodeName[entityName] = entity.code;

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
                        f.forEach((ff) => this._featureReducer(modelingSchema, entity, featureName, ff));
                    } else {
                        this._featureReducer(modelingSchema, entity, featureName, f);
                    }
                });
            }

            if (!skipGeneration) {
                tableSQL += this._createTableStatement(entityName, entity /*, mapOfEntityNameToCodeName*/) + "\n";

                if (entity.info.data) {
                    entity.info.data.forEach(({ dataSet, runtimeEnv, records }) => {
                        //intiSQL += `-- Initial data for entity: ${entityName}\n`;

                        let entityData = [];

                        if (Array.isArray(records)) {
                            records.forEach((record) => {
                                if (!_.isPlainObject(record)) {
                                    let fields = Object.keys(entity.fields);
                                    if (fields.length !== 2) {
                                        throw new Error(
                                            `Invalid data syntax: entity "${entity.name}" has more than 2 fields.`
                                        );
                                    }

                                    let keyField = entity.fields[fields[0]];

                                    if (!keyField.auto && !keyField.defaultByDb) {
                                        throw new Error(
                                            `The key field "${entity.name}" has no default value or auto-generated value.`
                                        );
                                    }

                                    record = { [fields[1]]: this.linker.translateOolValue(entity.gemlModule, record) };
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
                                        throw new Error(
                                            `Invalid data syntax: entity "${entity.name}" has more than 2 fields.`
                                        );
                                    }

                                    record = {
                                        [entity.key]: key,
                                        [fields[1]]: this.linker.translateOolValue(entity.gemlModule, record),
                                    };
                                } else {
                                    record = Object.assign(
                                        { [entity.key]: key },
                                        this.linker.translateOolValue(entity.gemlModule, record)
                                    );
                                }

                                entityData.push(record);
                                //intiSQL += 'INSERT INTO `' + entityName + '` SET ' + _.map(record, (v,k) => '`' + k + '` = ' + JSON.stringify(v)).join(', ') + ';\n';
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

                    //intiSQL += '\n';
                }
            }
        });

        if (!skipGeneration) {
            _.forOwn(this._references, (refs, srcEntityName) => {
                _.each(refs, (ref) => {
                    relationSQL +=
                        this._addForeignKeyStatement(
                            srcEntityName,
                            ref,
                            schemaToConnector /*, mapOfEntityNameToCodeName*/
                        ) + "\n";
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

                            this._writeFile(
                                path.join(this.outputPath, initFilePath),
                                JSON.stringify({ [entityName]: records }, null, 4)
                            );
                        });
                    });
                });
            }

            //console.dir(initIdxFiles, {depth: 10});

            _.forOwn(initIdxFiles, (list, filePath) => {
                let idxFilePath = path.join(this.outputPath, filePath);

                let manual = [];

                if (fs.existsSync(idxFilePath)) {
                    let lines = fs.readFileSync(idxFilePath, "utf8").split("\n");
                    lines.forEach((line) => {
                        if (!line.startsWith("0-")) {
                            manual.push(line);
                        }
                    });
                }

                this._writeFile(idxFilePath, list.concat(manual).join("\n"));
            });

            let funcSQL = "";

            //process view
            /*
            _.each(modelingSchema.views, (view, viewName) => {
                view.inferTypeInfo(modelingSchema);

                funcSQL += `CREATE PROCEDURE ${dbService.getViewSPName(viewName)}(`;
                
                if (!_.isEmpty(view.params)) {
                    let paramSQLs = [];
                    view.params.forEach(param => {
                        paramSQLs.push(`p${_.upperFirst(param.name)} ${MySQLModeler.columnDefinition(param, true)}`);
                    });

                    funcSQL += paramSQLs.join(', ');
                }

                funcSQL += `)\nCOMMENT 'SP for view ${viewName}'\nREADS SQL DATA\nBEGIN\n`;

                funcSQL += this._viewDocumentToSQL(modelingSchema, view) + ';';

                funcSQL += '\nEND;\n\n';
            });
            */

            let spFilePath = path.join(sqlFilesDir, "procedures.sql");
            this._writeFile(path.join(this.outputPath, spFilePath), funcSQL);
        }

        return modelingSchema;
    }

    _toColumnReference(name) {
        return { oorType: "ColumnReference", name };
    }

    _translateJoinCondition(context, localField, anchor, remoteField) {
        if (Array.isArray(remoteField)) {
            return remoteField.map((rf) => this._translateJoinCondition(context, localField, anchor, rf));
        }

        if (_.isPlainObject(remoteField)) {
            let ret = { [localField]: this._toColumnReference(anchor + "." + remoteField.by) };
            let withExtra = this._oolConditionToQueryCondition(context, remoteField.with);

            if (localField in withExtra) {
                return { $and: [ret, withExtra] };
            }

            return { ...ret, ...withExtra };
        }

        return { [localField]: this._toColumnReference(anchor + "." + remoteField) };
    }

    _getAllRelatedFields(remoteField) {
        if (!remoteField) return undefined;

        if (Array.isArray(remoteField)) {
            return remoteField.map((rf) => this._getAllRelatedFields(rf));
        }

        if (_.isPlainObject(remoteField)) {
            return remoteField.by;
        }

        return remoteField;
    }

    _preProcessAssociations(entity) {
        return entity.info.associations.map((assoc) => {
            if (assoc.srcField) return assoc.srcField;

            if (assoc.type === "hasMany") {
                return pluralize(assoc.destEntity);
            }

            return assoc.destEntity;
        });
    }

    /**
     * hasMany/hasOne - belongsTo
     * hasMany/hasOne - hasMany/hasOne [by] [with]
     * hasMany - semi connection
     * refersTo - semi connection
     *
     * remoteField:
     *   1. fieldName
     *   2. array of fieldName
     *   3. { by , with }
     *   4. array of fieldName and { by , with } mixed
     *
     * @param {*} schema
     * @param {*} entity
     * @param {*} assoc
     */
    _processAssociation(schema, entity, assoc, assocNames, pendingEntities) {
        let entityKeyField = entity.getKeyField();
        assert: !Array.isArray(entityKeyField);

        this.linker.log("debug", `Processing "${entity.name}" ${JSON.stringify(assoc)}`);

        let destEntityName = assoc.destEntity,
            destEntity,
            destEntityNameAsFieldName;

        if (isDotSeparateName(destEntityName)) {
            //cross db reference
            let [destSchemaName, actualDestEntityName] = extractDotSeparateName(destEntityName);

            let destSchema = schema.linker.schemas[destSchemaName];
            if (!destSchema.linked) {
                throw new Error(
                    `The destination schema ${destSchemaName} has not been linked yet. Currently only support one-way reference for cross db relation.`
                );
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
        assert: destKeyField,
            `Empty key field "${destEntity.keyField}". Dest entity: ${destEntityName}, current entity: ${entity.name}`;

        if (Array.isArray(destKeyField)) {
            throw new Error(`Destination entity "${destEntityName}" with combination primary key is not supported.`);
        }

        switch (assoc.type) {
            case "hasOne":
            case "hasMany":
                let includes;
                let excludes = {
                    types: ["refersTo"],
                    association: assoc,
                };

                if (assoc.by) {
                    excludes.types.push("belongsTo");
                    includes = {
                        by: (cb) => cb && cb.split(".")[0] === assoc.by.split(".")[0],
                    };

                    if (assoc.with) {
                        includes.with = assoc.with;
                    }
                } else {
                    let remoteFields = this._getAllRelatedFields(assoc.remoteField);

                    includes = {
                        srcField: (remoteField) => {
                            remoteField || (remoteField = entity.name);

                            return (
                                _.isNil(remoteFields) ||
                                (Array.isArray(remoteFields)
                                    ? remoteFields.indexOf(remoteField) > -1
                                    : remoteFields === remoteField)
                            );
                        },
                    };
                }

                let backRef = destEntity.getReferenceTo(entity.name, includes, excludes);
                if (backRef) {
                    if (backRef.type === "hasMany" || backRef.type === "hasOne") {
                        if (!assoc.by) {
                            throw new Error(
                                '"m2n" association requires "by" property. Entity: ' +
                                    entity.name +
                                    " destination: " +
                                    destEntityName
                            );
                        }

                        // one/many to one/many relation

                        let connectedByParts = assoc.by.split(".");
                        assert: connectedByParts.length <= 2;

                        // connected by field is usually a refersTo assoc
                        let connectedByField = (connectedByParts.length > 1 && connectedByParts[1]) || entity.name;
                        let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);

                        assert: connEntityName;

                        let tag1 = `${entity.name}:${assoc.type === "hasMany" ? "m" : "1"}-${destEntityName}:${
                            backRef.type === "hasMany" ? "n" : "1"
                        } by ${connEntityName}`;
                        let tag2 = `${destEntityName}:${backRef.type === "hasMany" ? "m" : "1"}-${entity.name}:${
                            assoc.type === "hasMany" ? "n" : "1"
                        } by ${connEntityName}`;

                        if (assoc.srcField) {
                            tag1 += " " + assoc.srcField;
                        }

                        if (backRef.srcField) {
                            tag2 += " " + backRef.srcField;
                        }

                        if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
                            //already processed, skip
                            return;
                        }

                        let connectedByParts2 = backRef.by.split(".");
                        let connectedByField2 =
                            (connectedByParts2.length > 1 && connectedByParts2[1]) || destEntityNameAsFieldName;

                        if (connectedByField === connectedByField2) {
                            throw new Error('Cannot use the same "by" field in a relation entity.');
                        }

                        let connEntity = schema.ensureGetEntity(entity.gemlModule, connEntityName, pendingEntities);
                        if (!connEntity) {
                            //create a
                            connEntity = this._addRelationEntity(
                                schema,
                                connEntityName,
                                entity.name,
                                destEntityName,
                                connectedByField,
                                connectedByField2
                            );
                            pendingEntities.push(connEntity.name);
                            this.linker.log("debug", `New entity "${connEntity.name}" added by association.`);
                        }

                        this._updateRelationEntity(
                            connEntity,
                            entity,
                            destEntity,
                            entity.name,
                            destEntityName,
                            connectedByField,
                            connectedByField2
                        );

                        let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);

                        entity.addAssociation(localFieldName, {
                            entity: connEntityName,
                            key: connEntity.key,
                            on: this._translateJoinCondition(
                                { ...assocNames, [connEntityName]: localFieldName },
                                entity.key,
                                localFieldName,
                                assoc.with
                                    ? {
                                          by: connectedByField,
                                          with: assoc.with,
                                      }
                                    : connectedByField
                            ),
                            field: connectedByField,
                            ...(assoc.type === "hasMany" ? { list: true } : {}),
                            assoc: connectedByField2,
                        });

                        let remoteFieldName = backRef.srcField || pluralize(entity.name);

                        destEntity.addAssociation(remoteFieldName, {
                            entity: connEntityName,
                            key: connEntity.key,
                            on: this._translateJoinCondition(
                                { ...assocNames, [connEntityName]: remoteFieldName },
                                destEntity.key,
                                remoteFieldName,
                                backRef.with
                                    ? {
                                          by: connectedByField2,
                                          with: backRef.with,
                                      }
                                    : connectedByField2
                            ),
                            field: connectedByField2,
                            ...(backRef.type === "hasMany" ? { list: true } : {}),
                            assoc: connectedByField,
                        });

                        this._processedRef.add(tag1);
                        this.linker.log("verbose", `Processed 2-way reference: ${tag1}`);

                        this._processedRef.add(tag2);
                        this.linker.log("verbose", `Processed 2-way reference: ${tag2}`);
                    } else if (backRef.type === "belongsTo") {
                        if (assoc.by) {
                            throw new Error("todo: belongsTo by. entity: " + entity.name);
                        } else {
                            //leave it to the referenced entity
                            let anchor =
                                assoc.srcField ||
                                (assoc.type === "hasMany"
                                    ? pluralize(destEntityNameAsFieldName)
                                    : destEntityNameAsFieldName);
                            let remoteField = assoc.remoteField || backRef.srcField || entity.name;

                            //check if the target entity has logical deletion feature
                            if (destEntity.hasFeature("logicalDeletion")) {
                                let deletionCheck = {
                                    oolType: "BinaryExpression",
                                    operator: "!=",
                                    left: {
                                        oolType: "ObjectReference",
                                        name: `${destEntityName}.${destEntity.features["logicalDeletion"].field}`,
                                    },
                                    right: true,
                                };

                                if (_.isPlainObject(remoteField)) {
                                    remoteField.with = {
                                        oolType: "LogicalExpression",
                                        operator: "and",
                                        left: remoteField.with,
                                        right: deletionCheck,
                                    };
                                } else if (assoc.with) {
                                    assoc.with = {
                                        oolType: "LogicalExpression",
                                        operator: "and",
                                        left: assoc.with,
                                        right: deletionCheck,
                                    };
                                } else {
                                    assoc.with = deletionCheck;
                                }
                            }

                            entity.addAssociation(anchor, {
                                entity: destEntityName,
                                key: destEntity.key,
                                on: this._translateJoinCondition(
                                    { ...assocNames, [destEntityName]: anchor },
                                    entity.key,
                                    anchor,
                                    assoc.with
                                        ? {
                                              by: remoteField,
                                              with: assoc.with,
                                          }
                                        : remoteField
                                ),
                                ...(typeof remoteField === "string" ? { field: remoteField } : {}),
                                ...(assoc.type === "hasMany" ? { list: true } : {}),
                            });
                        }
                    } else {
                        throw new Error(
                            "Unexpected path. Entity: " +
                                entity.name +
                                ", association: " +
                                JSON.stringify(assoc, null, 2)
                        );
                    }
                } else {
                    // semi association

                    let connectedByParts = assoc.by
                        ? assoc.by.split(".")
                        : [GemlUtils.prefixNaming(entity.name, destEntityName)];
                    assert: connectedByParts.length <= 2;

                    let connectedByField = (connectedByParts.length > 1 && connectedByParts[1]) || entity.name;
                    let connEntityName = GemlUtils.entityNaming(connectedByParts[0]);

                    assert: connEntityName;

                    let tag1 = `${entity.name}:${
                        assoc.type === "hasMany" ? "m" : "1"
                    }-${destEntityName}:* by ${connEntityName}`;

                    if (assoc.srcField) {
                        tag1 += " " + assoc.srcField;
                    }

                    assert: !this._processedRef.has(tag1);

                    let connEntity = schema.ensureGetEntity(entity.gemlModule, connEntityName, pendingEntities);
                    if (!connEntity) {
                        //create a
                        connEntity = this._addRelationEntity(
                            schema,
                            connEntityName,
                            entity.name,
                            destEntityName,
                            connectedByField,
                            destEntityNameAsFieldName
                        );
                        pendingEntities.push(connEntity.name);
                        this.linker.log("debug", `New entity "${connEntity.name}" added by association.`);
                    }

                    //todo: get back ref from connection entity
                    let connBackRef1 = connEntity.getReferenceTo(entity.name, {
                        type: "refersTo",
                        srcField: (f) => _.isNil(f) || f == connectedByField,
                    });

                    if (!connBackRef1) {
                        throw new Error(
                            `Cannot find back reference to "${entity.name}" from relation entity "${connEntityName}".`
                        );
                    }

                    let connBackRef2 = connEntity.getReferenceTo(
                        destEntityName,
                        { type: "refersTo" },
                        { association: connBackRef1 }
                    );

                    if (!connBackRef2) {
                        throw new Error(
                            `Cannot find back reference to "${destEntityName}" from relation entity "${connEntityName}".`
                        );
                    }

                    let connectedByField2 = connBackRef2.srcField || destEntityNameAsFieldName;

                    if (connectedByField === connectedByField2) {
                        throw new Error(
                            'Cannot use the same "by" field in a relation entity. Detail: ' +
                                JSON.stringify({
                                    src: entity.name,
                                    dest: destEntityName,
                                    srcField: assoc.srcField,
                                    by: connectedByField,
                                })
                        );
                    }

                    this._updateRelationEntity(
                        connEntity,
                        entity,
                        destEntity,
                        entity.name,
                        destEntityName,
                        connectedByField,
                        connectedByField2
                    );

                    let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);

                    entity.addAssociation(localFieldName, {
                        entity: connEntityName,
                        key: connEntity.key,
                        on: this._translateJoinCondition(
                            {
                                ...assocNames,
                                [destEntityName]: localFieldName + "." + connectedByField2,
                                [connEntityName]: localFieldName,
                            },
                            entity.key,
                            localFieldName,
                            assoc.with
                                ? {
                                      by: connectedByField,
                                      with: assoc.with,
                                  }
                                : connectedByField
                        ),
                        field: connectedByField,
                        ...(assoc.type === "hasMany" ? { list: true } : {}),
                        assoc: connectedByField2,
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
                            throw new Error(
                                `The field "${assoc.destField}" being referenced is not a field of entity "${destEntityName}".`
                            );
                        }

                        destFieldName = assoc.destField;
                        referencedField = destEntity.fields[destFieldName];
                    }

                    tag += "->" + assoc.destField;

                    if (this._processedRef.has(tag)) {
                        //already processed by connection, skip
                        return;
                    }

                    this._processedRef.add(tag);
                    this.linker.log("verbose", `Processed week reference: ${tag}`);
                }

                let joinOn = { [localField]: this._toColumnReference(localField + "." + destFieldName) };

                if (assoc.with) {
                    Object.assign(
                        joinOn,
                        this._oolConditionToQueryCondition({ ...assocNames, [destEntityName]: localField }, assoc.with)
                    );
                }

                entity.addAssocField(localField, destEntity, referencedField, assoc.fieldProps);
                entity.addAssociation(localField, {
                    type: assoc.type,
                    entity: destEntityName,
                    key: destEntity.key,
                    field: destFieldName,
                    on: joinOn,
                });

                //foreign key constraits
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
        assert: oolCon.oolType;

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
                    [left]: { $eq: right },
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
                    [left]: { $ne: right },
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
                        [arg]: { $eq: null },
                    };

                case "is-not-null":
                    arg = oolCon.argument;
                    if (arg.oolType && arg.oolType === "ObjectReference") {
                        arg = this._translateReference(context, arg.name, true);
                    }

                    return {
                        [arg]: { $ne: null },
                    };

                default:
                    throw new Error("Unknown UnaryExpression operator: " + oolCon.operator);
            }
        } else if (oolCon.oolType === "LogicalExpression") {
            switch (oolCon.operator) {
                case "and":
                    return {
                        $and: [
                            this._oolConditionToQueryCondition(context, oolCon.left),
                            this._oolConditionToQueryCondition(context, oolCon.right),
                        ],
                    };

                case "or":
                    return {
                        $or: [
                            this._oolConditionToQueryCondition(context, oolCon.left),
                            this._oolConditionToQueryCondition(context, oolCon.right),
                        ],
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
            leftField.forEach((lf) => this._addReference(left, lf, right, rightField, constraints));
            return;
        }

        if (_.isPlainObject(leftField)) {
            this._addReference(left, leftField.by, right.rightField, constraints);
            return;
        }

        assert: typeof leftField === "string";

        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) {
            refs4LeftEntity = [];
            this._references[left] = refs4LeftEntity;
        } else {
            let found = _.find(
                refs4LeftEntity,
                (item) => item.leftField === leftField && item.right === right && item.rightField === rightField
            );

            if (found) return;
        }

        refs4LeftEntity.push({ leftField, right, rightField, constraints });
    }

    _getReferenceOfField(left, leftField) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) {
            return undefined;
        }

        let reference = _.find(refs4LeftEntity, (item) => item.leftField === leftField);

        if (!reference) {
            return undefined;
        }

        return reference;
    }

    _hasReferenceOfField(left, leftField) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) return false;

        return undefined !== _.find(refs4LeftEntity, (item) => item.leftField === leftField);
    }

    _getReferenceBetween(left, right) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) {
            return undefined;
        }

        let reference = _.find(refs4LeftEntity, (item) => item.right === right);

        if (!reference) {
            return undefined;
        }

        return reference;
    }

    _hasReferenceBetween(left, right) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) return false;

        return undefined !== _.find(refs4LeftEntity, (item) => item.right === right);
    }

    _featureReducer(schema, entity, featureName, feature) {
        let field;

        switch (featureName) {
            case "autoId":
                field = entity.fields[feature.field];

                if (field.type === "integer" && !field.generator) {
                    field.autoIncrementId = true;
                    if ("startFrom" in feature) {
                        this._events.once("setTableOptions:" + entity.name, (extraOpts) => {
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
                    throw new Error(
                        `Missing "changeLog" feature settings in deployment config for schema [${schema.name}].`
                    );
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

    _addRelationEntity(
        schema,
        relationEntityName,
        entity1Name /* for cross db */,
        entity2Name /* for cross db */,
        entity1RefField,
        entity2RefField
    ) {
        let entityInfo = {
            features: ["autoId", "createTimestamp"],
            indexes: [
                {
                    fields: [entity1RefField, entity2RefField],
                    unique: true,
                },
            ],
            associations: [
                {
                    type: "refersTo",
                    destEntity: entity1Name,
                    srcField: entity1RefField,
                },
                {
                    type: "refersTo",
                    destEntity: entity2Name,
                    srcField: entity2RefField,
                },
            ],
        };

        let entity = new Entity(this.linker, relationEntityName, schema.gemlModule, entityInfo);
        entity.link();

        schema.addEntity(entity);

        return entity;
    }

    /**
     *
     * @param {*} relationEntity
     * @param {*} entity1
     * @param {*} entity2
     * @param {*} entity1Name
     * @param {*} entity2Name
     * @param {*} connectedByField
     * @param {*} connectedByField2
     */
    _updateRelationEntity(
        relationEntity,
        entity1,
        entity2,
        entity1Name /* for cross db */,
        entity2Name /* for cross db */,
        connectedByField,
        connectedByField2
    ) {
        let relationEntityName = relationEntity.name;

        this._relationEntities[relationEntityName] = true;

        if (relationEntity.info.associations) {
            // check if the relation entity has the refersTo both side of associations
            let hasRefToEntity1 = false,
                hasRefToEntity2 = false;

            _.each(relationEntity.info.associations, (assoc) => {
                if (
                    assoc.type === "refersTo" &&
                    assoc.destEntity === entity1Name &&
                    (assoc.srcField || entity1Name) === connectedByField
                ) {
                    hasRefToEntity1 = true;
                }

                if (
                    assoc.type === "refersTo" &&
                    assoc.destEntity === entity2Name &&
                    (assoc.srcField || entity2Name) === connectedByField2
                ) {
                    hasRefToEntity2 = true;
                }
            });

            if (hasRefToEntity1 && hasRefToEntity2) {
                //yes, don't need to add refersTo to the relation entity
                return;
            }
        }

        let tag1 = `${relationEntityName}:1-${entity1Name}:* ${connectedByField}`;
        let tag2 = `${relationEntityName}:1-${entity2Name}:* ${connectedByField2}`;

        if (this._processedRef.has(tag1)) {
            assert: this._processedRef.has(tag2);

            //already processed, skip
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

        relationEntity.addAssociation(connectedByField, { entity: entity1Name });
        relationEntity.addAssociation(connectedByField2, { entity: entity2Name });

        let allCascade = { onUpdate: "RESTRICT", onDelete: "RESTRICT" };

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
                    if (params && _.find(params, (p) => p.name === ool.name) !== -1) {
                        return "p" + _.upperFirst(ool.name);
                    }

                    throw new Error(`Referencing to a non-existing param "${ool.name}".`);
                }

                let { entityNode, entity, field } = GemlUtils.parseReferenceInDocument(schema, doc, ool.name);

                return entityNode.alias + "." + MySQLModeler.quoteIdentifier(field.name);

            default:
                throw new Error("oolToSql to be implemented.");
        }
    }

    static _orderByToSql(schema, doc, ool) {
        return (
            MySQLModeler.oolToSql(schema, doc, { oolType: "ObjectReference", name: ool.field }) +
            (ool.ascend ? "" : " DESC")
        );
    }

    _viewDocumentToSQL(modelingSchema, view) {
        let sql = "  ";
        //console.log('view: ' + view.name);
        let doc = _.cloneDeep(view.getDocumentHierarchy(modelingSchema));
        //console.dir(doc, {depth: 8, colors: true});

        //let aliasMapping = {};
        let [colList, alias, joins] = this._buildViewSelect(modelingSchema, doc, 0);

        sql += "SELECT " + colList.join(", ") + " FROM " + MySQLModeler.quoteIdentifier(doc.entity) + " AS " + alias;

        if (!_.isEmpty(joins)) {
            sql += " " + joins.join(" ");
        }

        if (!_.isEmpty(view.selectBy)) {
            sql +=
                " WHERE " +
                view.selectBy
                    .map((select) => MySQLModeler.oolToSql(modelingSchema, doc, select, view.params))
                    .join(" AND ");
        }

        if (!_.isEmpty(view.groupBy)) {
            sql +=
                " GROUP BY " +
                view.groupBy.map((col) => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(", ");
        }

        if (!_.isEmpty(view.orderBy)) {
            sql +=
                " ORDER BY " +
                view.orderBy.map((col) => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(", ");
        }

        let skip = view.skip || 0;
        if (view.limit) {
            sql +=
                " LIMIT " +
                MySQLModeler.oolToSql(modelingSchema, doc, skip, view.params) +
                ", " +
                MySQLModeler.oolToSql(modelingSchema, doc, view.limit, view.params);
        } else if (view.skip) {
            sql += " OFFSET " + MySQLModeler.oolToSql(modelingSchema, doc, view.skip, view.params);
        }

        return sql;
    }

    /*
    _buildViewSelect(schema, doc, startIndex) {
        let entity = schema.entities[doc.entity];
        let alias = ntol(startIndex++);
        doc.alias = alias;

        let colList = Object.keys(entity.fields).map(k => alias + '.' + MySQLModeler.quoteIdentifier(k));
        let joins = [];

        if (!_.isEmpty(doc.subDocuments)) {
            _.forOwn(doc.subDocuments, (doc, fieldName) => {
                let [ subColList, subAlias, subJoins, startIndex2 ] = this._buildViewSelect(schema, doc, startIndex);
                startIndex = startIndex2;
                colList = colList.concat(subColList);
                
                joins.push('LEFT JOIN ' + MySQLModeler.quoteIdentifier(doc.entity) + ' AS ' + subAlias
                    + ' ON ' + alias + '.' + MySQLModeler.quoteIdentifier(fieldName) + ' = ' +
                    subAlias + '.' + MySQLModeler.quoteIdentifier(doc.linkWithField));

                if (!_.isEmpty(subJoins)) {
                    joins = joins.concat(subJoins);
                }
            });
        }

        return [ colList, alias, joins, startIndex ];
    }*/

    _createTableStatement(entityName, entity /*, mapOfEntityNameToCodeName*/) {
        let sql = "CREATE TABLE IF NOT EXISTS `" + entityName + "` (\n";

        //column definitions
        _.each(entity.fields, (field, name) => {
            sql += "  " + MySQLModeler.quoteIdentifier(name) + " " + MySQLModeler.columnDefinition(field) + ",\n";
        });

        //primary key
        sql += "  PRIMARY KEY (" + MySQLModeler.quoteListOrValue(entity.key) + "),\n";

        //other keys
        if (entity.indexes && entity.indexes.length > 0) {
            entity.indexes.forEach((index) => {
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

        //table options
        let extraProps = {};
        this._events.emit("setTableOptions:" + entityName, extraProps);
        let props = Object.assign({}, this._dbOptions.table, extraProps);

        sql = _.reduce(
            props,
            function (result, value, key) {
                return result + " " + key + "=" + value;
            },
            sql
        );

        sql += ";\n";

        return sql;
    }

    _addForeignKeyStatement(entityName, relation, schemaToConnector /*, mapOfEntityNameToCodeName*/) {
        let refTable = relation.right;

        if (refTable.indexOf(".") > 0) {
            let [schemaName, refEntityName] = refTable.split(".");

            let targetConnector = schemaToConnector[schemaName];
            assert: targetConnector;

            refTable = targetConnector.database + "`.`" + refEntityName;
        }

        let sql =
            "ALTER TABLE `" +
            entityName +
            "` ADD FOREIGN KEY (`" +
            relation.leftField +
            "`) " +
            "REFERENCES `" +
            refTable +
            "` (`" +
            relation.rightField +
            "`) ";

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
        return _.isArray(obj)
            ? obj.map((v) => MySQLModeler.quoteIdentifier(v)).join(", ")
            : MySQLModeler.quoteIdentifier(obj);
    }

    static complianceCheck(entity) {
        let result = { errors: [], warnings: [] };

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

        let { sql, type } = col;

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

        return { sql, type };
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

        return { sql, type };
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

        return { sql, type };
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

        return { sql, type };
    }

    static boolColumnDefinition() {
        return { sql: "TINYINT(1)", type: "TINYINT" };
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

        return { sql, type: sql };
    }

    static enumColumnDefinition(info) {
        return { sql: "ENUM(" + _.map(info.values, (v) => MySQLModeler.quoteString(v)).join(", ") + ")", type: "ENUM" };
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
                            sql +=
                                " DEFAULT " +
                                Util.quote(Types.DATETIME.sanitize(defaultValue).toSQL({ includeOffset: false }));
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

                //not explicit specified, will not treated as createByDb
                //info.createByDb = true;
            }
        }

        /*
        if (info.hasOwnProperty('default') && typeof info.default === 'object' && info.default.oolType === 'SymbolToken') {
            let defaultValue = info.default;
            let defaultByDb = false;

            switch (defaultValue.name) {
                case 'now':
                sql += ' DEFAULT NOW'
                break;
            }

            if (defaultByDb) {
                delete info.default;
                info.defaultByDb = true;
            }

            if (info.type === 'bool') {
                if (_.isString(defaultValue)) {
                    sql += ' DEFAULT ' + (S(defaultValue).toBoolean() ? '1' : '0');
                } else {
                    sql += ' DEFAULT ' + (defaultValue ? '1' : '0');
                }
            } else if (info.type === 'int') {
                if (_.isInteger(defaultValue)) {
                    sql += ' DEFAULT ' + defaultValue.toString();
                } else {
                    sql += ' DEFAULT ' + parseInt(defaultValue).toString();
                }
            } else if (info.type === 'text') {
                sql += ' DEFAULT ' + Util.quote(defaultValue);
            } else if (info.type === 'float') {
                if (_.isNumber(defaultValue)) {
                    sql += ' DEFAULT ' + defaultValue.toString();
                } else {
                    sql += ' DEFAULT ' + parseFloat(defaultValue).toString();
                }
            } else if (info.type === 'binary') {
                sql += ' DEFAULT ' + Util.bin2Hex(defaultValue);
            } else if (info.type === 'datetime') {
                if (_.isInteger(defaultValue)) {
                    sql += ' DEFAULT ' + defaultValue.toString();
                } else {
                    sql += ' DEFAULT ' + Util.quote(defaultValue);
                }
            } else if (info.type === 'json') {
                if (typeof defaultValue === 'string') {
                    sql += ' DEFAULT ' + Util.quote(defaultValue);
                } else {
                    sql += ' DEFAULT ' + Util.quote(JSON.stringify(defaultValue));
                }
            } else if (info.type === 'xml' || info.type === 'enum' || info.type === 'csv') {
                sql += ' DEFAULT ' + Util.quote(defaultValue);
            } else {
                throw new Error('Unexpected path');
            }            
        }    
        */

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
