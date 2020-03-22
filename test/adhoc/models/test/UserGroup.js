const { _ } = require('rk-utils');

const { 
    Types,
    Activators,
    Validators, 
    Processors, 
    Generators, 
    Errors: { BusinessError, DataValidationError, DsOperationError }, 
    Utils: { Lang: { isNothing } } 
} = require('@k-suite/oolong');
 

module.exports = (db, BaseEntityModel) => {
    let Base = BaseEntityModel;
    
    const UserGroupSpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
            return context;
        }
    };

    UserGroupSpec.db = db;
    UserGroupSpec.meta = {
        "schemaName": "test",
        "name": "userGroup",
        "keyField": "id",
        "fields": {
            "id": {
                "type": "integer",
                "auto": true,
                "writeOnce": true,
                "displayName": "Id",
                "autoIncrementId": true,
                "createByDb": true
            },
            "createdAt": {
                "type": "datetime",
                "auto": true,
                "readOnly": true,
                "writeOnce": true,
                "displayName": "Created At",
                "isCreateTimestamp": true,
                "createByDb": true
            },
            "user": {
                "type": "integer",
                "displayName": "User",
                "createByDb": true
            },
            "group": {
                "type": "integer",
                "displayName": "Group",
                "createByDb": true
            }
        },
        "features": {
            "autoId": {
                "field": "id"
            },
            "createTimestamp": {
                "field": "createdAt"
            }
        },
        "uniqueKeys": [
            [
                "id"
            ],
            [
                "group",
                "user"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "group",
                    "user"
                ],
                "unique": true
            }
        ],
        "associations": {
            "user": {
                "entity": "user"
            },
            "group": {
                "entity": "group"
            }
        },
        "fieldDependencies": {
            "id": [
                "id"
            ],
            "createdAt": [
                "createdAt"
            ]
        }
    };

    return Object.assign(UserGroupSpec, {});
};