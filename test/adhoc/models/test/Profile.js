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

    ProfileSpec.db = db;
    ProfileSpec.meta = {
        "schemaName": "test",
        "name": "profile",
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
            "firstName": {
                "type": "text",
                "maxLength": 40,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "First Name"
            },
            "middleName": {
                "type": "text",
                "maxLength": 40,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Middle Name"
            },
            "surName": {
                "type": "text",
                "maxLength": 40,
                "optional": true,
                "subClass": [
                    "name"
                ],
                "displayName": "Sur Name"
            },
            "dob": {
                "type": "datetime",
                "optional": true,
                "comment": "Date of birth",
                "displayName": "Dob"
            },
            "avatar": {
                "type": "text",
                "maxLength": 200,
                "optional": true,
                "subClass": [
                    "url"
                ],
                "displayName": "Avatar"
            },
            "gender": {
                "type": "text",
                "maxLength": 1,
                "comment": "Gender Code",
                "displayName": "Gender",
                "createByDb": true
            },
            "owner": {
                "type": "integer",
                "displayName": "Owner",
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
            "gender": {
                "entity": "gender",
                "key": "code",
                "on": {
                    "gender": {
                        "oorType": "ColumnReference",
                        "name": "gender.code"
                    }
                }
            },
            "owner": {
                "entity": "user",
                "key": "id",
                "on": {
                    "owner": {
                        "oorType": "ColumnReference",
                        "name": "owner.id"
                    }
                }
            }
        },
        "fieldDependencies": {
            "id": [
                "id"
            ]
        }
    };

    return Object.assign(ProfileSpec, {});
};