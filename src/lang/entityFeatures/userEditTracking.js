"use strict";

const FEATURE_NAME = 'userEditTracking';

/**
 * A rule specifies the entity to automatically record the creation time
 * @module EntityFeature_UserEditTracking
 */

/**
 * Initialize the feature
 * @param {OolongEntity} entity - Entity to apply this feature
 * @param {array} options - Field options
 */
function feature(entity, args) {
    const options = {
        userEntity: 'user.id',
        uidSource: 'state.user.id',
        trackCreate: 'createdBy',
        trackUpdate: 'updatedBy',
        addFieldsOnly: false,
        ...args[0]
    };

    const {
        userField: userFieldRef,
        uidSource,
        trackCreate,
        trackUpdate,
        addFieldsOnly
    } = options;    

    if (!trackCreate && !trackUpdate) {
        entity.linker.log('warn', 'Since both "trackCreate" and "trackUpdate" are disabled, the "userEditTracking" feature will not take any effect.');
        return;
    }

    //todo: cross scheam support
    const [ userEntityName, userIdField ] = userFieldRef.split('.');

    const userEntity = entity.getReferencedEntity(userEntityName);
    const uidField = userIdField == null ? userEntity.getEntityAttribute('$key') : userEntity.getEntityAttribute(userIdField);

    const fields = {};

    if (trackCreate) {
        const typeInfo = {
            name: trackCreate,
            type: uidField.type,
            readOnly: true,
            writeOnce: true
        };

        entity.on('afterAddingFields', () => {
            entity.addField(typeInfo.name, typeInfo);
        });

        fields['createdBy'] = trackCreate;
    }

    if (trackUpdate) {
        const typeInfo = {
            name: trackUpdate,
            type: uidField.type,
            readOnly: true
        };

        entity.on('afterAddingFields', () => {
            entity.addField(typeInfo.name, typeInfo);
        });

        fields['updatedBy'] = trackUpdate;
    }

    if (!addFieldsOnly) {
        entity.addFeature(FEATURE_NAME, {
            fields,
            uidSource
        });    
    }
}

module.exports = feature;