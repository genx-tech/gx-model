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
    const GenderSpec = class extends Base {    
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
    
    GenderSpec.meta = {
        "schemaName": "fooBar",
        "name": "gender",
        "keyField": "code",
        "fields": {
            "code": {
                "type": "text",
                "maxLength": 1,
                "comment": "Gender Code",
                "displayName": "Code",
                "createByDb": true
            },
            "name": {
                "type": "text",
                "maxLength": 20,
                "optional": true,
                "comment": "Gender Name",
                "displayName": "Name"
            }
        },
        "features": {},
        "uniqueKeys": [
            [
                "code"
            ]
        ]
    };

    return Object.assign(GenderSpec, {});
};