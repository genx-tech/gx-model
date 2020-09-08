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
    const GroupSpec = class extends Base {    
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
    
    GroupSpec.meta = {
        "schemaName": "fooBar",
        "name": "group",
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
            "name": {
                "type": "text",
                "maxLength": 255,
                "optional": true,
                "comment": "Group Name",
                "displayName": "Name"
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
            "users": {
                "entity": "userGroup",
                "key": "id",
                "on": {
                    "id": {
                        "oorType": "ColumnReference",
                        "name": "users.group"
                    }
                },
                "field": "group",
                "list": true,
                "assoc": "user"
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

    return Object.assign(GroupSpec, {});
};