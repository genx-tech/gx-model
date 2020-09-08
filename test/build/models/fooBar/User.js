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
const normalizeMobile = require('./processors/user-normalizeMobile.js');
const hashPassword = require('./processors/user-hashPassword.js'); 

module.exports = (Base) => {    
    const UserSpec = class extends Base {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
            if (!isNothing(latest['email']) && !latest['email'].oorType) {
                //Validating "email"
                if (!Validators.isEmail(latest['email'])) {
                    throw new ValidationError('Invalid "email".', {
                        entity: this.meta.name,
                        field: 'email',
                        value: latest['email']
                    });
                }
            }
            if (!isNothing(latest['mobile']) && !latest['mobile'].oorType) {
                //Validating "mobile"
                if (!Validators.matches(latest['mobile'], new RegExp('^((\\+|00)\\d+)?\\d+(-\\d+)?$'))) {
                    throw new ValidationError('Invalid "mobile".', {
                        entity: this.meta.name,
                        field: 'mobile',
                        value: latest['mobile']
                    });
                }
            }
            if (!isNothing(latest['password']) && !latest['password'].oorType) {
                if (isUpdating && isNothing(latest['password'])) {
                    throw new ValidationError('"password" is required due to change of its dependencies. (e.g: passwordSalt)');
                }
                //Processing "password"
                latest['password'] = hashPassword(latest['password'], latest.hasOwnProperty('passwordSalt') ? latest['passwordSalt'] : existing['passwordSalt']);
            }
            if (!isNothing(latest['mobile']) && !latest['mobile'].oorType) {
                if (isUpdating && isNothing(latest['mobile'])) {
                    throw new ValidationError('"mobile" is required due to change of its dependencies. (e.g: locale)');
                }
                //Validating "mobile"
                if (!Validators.isMobilePhone(latest['mobile'], Processors.stringDasherize(latest.hasOwnProperty('locale') ? latest['locale'] : existing['locale']))) {
                    throw new ValidationError('Invalid "mobile".', {
                        entity: this.meta.name,
                        field: 'mobile',
                        value: latest['mobile']
                    });
                }
            }
            if (!isNothing(latest['mobile']) && !latest['mobile'].oorType) {
                //Processing "mobile"
                latest['mobile'] = normalizeMobile(latest['mobile']);
            }
            return context;
        }
    };
    
    UserSpec.meta = {
        "schemaName": "fooBar",
        "name": "user",
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
            "email": {
                "type": "text",
                "maxLength": 200,
                "comment": "User Email",
                "subClass": [
                    "email"
                ],
                "displayName": "Email",
                "optional": true
            },
            "mobile": {
                "type": "text",
                "maxLength": 20,
                "comment": "User Mobile",
                "subClass": [
                    "phone"
                ],
                "displayName": "Mobile",
                "optional": true
            },
            "password": {
                "type": "text",
                "maxLength": 200,
                "comment": "User Password",
                "subClass": [
                    "password"
                ],
                "displayName": "Password",
                "createByDb": true
            },
            "passwordSalt": {
                "type": "text",
                "fixedLength": 8,
                "auto": true,
                "comment": "User Password Salt",
                "displayName": "Password Salt"
            },
            "locale": {
                "type": "text",
                "default": "en_AU",
                "comment": "User Locale",
                "displayName": "Locale"
            },
            "status": {
                "type": "enum",
                "values": [
                    "inactive",
                    "active",
                    "disabled",
                    "forbidden",
                    "deleted"
                ],
                "default": "inactive",
                "comment": "User Status",
                "subClass": [
                    "userStatus"
                ],
                "displayName": "Status"
            },
            "testToken": {
                "type": "datetime",
                "default": {
                    "oorType": "SymbolToken",
                    "name": "NOW"
                },
                "displayName": "Test Token"
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
            "updatedAt": {
                "type": "datetime",
                "readOnly": true,
                "forceUpdate": true,
                "optional": true,
                "displayName": "Updated At",
                "isUpdateTimestamp": true,
                "updateByDb": true
            },
            "statusInactiveTimestamp": {
                "type": "datetime",
                "readOnly": true,
                "optional": true,
                "auto": true,
                "writeOnce": true,
                "displayName": "Status Inactive Timestamp"
            },
            "statusActiveTimestamp": {
                "type": "datetime",
                "readOnly": true,
                "optional": true,
                "auto": true,
                "writeOnce": true,
                "displayName": "Status Active Timestamp"
            },
            "statusDisabledTimestamp": {
                "type": "datetime",
                "readOnly": true,
                "optional": true,
                "auto": true,
                "writeOnce": true,
                "displayName": "Status Disabled Timestamp"
            },
            "statusForbiddenTimestamp": {
                "type": "datetime",
                "readOnly": true,
                "optional": true,
                "auto": true,
                "writeOnce": true,
                "displayName": "Status Forbidden Timestamp"
            },
            "statusDeletedTimestamp": {
                "type": "datetime",
                "readOnly": true,
                "optional": true,
                "auto": true,
                "writeOnce": true,
                "displayName": "Status Deleted Timestamp"
            }
        },
        "features": {
            "autoId": {
                "field": "id",
                "startFrom": 100000
            },
            "createTimestamp": {
                "field": "createdAt"
            },
            "updateTimestamp": {
                "field": "updatedAt"
            },
            "logicalDeletion": {
                "field": "status",
                "value": "deleted"
            },
            "atLeastOneNotNull": [
                [
                    "email",
                    "mobile"
                ]
            ],
            "stateTracking": [
                {
                    "field": "status",
                    "stateMapping": {
                        "inactive": "statusInactiveTimestamp",
                        "active": "statusActiveTimestamp",
                        "disabled": "statusDisabledTimestamp",
                        "forbidden": "statusForbiddenTimestamp",
                        "deleted": "statusDeletedTimestamp"
                    }
                }
            ]
        },
        "uniqueKeys": [
            [
                "id"
            ],
            [
                "email"
            ],
            [
                "mobile"
            ]
        ],
        "indexes": [
            {
                "fields": [
                    "email"
                ],
                "unique": true
            },
            {
                "fields": [
                    "mobile"
                ],
                "unique": true
            }
        ],
        "associations": {
            "groups": {
                "entity": "userGroup",
                "key": "id",
                "on": {
                    "id": {
                        "oorType": "ColumnReference",
                        "name": "groups.user"
                    }
                },
                "field": "user",
                "list": true,
                "assoc": "group"
            },
            "profiles": {
                "entity": "profile",
                "key": "id",
                "on": {
                    "id": {
                        "oorType": "ColumnReference",
                        "name": "profiles.user"
                    }
                },
                "field": "user",
                "list": true
            }
        },
        "fieldDependencies": {
            "id": [
                {
                    "reference": "id",
                    "writeProtect": true
                }
            ],
            "createdAt": [
                {
                    "reference": "createdAt",
                    "writeProtect": true
                }
            ],
            "statusInactiveTimestamp": [
                {
                    "reference": "statusInactiveTimestamp",
                    "writeProtect": true
                }
            ],
            "statusActiveTimestamp": [
                {
                    "reference": "statusActiveTimestamp",
                    "writeProtect": true
                }
            ],
            "statusDisabledTimestamp": [
                {
                    "reference": "statusDisabledTimestamp",
                    "writeProtect": true
                }
            ],
            "statusForbiddenTimestamp": [
                {
                    "reference": "statusForbiddenTimestamp",
                    "writeProtect": true
                }
            ],
            "statusDeletedTimestamp": [
                {
                    "reference": "statusDeletedTimestamp",
                    "writeProtect": true
                }
            ],
            "password": [
                "latest.passwordSalt"
            ],
            "mobile": [
                "latest.locale"
            ]
        }
    };

    return Object.assign(UserSpec, {
        $normalizeMobile: normalizeMobile,
        $hashPassword: hashPassword
    });
};