"use strict";

require("source-map-support/register");

const FEATURE_NAME = 'userEditTracking';

function feature(entity, args) {
  const options = {
    userEntity: 'user.id',
    uidSource: 'state.user.id',
    trackCreate: 'createdBy',
    trackUpdate: 'updatedBy',
    revisionField: 'revision',
    addFieldsOnly: false,
    ...args[0]
  };
  const {
    userField: userFieldRef,
    uidSource,
    trackCreate,
    trackUpdate,
    revisionField,
    addFieldsOnly,
    migrationUser
  } = options;

  if (!trackCreate && !trackUpdate) {
    entity.linker.log('warn', 'Since both "trackCreate" and "trackUpdate" are disabled, the "userEditTracking" feature will not take any effect.');
    return;
  }

  const [userEntityName, userIdField] = userFieldRef.split('.');
  const userEntity = entity.getReferencedEntity(userEntityName);
  const uidField = userIdField == null ? userEntity.getEntityAttribute('$key') : userEntity.getEntityAttribute(userIdField);
  const fields = {};

  if (trackCreate) {
    fields['createdBy'] = trackCreate;
    entity.info.associations || (entity.info.associations = []);
    entity.info.associations.push({
      type: 'refersTo',
      destEntity: userEntityName,
      srcField: trackCreate,
      fieldProps: {
        readOnly: true,
        writeOnce: true
      }
    });
  }

  if (trackUpdate) {
    entity.once('afterAddingFields', () => {
      entity.addField(revisionField, {
        type: 'integer',
        default: 0
      });
    });
    fields['updatedBy'] = trackUpdate;
    fields['revision'] = revisionField;
    entity.info.associations || (entity.info.associations = []);
    entity.info.associations.push({
      type: 'refersTo',
      destEntity: userEntityName,
      srcField: trackUpdate,
      fieldProps: {
        readOnly: true,
        optional: true
      }
    });
  }

  if (!addFieldsOnly) {
    entity.addFeature(FEATURE_NAME, {
      fields,
      uidSource,
      migrationUser
    });
  }
}

module.exports = feature;
//# sourceMappingURL=userEditTracking.js.map