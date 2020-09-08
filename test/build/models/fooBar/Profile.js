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
    const ProfileSpec = class extends Base {    
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
    
    ProfileSpec.meta = {
        "schemaName": "fooBar",
        "name": "profile",
        "keyField": "id",
        "fields": {
            "id": {
                "type": "text",
                "maxLength": 32,
                "comment": "Profile Id",
                "displayName": "Id",
                "createByDb": true
            },
            "gender": {
                "type": "text",
                "maxLength": 1,
                "comment": "Gender Code",
                "displayName": "Gender",
                "createByDb": true
            },
            "user": {
                "type": "integer",
                "displayName": "User",
                "createByDb": true
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "id"
            ],
            [
                "user"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "user"
                ],
                "unique": true
            },
            {
                "fields": [
                    "gender"
                ]
            }
        ],
        "associations": {
            "gender": {
                "type": "refersTo",
                "entity": "gender",
                "key": "code",
                "field": "code",
                "on": {
                    "gender": {
                        "oorType": "ColumnReference",
                        "name": "gender.code"
                    }
                }
            },
            "user": {
                "type": "belongsTo",
                "entity": "user",
                "key": "id",
                "field": "id",
                "on": {
                    "user": {
                        "oorType": "ColumnReference",
                        "name": "user.id"
                    }
                }
            }
        }
    };

    return Object.assign(ProfileSpec, {});
};