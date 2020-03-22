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
const normalizeMobile = require('./processors/user-normalizeMobile.js');
const hashPassword = require('./processors/user-hashPassword.js'); 

module.exports = (db, BaseEntityModel) => {
    let Base = BaseEntityModel;
    
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
            if (!isNothing(latest['email'])) {
                //Validating "email"
                if (!Validators.isEmail(latest['email'])) {
                    throw new DataValidationError('Invalid "email".', {
                        entity: this.meta.name,
                        field: 'email',
                        value: latest['email']
                    });
                }
            }
            if (!isNothing(latest['mobile'])) {
                //Validating "mobile"
                if (!Validators.matches(latest['mobile'], new RegExp('^((\\+|00)\\d+)?\\d+(-\\d+)?$'))) {
                    throw new DataValidationError('Invalid "mobile".', {
                        entity: this.meta.name,
                        field: 'mobile',
                        value: latest['mobile']
                    });
                }
            }
            if (!isNothing(latest['password'])) {
                if (isUpdating && isNothing(latest['password'])) {
                    throw new DataValidationError('"password" is required due to change of its dependencies. (e.g: passwordSalt)');
                }
                if (!('passwordSalt' in latest) && !('passwordSalt' in existing)) {
                    throw new DataValidationError('Missing "passwordSalt" value, which is a dependency of "password".');
                }
                //Processing "password"
                latest['password'] = hashPassword(latest['password'], latest.hasOwnProperty('passwordSalt') ? latest['passwordSalt'] : existing['passwordSalt']);
            }
            if (!isNothing(latest['mobile'])) {
                if (isUpdating && isNothing(latest['mobile'])) {
                    throw new DataValidationError('"mobile" is required due to change of its dependencies. (e.g: locale)');
                }
                if (!('locale' in latest) && !('locale' in existing)) {
                    throw new DataValidationError('Missing "locale" value, which is a dependency of "mobile".');
                }
                //Validating "mobile"
                if (!Validators.isMobilePhone(latest['mobile'], Processors.stringDasherize(latest.hasOwnProperty('locale') ? latest['locale'] : existing['locale']))) {
                    throw new DataValidationError('Invalid "mobile".', {
                        entity: this.meta.name,
                        field: 'mobile',
                        value: latest['mobile']
                    });
                }
            }
            if (!isNothing(latest['mobile'])) {
                //Processing "mobile"
                latest['mobile'] = normalizeMobile(latest['mobile']);
            }
            return context;
        }
        
        /**
         * validate user credential
         * @param identity
         * @param password
         * @returns {*}
         */
        static async validateUserCredential_(identity, password) {
            //Retrieving the meta data
            const $meta = this.meta.interfaces.validateUserCredential;
            //Sanitize argument "identity"
            identity = Types.TEXT.sanitize(identity, $meta.params[0], this.db.i18n);
            //Sanitize argument "password"
            password = Types.TEXT.sanitize(password, $meta.params[1], this.db.i18n);
            let op$0$condition;
            //Condition 0 for find one user
            const $op$0$cases_0 = Validators.isEmail(identity);
            if ($op$0$cases_0) {
                op$0$condition = { email: identity };
            } else {
                //Condition 1 for find one user
                const $op$0$cases_1 = Validators.matches(identity, new RegExp('^(\\+?\\d{6,})$'));
                if ($op$0$cases_1) {
                    op$0$condition = { mobile: identity };
                } else
                    throw new BusinessError('invalid_identity');
            }
            let user = await this.findOne_(op$0$condition);
            //Return on exception #0
            if (_.isEmpty(user)) {
                throw new BusinessError('user_not_found');
            }
            //Processing "password2"
            let password2 = hashPassword(password, user['passwordSalt']);
            //Return on exception #1
            if (password2 !== user['password']) {
                throw new BusinessError('invalid_password');
            }
            return user;
        }
    };

    UserSpec.db = db;
    UserSpec.meta = {
        "schemaName": "test",
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
                    "name": "now"
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
            "profiles": {
                "entity": "profile",
                "key": "id",
                "on": {
                    "id": {
                        "oorType": "ColumnReference",
                        "name": "profiles.owner"
                    }
                },
                "field": "owner",
                "list": true
            },
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
            }
        },
        "fieldDependencies": {
            "id": [
                "id"
            ],
            "createdAt": [
                "createdAt"
            ],
            "statusInactiveTimestamp": [
                "statusInactiveTimestamp"
            ],
            "statusActiveTimestamp": [
                "statusActiveTimestamp"
            ],
            "statusDisabledTimestamp": [
                "statusDisabledTimestamp"
            ],
            "statusForbiddenTimestamp": [
                "statusForbiddenTimestamp"
            ],
            "statusDeletedTimestamp": [
                "statusDeletedTimestamp"
            ],
            "mobile": [
                "latest.locale"
            ],
            "password": [
                "latest.passwordSalt"
            ]
        },
        "interfaces": {
            "validateUserCredential": {
                "params": [
                    {
                        "name": "identity",
                        "type": "text",
                        "maxLength": [
                            200
                        ]
                    },
                    {
                        "type": "text",
                        "maxLength": [
                            200
                        ],
                        "name": "password",
                        "subClass": [
                            "password"
                        ]
                    }
                ]
            }
        }
    };

    return Object.assign(UserSpec, {
        $normalizeMobile: normalizeMobile,
        $hashPassword: hashPassword
    });
};