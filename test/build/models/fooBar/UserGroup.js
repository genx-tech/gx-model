const { _ } = require('rk-utils');
const { 
    Types,
    Activators,
    Validators, 
    Processors, 
    Generators, 
    Errors: { ValidationError, DatabaseError }, 
    Utils: { Lang: { isNothing } } 
} = require('@genx/data');
 

module.exports = (Base) => {    
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
    
    UserGroupSpec.meta = {
        "schemaName": "fooBar",
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
            }
        },
        "uniqueKeys": [
            [
                "id"
            ]
        ],
        "associations": {
            "user": {
                "type": "refersTo",
                "entity": "user",
                "key": "id",
                "field": "id",
                "on": {
                    "user": {
                        "oorType": "ColumnReference",
                        "name": "user.id"
                    }
                }
            },
            "group": {
                "type": "refersTo",
                "entity": "group",
                "key": "id",
                "field": "id",
                "on": {
                    "group": {
                        "oorType": "ColumnReference",
                        "name": "group.id"
                    }
                }
            }
        },
        "fieldDependencies": {
            "id": [
                {
                    "reference": "id",
                    "writeProtect": true
                }
            ]
        }
    };

    return Object.assign(UserGroupSpec, {});
};