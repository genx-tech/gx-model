"use strict";

require("source-map-support/register");

const Util = require('rk-utils');

const _ = Util._;
const FEATURE_NAME = 'logicalDeletion';

function feature(entity, args = []) {
  let newField = true,
      fieldInfo = {
    name: 'isDeleted',
    type: 'boolean',
    'default': false,
    readOnly: true
  },
      fieldName,
      featureSetting;
  let [options] = args;

  if (options) {
    if (_.isPlainObject(options)) {
      newField = false;
      let keys = Object.keys(options);

      if (keys.length !== 1) {
        throw new Error(`Invalid options for feature "${FEATURE_NAME}".`);
      }

      let fieldName = keys[0];
      featureSetting = {
        field: fieldName,
        value: options[fieldName]
      };
    } else if (typeof options === 'string') {
      Object.assign(fieldInfo, {
        name: options
      });
    } else {
      throw new Error(`Invalid options for feature "${FEATURE_NAME}".`);
    }
  }

  if (newField) {
    fieldName = fieldInfo.name;
    let timestampFieldName = 'deletedAt';
    let deletedTimestamp = {
      type: 'datetime',
      readOnly: true,
      optional: true,
      writeOnce: true,
      auto: true
    };
    entity.addFeature(FEATURE_NAME, {
      field: fieldName,
      value: true,
      timestampField: timestampFieldName
    });
    entity.once('afterAddingFields', () => {
      entity.addField(fieldName, fieldInfo);
      entity.addField(timestampFieldName, deletedTimestamp);
    });
  } else {
    entity.addFeature(FEATURE_NAME, featureSetting);
    entity.once('afterAddingFields', () => {
      if (!entity.hasField(featureSetting.field)) {
        throw new Error(`Field "${featureSetting.field}" used by feature "${FEATURE_NAME}" is not found in entity "${entity.name}".`);
      }
    });
  }
}

module.exports = feature;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9sYW5nL2VudGl0eUZlYXR1cmVzL2xvZ2ljYWxEZWxldGlvbi5qcyJdLCJuYW1lcyI6WyJVdGlsIiwicmVxdWlyZSIsIl8iLCJGRUFUVVJFX05BTUUiLCJmZWF0dXJlIiwiZW50aXR5IiwiYXJncyIsIm5ld0ZpZWxkIiwiZmllbGRJbmZvIiwibmFtZSIsInR5cGUiLCJyZWFkT25seSIsImZpZWxkTmFtZSIsImZlYXR1cmVTZXR0aW5nIiwib3B0aW9ucyIsImlzUGxhaW5PYmplY3QiLCJrZXlzIiwiT2JqZWN0IiwibGVuZ3RoIiwiRXJyb3IiLCJmaWVsZCIsInZhbHVlIiwiYXNzaWduIiwidGltZXN0YW1wRmllbGROYW1lIiwiZGVsZXRlZFRpbWVzdGFtcCIsIm9wdGlvbmFsIiwid3JpdGVPbmNlIiwiYXV0byIsImFkZEZlYXR1cmUiLCJ0aW1lc3RhbXBGaWVsZCIsIm9uY2UiLCJhZGRGaWVsZCIsImhhc0ZpZWxkIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU1DLENBQUMsR0FBR0YsSUFBSSxDQUFDRSxDQUFmO0FBRUEsTUFBTUMsWUFBWSxHQUFHLGlCQUFyQjs7QUFZQSxTQUFTQyxPQUFULENBQWlCQyxNQUFqQixFQUF5QkMsSUFBSSxHQUFHLEVBQWhDLEVBQW9DO0FBQ2hDLE1BQUlDLFFBQVEsR0FBRyxJQUFmO0FBQUEsTUFBcUJDLFNBQVMsR0FBRztBQUM3QkMsSUFBQUEsSUFBSSxFQUFFLFdBRHVCO0FBRTdCQyxJQUFBQSxJQUFJLEVBQUUsU0FGdUI7QUFHN0IsZUFBVyxLQUhrQjtBQUk3QkMsSUFBQUEsUUFBUSxFQUFFO0FBSm1CLEdBQWpDO0FBQUEsTUFLR0MsU0FMSDtBQUFBLE1BS2NDLGNBTGQ7QUFPQSxNQUFJLENBQUVDLE9BQUYsSUFBY1IsSUFBbEI7O0FBRUEsTUFBSVEsT0FBSixFQUFhO0FBQ1QsUUFBSVosQ0FBQyxDQUFDYSxhQUFGLENBQWdCRCxPQUFoQixDQUFKLEVBQThCO0FBQzFCUCxNQUFBQSxRQUFRLEdBQUcsS0FBWDtBQUVBLFVBQUlTLElBQUksR0FBR0MsTUFBTSxDQUFDRCxJQUFQLENBQVlGLE9BQVosQ0FBWDs7QUFDQSxVQUFJRSxJQUFJLENBQUNFLE1BQUwsS0FBZ0IsQ0FBcEIsRUFBdUI7QUFDbkIsY0FBTSxJQUFJQyxLQUFKLENBQVcsZ0NBQStCaEIsWUFBYSxJQUF2RCxDQUFOO0FBQ0g7O0FBRUQsVUFBSVMsU0FBUyxHQUFHSSxJQUFJLENBQUMsQ0FBRCxDQUFwQjtBQUVBSCxNQUFBQSxjQUFjLEdBQUc7QUFDYk8sUUFBQUEsS0FBSyxFQUFFUixTQURNO0FBRWJTLFFBQUFBLEtBQUssRUFBRVAsT0FBTyxDQUFDRixTQUFEO0FBRkQsT0FBakI7QUFLSCxLQWZELE1BZU8sSUFBSSxPQUFPRSxPQUFQLEtBQW1CLFFBQXZCLEVBQWlDO0FBQ3BDRyxNQUFBQSxNQUFNLENBQUNLLE1BQVAsQ0FBY2QsU0FBZCxFQUF5QjtBQUFFQyxRQUFBQSxJQUFJLEVBQUVLO0FBQVIsT0FBekI7QUFDSCxLQUZNLE1BRUE7QUFDSCxZQUFNLElBQUlLLEtBQUosQ0FBVyxnQ0FBK0JoQixZQUFhLElBQXZELENBQU47QUFDSDtBQUNKOztBQUVELE1BQUlJLFFBQUosRUFBYztBQUNWSyxJQUFBQSxTQUFTLEdBQUdKLFNBQVMsQ0FBQ0MsSUFBdEI7QUFFQSxRQUFJYyxrQkFBa0IsR0FBRyxXQUF6QjtBQUNBLFFBQUlDLGdCQUFnQixHQUFHO0FBQ25CZCxNQUFBQSxJQUFJLEVBQUUsVUFEYTtBQUVuQkMsTUFBQUEsUUFBUSxFQUFFLElBRlM7QUFHbkJjLE1BQUFBLFFBQVEsRUFBRSxJQUhTO0FBSW5CQyxNQUFBQSxTQUFTLEVBQUUsSUFKUTtBQUtuQkMsTUFBQUEsSUFBSSxFQUFFO0FBTGEsS0FBdkI7QUFRQXRCLElBQUFBLE1BQU0sQ0FBQ3VCLFVBQVAsQ0FBa0J6QixZQUFsQixFQUFnQztBQUM1QmlCLE1BQUFBLEtBQUssRUFBRVIsU0FEcUI7QUFFNUJTLE1BQUFBLEtBQUssRUFBRSxJQUZxQjtBQUc1QlEsTUFBQUEsY0FBYyxFQUFFTjtBQUhZLEtBQWhDO0FBTUFsQixJQUFBQSxNQUFNLENBQUN5QixJQUFQLENBQVksbUJBQVosRUFBaUMsTUFBTTtBQUNuQ3pCLE1BQUFBLE1BQU0sQ0FBQzBCLFFBQVAsQ0FBZ0JuQixTQUFoQixFQUEyQkosU0FBM0I7QUFDQUgsTUFBQUEsTUFBTSxDQUFDMEIsUUFBUCxDQUFnQlIsa0JBQWhCLEVBQW9DQyxnQkFBcEM7QUFDSCxLQUhEO0FBSUgsR0F0QkQsTUFzQk87QUFDSG5CLElBQUFBLE1BQU0sQ0FBQ3VCLFVBQVAsQ0FBa0J6QixZQUFsQixFQUFnQ1UsY0FBaEM7QUFFQVIsSUFBQUEsTUFBTSxDQUFDeUIsSUFBUCxDQUFZLG1CQUFaLEVBQWlDLE1BQU07QUFDbkMsVUFBSSxDQUFDekIsTUFBTSxDQUFDMkIsUUFBUCxDQUFnQm5CLGNBQWMsQ0FBQ08sS0FBL0IsQ0FBTCxFQUE0QztBQUN4QyxjQUFNLElBQUlELEtBQUosQ0FBVyxVQUFTTixjQUFjLENBQUNPLEtBQU0sc0JBQXFCakIsWUFBYSw2QkFBNEJFLE1BQU0sQ0FBQ0ksSUFBSyxJQUFuSCxDQUFOO0FBQ0g7QUFDSixLQUpEO0FBS0g7QUFDSjs7QUFFRHdCLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjlCLE9BQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgXyA9IFV0aWwuXztcblxuY29uc3QgRkVBVFVSRV9OQU1FID0gJ2xvZ2ljYWxEZWxldGlvbic7XG5cbi8qKlxuICogQSBydWxlIHNwZWNpZmllcyB0aGUgZW50aXR5IHdpbGwgbm90IGJlIGRlbGV0ZWQgcGh5c2ljYWxseS5cbiAqIEBtb2R1bGUgRW50aXR5RmVhdHVyZV9Mb2dpY2FsRGVsZXRpb25cbiAqL1xuXG4vKipcbiAqIEluaXRpYWxpemUgdGhlIGZlYXR1cmVcbiAqIEBwYXJhbSB7T29sb25nRW50aXR5fSBlbnRpdHkgLSBFbnRpdHkgdG8gYXBwbHkgdGhpcyBmZWF0dXJlXG4gKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIEZpZWxkIG9wdGlvbnMsIGNhbiBiZSBhIHN0cmluZyBhcyBhIG5ldyBzdGF0dXMgZmllbGQgb3IgYW4gb2JqZWN0IHJlZmVyZW5jZSB0byBhIGNlcnRhaW4gc3RhdHVzIG9mIGFuIGV4aXN0aW5nIGZpZWxkXG4gKi9cbmZ1bmN0aW9uIGZlYXR1cmUoZW50aXR5LCBhcmdzID0gW10pIHtcbiAgICBsZXQgbmV3RmllbGQgPSB0cnVlLCBmaWVsZEluZm8gPSB7XG4gICAgICAgIG5hbWU6ICdpc0RlbGV0ZWQnLFxuICAgICAgICB0eXBlOiAnYm9vbGVhbicsXG4gICAgICAgICdkZWZhdWx0JzogZmFsc2UsXG4gICAgICAgIHJlYWRPbmx5OiB0cnVlXG4gICAgfSwgZmllbGROYW1lLCBmZWF0dXJlU2V0dGluZztcblxuICAgIGxldCBbIG9wdGlvbnMgXSA9IGFyZ3M7XG5cbiAgICBpZiAob3B0aW9ucykge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBuZXdGaWVsZCA9IGZhbHNlO1xuXG4gICAgICAgICAgICBsZXQga2V5cyA9IE9iamVjdC5rZXlzKG9wdGlvbnMpO1xuICAgICAgICAgICAgaWYgKGtleXMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIG9wdGlvbnMgZm9yIGZlYXR1cmUgXCIke0ZFQVRVUkVfTkFNRX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGZpZWxkTmFtZSA9IGtleXNbMF07XG5cbiAgICAgICAgICAgIGZlYXR1cmVTZXR0aW5nID0ge1xuICAgICAgICAgICAgICAgIGZpZWxkOiBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgdmFsdWU6IG9wdGlvbnNbZmllbGROYW1lXVxuICAgICAgICAgICAgfTtcblxuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihmaWVsZEluZm8sIHsgbmFtZTogb3B0aW9ucyB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBvcHRpb25zIGZvciBmZWF0dXJlIFwiJHtGRUFUVVJFX05BTUV9XCIuYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobmV3RmllbGQpIHtcbiAgICAgICAgZmllbGROYW1lID0gZmllbGRJbmZvLm5hbWU7XG5cbiAgICAgICAgbGV0IHRpbWVzdGFtcEZpZWxkTmFtZSA9ICdkZWxldGVkQXQnO1xuICAgICAgICBsZXQgZGVsZXRlZFRpbWVzdGFtcCA9IHtcbiAgICAgICAgICAgIHR5cGU6ICdkYXRldGltZScsXG4gICAgICAgICAgICByZWFkT25seTogdHJ1ZSxcbiAgICAgICAgICAgIG9wdGlvbmFsOiB0cnVlLFxuICAgICAgICAgICAgd3JpdGVPbmNlOiB0cnVlLFxuICAgICAgICAgICAgYXV0bzogdHJ1ZVxuICAgICAgICB9O1xuXG4gICAgICAgIGVudGl0eS5hZGRGZWF0dXJlKEZFQVRVUkVfTkFNRSwge1xuICAgICAgICAgICAgZmllbGQ6IGZpZWxkTmFtZSxcbiAgICAgICAgICAgIHZhbHVlOiB0cnVlLFxuICAgICAgICAgICAgdGltZXN0YW1wRmllbGQ6IHRpbWVzdGFtcEZpZWxkTmFtZVxuICAgICAgICB9KTtcblxuICAgICAgICBlbnRpdHkub25jZSgnYWZ0ZXJBZGRpbmdGaWVsZHMnLCAoKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkRmllbGQoZmllbGROYW1lLCBmaWVsZEluZm8pO1xuICAgICAgICAgICAgZW50aXR5LmFkZEZpZWxkKHRpbWVzdGFtcEZpZWxkTmFtZSwgZGVsZXRlZFRpbWVzdGFtcCk7XG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGVudGl0eS5hZGRGZWF0dXJlKEZFQVRVUkVfTkFNRSwgZmVhdHVyZVNldHRpbmcpO1xuXG4gICAgICAgIGVudGl0eS5vbmNlKCdhZnRlckFkZGluZ0ZpZWxkcycsICgpID0+IHtcbiAgICAgICAgICAgIGlmICghZW50aXR5Lmhhc0ZpZWxkKGZlYXR1cmVTZXR0aW5nLmZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmllbGQgXCIke2ZlYXR1cmVTZXR0aW5nLmZpZWxkfVwiIHVzZWQgYnkgZmVhdHVyZSBcIiR7RkVBVFVSRV9OQU1FfVwiIGlzIG5vdCBmb3VuZCBpbiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZmVhdHVyZTsiXX0=