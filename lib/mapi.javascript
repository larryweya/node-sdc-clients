// Copyright 2011 Joyent, Inc.  All rights reserved.

var assert = require('assert');
var querystring = require('querystring');
var util = require('util');

var restify = require('restify');

var cache = require('./cache');



// --- Globals

var sprintf = util.format;
var ResourceNotFoundError = restify.ResourceNotFoundError;



// --- Helpers

if (!String.prototype.capitalize) {
  String.prototype.capitalize = function capitalize() {
    return this.charAt(0).toUpperCase() + this.slice(1);
  };
}


function assertArg(name, type, arg) {
  if (typeof (arg) !== type)
    throw new TypeError(name + ' (' + type.capitalize() + ') required');
}


function translateError(err, res) {
  assert.ok(err);

  var obj;
  if (err instanceof restify.HttpError) {
    if (err.body) {
      try {
        obj = JSON.parse(err.body);
      } catch (e) {
        // MAPI returns HTML sometimes; just ignore errors here.
      }
    }

    if (obj && !obj.messages)
      obj.messages = obj.errors || ['An unknown error occurred'];
  }

  if (!obj)
    obj = {};

  switch ((obj.code || res && res.headers['x-joyent-error-code'])) {
  case 'DuplicateAliasError':
    return new restify.InvalidArgumentError('name is already in use');

  case 'InvalidHostnameError':
    return new restify.InvalidArgumentError('name syntax is invalid');

  case 'NotFoundError':
    return new restify.ResourceNotFoundError(obj.messages[0]);

  case 'NoAvailableServersError':
  case 'NoAvailableServersWithDatasetError':
    return new restify.RestError(503,
                                 'InsufficientCapacity',
                                 obj.messages[0]);

  case 'SetupError':
    return new restify.RestError(503,
                                 'InternalError',
                                 'System is unavailable for provisioning');

  case 'TransitionConflictError':
  case 'TransitionToCurrentStatusError':
  case 'UnacceptableTransitionError':
    return new restify.RestError(409,
                                 'InvalidState',
                                 obj.messages[0]);

  case 'InsufficientRamForDatasetError':
  case 'InvalidParamError':
  case 'UnknownDatasetError':
  case 'UnknownPackageError':
  case 'TooMuchRamForDatasetError':
    return new restify.InvalidArgumentError(obj.messages[0]);

  default:
    break;

  }
  // If we're here, the error was something else.
  if (err.statusCode === 400)
    return new restify.InvalidArgumentError('Bad request');

  // XXX This should be logged on a given logger.
  console.error('sdc-clients/mapi.js: Unknown MAPI error:', err, res);
  return new restify.InternalError('An unknown error occurred');
}


function commonCallback(callback) {
  assert.equal(typeof (callback), 'function');

  return function _callback(err, req, res, data) {
    if (err)
      return callback(translateError(err, res));

    var obj = null;
    try {
      if (data)
        obj = JSON.parse(data);
    } catch (e) {
      return callback(e);
    }

    return callback(null, obj, res);
  };
}


/**
 * Marshal `options` to MAPI APIs in this module to `headers` and a
 * request `path` for calling MAPI.
 */
function request(path, customer, options) {
  // Make a copy of `options` so we don't modify the caller.
  var opts = {};
  var i;
  if (options) {
    var keys = Object.keys(options);
    for (i = 0; i < keys.length; i++) {
      opts[keys[i]] = options[keys[i]];
    }
  }

  var req = {
    path: path,
    headers: opts.headers || {}
  };
  delete opts.headers;

  if (customer) {
    opts.owner_uuid = customer; // set up the query param
    req.headers.User = customer;
  }

  if (opts.requestId) {
    req.headers['x-request-id'] = opts.requestId;
    delete opts.requestId;
  }
  if (opts.tags) {
    // {name1: value1, name2: value2} -> ?tag.name1=value1&tag.name2=value2
    var names = Object.keys(opts.tags);
    for (i = 0; i < names.length; i++) {
      opts['tag.' + names[i]] = opts.tags[names[i]];
    }
    delete opts.tags;
  }

  if (Object.keys(opts).length > 0) {
    req.path += '?' + querystring.stringify(opts);
  }

  return req;
}


// -- Exported MAPI Client

/**
 * Constructor
 *
 * Note that in options you can pass in any parameters that the restify
 * RestClient constructor takes (for example retry/backoff settings).
 *
 * @param {Object} options parameters of the usual form:
 *                  - username {String} admin name to MAPI.
 *                  - password {String} password to said admin.
 *                  - url {String} MAPI location.
 */
function MAPI(options) {
  assertArg('options', 'object', options);
  assertArg('options.username', 'string', options.username);
  assertArg('options.password', 'string', options.password);
  assertArg('options.url', 'string', options.url);

  if (!options.headers)
    options.headers = {};
  options.headers['X-Joyent-Full-Error-Messages'] = 'true';
  options.headers['X-Joyent-Ignore-Provisioning-State'] = 'true';

  options.accept = 'application/json';

  this.client = restify.createStringClient(options);
  this.client.basicAuth(options.username, options.password);

  // In-memory caches
  if (options.cache !== false)
    this.cache = cache.createCache(options.cache);
}
module.exports = MAPI;


/**
 * Lists all the networks available in MAPI.
 *
 * Note that MAPI currently only has a /networks
 *
 * @param {Object} opts optional things, like requestId
 * @param {Function} callback of the form f(err, datasets).
 */
MAPI.prototype.listNetworks = function listNetworks(opts, callback) {
  return this._list('/networks', true, null, opts, callback);
};


/**
 * Lists all the datasets available in MAPI for the given tenant.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {Object} opts optional things, like requestId
 * @param {Function} callback of the form f(err, datasets).
 */
MAPI.prototype.listDatasets = function listDatasets(customer, opts, callback) {
  return this._list('/datasets', true, customer, opts, callback);
};


/**
 * Returns a dataset by uuid.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {String} dataset the dataset uuid.
 * @param {Object} opts optional things, like requestId
 * @param {Function} callback of the form f(err, dataset).
 */
MAPI.prototype.getDataset = function getDataset(customer,
                                                dataset,
                                                opts,
                                                callback) {
  var path = sprintf('/datasets/%s', dataset);
  return this._get(path, true, customer, opts, callback);
};


/**
 * Lists packages available to a tenant.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {Object} opts optional things, like requestId
 * @param {Function} callback of the form f(err, packages).
 */
MAPI.prototype.listPackages = function listPackage(customer, opts, callback) {
  return this._list('/packages', true, customer, opts, callback);
};


/**
 * Gets a package by name for a tenant.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {String} name of the package.
 * @param {Object} opts optional things, like requestId
 * @param {Function} callback of the form f(err, pkg).
 */
MAPI.prototype.getPackage = function getPackage(customer,
                                                name,
                                                opts,
                                                callback) {
  if (typeof (name) === 'function') {
    opts = {};
    callback = name;
    name = customer;
    customer = '';
  } else if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  if (!opts.headers)
    opts.headers = {};
  opts.headers['X-Joyent-Find-With'] = 'name';

  var path = sprintf('/packages/%s', name);
  return this._get(path, true, customer, opts, callback);
};
MAPI.prototype.getPackageByName = MAPI.prototype.getPackage; // old name


/**
 * Lists all machines available to the tenant.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {Object} opts optional things, like requestId
 * @param {Function} callback of the form f(err, pkg).
 */
MAPI.prototype.listMachines = function listMachines(customer, opts, callback) {
  if (typeof (customer) === 'function') {
    callback = customer;
    opts = {};
    customer = '';
  } else if (typeof (opts) == 'function') {
    callback = opts;
    opts = {};
  }

  return this._list('/machines', false, customer, opts, function (err, ms) {
    if (err)
      return callback(err);

    // Apply filters until PROV-1396 is in
    var _machines = [];
    var now = new Date();

    ms.forEach(function (m) {
      if (opts.type && opts.type !== m.type)
        return;
      if (opts.alias && opts.alias !== m.alias)
        return;
      if (opts.name && opts.name !== m.name)
        return;
      if (opts['package'] &&
          opts['package'] !== m.internal_metadata.package_name)
        return;
      if (opts.id && opts.id !== m.name)
        return;
      if (opts.dataset &&
          (opts.dataset !== m.dataset_uuid &&
           opts.dataset !== m.dataset_urn &&
           opts.dataset !== m.dataset_name))
        return;
      if (opts.tags) {
        var tags = Object.keys(opts.tags);
        for (var i = 0; i < tags.length; i++) {
          if (opts.tags[tags[i]] !== m.tags[tags[i]])
            return;
        }
      }
      if (m.destroyed_at) {
        if (opts.tombstone) {
          var allow = Number(opts.tombstone);
          var destroyed = new Date(m.destroyed_at);
          var delta = now.valueOf() - destroyed.valueOf();
          if (delta/1000 > allow)
            return;
        } else {
          return;
        }
      }

      _machines.push(m);
    });

    return callback(null, _machines);
  });
};


/**
 * Retrives a machine by name (uuid).
 *
 * Note this call will return the zone regardless of what state it is in,
 * including if it's destroyed, so check the state.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {String} name the machine name (uuid).
 * @param {Function} callback of the form f(err, zone).
 */
MAPI.prototype.getMachine = function getMachine(customer,
                                                name,
                                                opts,
                                                callback) {
  var path = sprintf('/machines/%s', name);
  return this._get(path, false, customer, opts, callback);
};


/**
 * Provisions a new zone in MAPI.
 *
 * Options, while MAPI docs are authoritative, generally contain:
 *  - dataset: the dataset uuid.
 *  - package: the package to provision with.
 *  - alias: the name you want on the machine.
 *  - hostname: the hostname to assign.
 *
 * Note this API, after creating, will turn around and retrieve the zone
 * for you, so transitions are unnecessary.
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {Object} options the creation options (see MAPI docs).
 * @param {Object} tags (optional) tags to assign the new machine.
 * @param {Function} callback of the form f(err, zone).
 */
MAPI.prototype.createMachine = function createMachine(customer,
                                                      opts,
                                                      tags,
                                                      callback) {
  if (typeof (customer) === 'object') {
    callback = tags;
    tags = opts;
    opts = customer;
    customer = '';
  }
  if (typeof (tags) === 'function') {
    callback = tags;
    tags = {};
  }
  assertArg('options', 'object', opts);
  assertArg('tags', 'object', tags);

  Object.keys(tags).forEach(function (t) {
    opts['tag.' + t] = tags[t];
  });

  var self = this;
  return this._post('/machines', opts, customer, opts, function (err, _, hdrs) {
    if (err)
      return callback(err);

    var transition = hdrs['x-joyent-transition-uri'];
    if (!transition) {
      console.error('MAPI.createZone: No Transition returned from MAPI');
      return callback(new restify.InternalError());
    }

    var id = transition.substr(transition.lastIndexOf('/') + 1);
    return self.getMachine(customer, id, callback);
  });
};


/**
 * Deletes a machine
 *
 * @param {String} customer capi uuid.
 * @param {String} name machine uuid.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.deleteMachine = function deleteMachine(customer,
                                                      name,
                                                      opts,
                                                      callback) {
  if (typeof (name) !== 'string') {
    callback = opts;
    opts = name;
    name = customer;
    customer = '';
  }
  return this._del('/machines/' + name, customer, opts, callback);
};
MAPI.prototype.rmMachine = MAPI.prototype.deleteMachine;


/**
 * Overwrites the meta data for a given machine id
 *
 * @param {String} customer uuid.
 * @param {String} name machine uuid.
 * @param {Object} meta key/value pairs of metadata to replace.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, headers).
 */
MAPI.prototype.putMachineMetadata = function putMachineMetadata(customer,
                                                                name,
                                                                meta,
                                                                opts,
                                                                callback) {

  if (typeof (name) === 'object') {
    meta = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('name', 'string', name);
  assertArg('meta', 'object', meta);
  assertArg('opts', 'object', opts);


  var md = {
    customer_metadata: {}
  };
  Object.keys(meta).forEach(function (k) {
    md.customer_metadata[k] = meta[k];
  });

  md.customer_metadata = JSON.stringify(md.customer_metadata);

  return this._put('/machines/' + name, md, customer, opts, callback);
};


/**
 * Lists tags on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.listMachineTags = function listMachineTags(customer,
                                                          name,
                                                          opts,
                                                          callback) {
  if (typeof (name) === 'function') {
    callback = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (name) === 'object') {
    callback = opts;
    opts = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('name', 'string', name);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  // Until PROV-1397 exists
  return this.listMachines(customer, opts, function (err, machines) {
    if (err)
      return callback(err);

    var m = false;
    for (var i = 0; i < machines.length; i++) {
      if (machines[i].name === name) {
        m = machines[i];
        break;
      }
    }

    if (!m)
      return callback(new restify.ResourceNotFoundError(name + ' not found'));

    return callback(null, m.tags);
  });
};


/**
 * Add tags to a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine name.
 * @param {Object} tags object (name: value).
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.addMachineTags = function addMachineTags(customer,
                                                        name,
                                                        tags,
                                                        opts,
                                                        callback) {

  if (typeof (tags) === 'function') {
    callback = tags;
    tags = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (name) === 'object') {
    callback = opts;
    opts = tags;
    tags = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('tags', 'object', tags);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var _tags = {};
  Object.keys(tags).forEach(function (t) {
    _tags['tag.' + t] = tags[t];
  });

  var path = sprintf('/machines/%s/tags', name);
  this._post(path, _tags, customer, opts, callback);
};


/**
 * Gets a tag on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {String} tag the tag name.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.getMachineTag = function getMachineTag(customer,
                                                      name,
                                                      tag,
                                                      opts,
                                                      callback) {
  if (typeof (tag) === 'function') {
    callback = tag;
    tag = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (tag) === 'object') {
    callback = opts;
    opts = tag;
    tag = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('tag', 'string', tag);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  this.listMachineTags(customer, name, opts, function (err, tags) {
    if (err)
      return callback(err);

    if (!tags[tag])
      return callback(new ResourceNotFoundError(tag + ' not found'));

    return callback(null, tags[tag]);
  });
};


/**
 * Deletes a single tag on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {String} tag the tag name.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.deleteMachineTag = function deleteMachineTag(customer,
                                                            name,
                                                            tag,
                                                            opts,
                                                            callback) {
  if (typeof (tag) === 'function') {
    callback = tag;
    tag = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (tag) === 'object') {
    callback = opts;
    opts = tag;
    tag = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('tag', 'string', tag);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/tags/%s', name, tag);
  this._del(path, customer, opts, callback);
};


/**
 * Deletes all tags on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.deleteMachineTags = function deleteMachineTags(customer,
                                                              name,
                                                              opts,
                                                              callback) {
  if (typeof (name) === 'function') {
    callback = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (name) === 'object') {
    callback = opts;
    opts = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/tags', name);
  this._del(path, customer, opts, callback);
};


MAPI.prototype._updateMachine = function _updateMachine(action,
                                                        customer,
                                                        name,
                                                        opts,
                                                        callback) {

  assert.equal(typeof (action), 'string');
  if (typeof (name) === 'function') {
    callback = name;
    name = customer;
    customer = '';
    opts = {};
  }
  if (typeof (name) === 'object') {
    callback = opts;
    opts = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/%s', name, action);
  return this._post(path, {}, customer, opts, callback);
};

/**
 * Shutdown a machine
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {String} name the machine uuid.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.shutdownMachine = function shutdownMachine(customer,
                                                          name,
                                                          opts,
                                                          callback) {
  return this._updateMachine('shutdown', customer, name, opts, callback);
};


/**
 * Startup a machine
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {String} name the machine uuid.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.startMachine = function startMachine(customer,
                                                    name,
                                                    opts,
                                                    callback) {
  return this._updateMachine('start', customer, name, opts, callback);
};


/**
 * Reboots a machine
 *
 * @param {String} customer the CAPI customer uuid.
 * @param {String} name the machine uuid.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.rebootMachine = function rebootMachine(customer,
                                                      name,
                                                      opts,
                                                      callback) {
  return this._updateMachine('reboot', customer, name, opts, callback);
};




/**
 * Resizes a zone by package.
 *
 * @param {String} customer capi uuid.
 * @param {String} name machine (zone only) uuid.
 * @param {String} pkg package name.
 * @param {String} options object the usual.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.resizeZone = function resizeZone(customer,
                                                name,
                                                pkg,
                                                opts,
                                                callback) {
  if (typeof (pkg) === 'function') {
    callback = pkg;
    pkg = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (pkg) === 'object') {
    callback = opts;
    opts = pkg;
    pkg = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('package', 'string', pkg);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/resize', name);
  return this._post(path, { 'package': pkg }, customer, opts, callback);
};


/**
 * Lists snapshots for a zone.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid (zone only)
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, snapshots).
 */
MAPI.prototype.listZoneSnapshots = function listZoneSnapshots(customer,
                                                              name,
                                                              opts,
                                                              callback) {
  if (typeof (name) === 'function') {
    callback = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (name) === 'object') {
    callback = opts;
    opts = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('name', 'string', name);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/snapshots', name);
  return this._list(path, false, customer, opts, callback);
};


/**
 * Takes a snapshot of a zone.
 *
 * @param {String} customer capi uuid.
 * @param {String} name zone uuid.
 * @param {String} snap snapshot name.
 * @param {String} options object the usual.
 * @param {Function} callback of the form f(err, id).
 */
MAPI.prototype.createZoneSnapshot = function (customer,
                                             name,
                                             snap,
                                             opts,
                                             callback) {
  if (typeof (snap) === 'function') {
    callback = snap;
    snap = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (snap) === 'object') {
    callback = opts;
    opts = snap;
    snap = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('snapshot', 'string', snap);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/snapshots', name);
  var data = {
    snapshot_name: snap
  };

  return this._post(path, data, customer, opts, function (err, _, headers) {
    if (err)
      return callback(err);

    var location = headers.location;
    if (!location) {
      console.error('MAPI.snapshotZone: No Location returned from MAPI');
      return callback(new restify.InternalError());
    }

    return callback(null, location.substr(location.lastIndexOf('/') + 1));
  });
};


/**
 * Gets a snapshot on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {String} snap the snapshot name.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.getZoneSnapshot = function getZoneSnapshot(customer,
                                                          name,
                                                          snap,
                                                          opts,
                                                          callback) {
  if (typeof (snap) === 'function') {
    callback = snap;
    snap = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (snap) === 'object') {
    callback = opts;
    opts = snap;
    snap = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('snapshot', 'string', snap);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/snapshots/%s', name, snap);
  return this._get(path, false, customer, opts, callback);
};


/**
 * Deletes a snapshot on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {String} snap the snapshot name.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.deleteZoneSnapshot = function deleteZoneSnapshot(customer,
                                                                name,
                                                                snap,
                                                                opts,
                                                                callback) {
  if (typeof (snap) === 'function') {
    callback = snap;
    snap = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (snap) === 'object') {
    callback = opts;
    opts = snap;
    snap = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('snapshot', 'string', snap);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/snapshots/%s', name, snap);
  return this._del(path, customer, opts, callback);
};


/**
 * Deletes a snapshot on a machine.
 *
 * @param {String} customer the CAPI uuid.
 * @param {String} name the machine uuid.
 * @param {String} snap the snapshot name.
 * @param {Object} options things like requestId.
 * @param {Function} callback of the form f(err, tags).
 */
MAPI.prototype.bootZoneSnapshot = function bootZoneSnapshot(customer,
                                                            name,
                                                            snap,
                                                            opts,
                                                            callback) {
  if (typeof (snap) === 'function') {
    callback = snap;
    snap = name;
    name = customer;
    customer = '';
    opts = {};
  } else if (typeof (snap) === 'object') {
    callback = opts;
    opts = snap;
    snap = name;
    name = customer;
    customer = '';
  }
  if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('name', 'string', name);
  assertArg('snapshot', 'string', snap);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var path = sprintf('/machines/%s/snapshots/%s/boot', name, snap);
  return this._post(path, { a: 'b' }, customer, opts, callback);
};


/**
 * Gets the boot data to be provided to a CN at boot time.
 *
 * @param {String} MAC address of the CN.
 * @param {String} previously held IP address of the CN (optional).
 * @param {Function} callback of the form f(err, usage).
 */
MAPI.prototype.getBootParams = function getBootParams(mac_address,
                                                      last_ip,
                                                      callback) {
  if (typeof (last_ip) == 'function') {
    callback = last_ip;
    last_ip = '0.0.0.0';
  }

  assertArg('mac_address', 'string', mac_address);
  assertArg('last_ip', 'string', last_ip);
  assertArg('callback', 'function', callback);

  var path = sprintf('/boot/%s', mac_address);
  var options = {};
  if (last_ip != '0.0.0.0') {
    options.ip = last_ip;
  }

  return this._get(path, false, '', options, callback);
};

/**
 * Create a NIC entry
 *
 * @param {String} mac_addr mac address.
 * @param {Object} opts additional optional parameters.
 * @param {Function} callback of the form f(err).
 */
MAPI.prototype.createNic = function createNic(mac_address,
                                              options,
                                              callback) {
  if (typeof (options) == 'function') {
    callback = options;
    options = {};
  }

  assertArg('mac_address', 'string', mac_address);
  assertArg('options', 'object', options);
  assertArg('callback', 'function', callback);

  var path = '/nics';

  options.address = mac_address;

  return this._post(path, options, '', callback);
};


/**
 * List servers
 *
 * @param {Object} opts Optional parameters. Supports: limit, offset.
 * @param {Function} callback of the form `function (err) {}`.
 */
MAPI.prototype.listServers = function (opts, callback) {
  return this._list('/servers', false, '', opts, callback);
};


// --- Private methods

MAPI.prototype._list = function _list(path,
                                      useCache,
                                      customer,
                                      opts,
                                      callback) {
  assert.equal(typeof (path), 'string');
  assert.equal(typeof (useCache), 'boolean');

  if (typeof (customer) === 'function') {
    callback = customer;
    customer = '';
    opts = {};
  } else if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var req = request(path, customer, opts);

  if (useCache && this._cacheGet(req.path))
    return callback(null, this._cacheGet(req.path));

  var self = this;
  return this.client.get(req, commonCallback(function (err, objects) {
    if (err)
      return callback(err);

    if (useCache)
      self._cachePut(req.path, objects || []);

    return callback(null, objects || []);
  }));
};


MAPI.prototype._get = function _get(path,
                                    useCache,
                                    customer,
                                    opts,
                                    callback) {

  assert.equal(typeof (path), 'string');
  assert.equal(typeof (useCache), 'boolean');

  if (typeof (customer) === 'function') {
    callback = customer;
    customer = '';
    opts = {};
  } else if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var req = request(path, customer, opts);

  if (useCache && this._cacheGet(req.path))
    return callback(null, this._cacheGet(req.path));

  var self = this;
  return this.client.get(req, commonCallback(function (err, object) {
    if (err)
      return callback(err);

    if (!object) {
      return callback(new ResourceNotFoundError(path.split('/').pop() +
                                                ' not found'));
    }

    if (useCache)
      self._cachePut(req.path, object || {});
    return callback(null, object || {});
  }));
};


MAPI.prototype._post = function _post(path,
                                      data,
                                      customer,
                                      opts,
                                      callback) {

  assert.equal(typeof (path), 'string');
  assert.equal(typeof (data), 'object');

  if (typeof (customer) === 'function') {
    callback = customer;
    customer = '';
    opts = {};
  } else if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var req = request(path, customer, opts);

  return this.client.post(req, data,
      commonCallback(function (err, object, res) {
        if (err)
          return callback(err);

        return callback(null, object || {}, res.headers);
      }));
};


MAPI.prototype._put = function _put(path,
                                    data,
                                    customer,
                                    opts,
                                    callback) {

  assert.equal(typeof (path), 'string');
  assert.equal(typeof (data), 'object');

  if (typeof (customer) === 'function') {
    callback = customer;
    customer = '';
    opts = {};
  } else if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var req = request(path, customer, opts);

  return this.client.put(req, data, commonCallback(function (err, _, res) {
    if (err)
      return callback(err);

    return callback(null, res.headers);
  }));
};


MAPI.prototype._del = function _del(path,
                                    customer,
                                    opts,
                                    callback) {

  assert.equal(typeof (path), 'string');

  if (typeof (customer) === 'function') {
    callback = customer;
    customer = '';
    opts = {};
  } else if (typeof (opts) === 'function') {
    callback = opts;
    opts = {};
  }
  assertArg('customer', 'string', customer);
  assertArg('options', 'object', opts);
  assertArg('callback', 'function', callback);

  var req = request(path, customer, opts);

  var self = this;
  return this.client.del(req, commonCallback(function (err, _, res) {
    if (err)
      return callback(err);

    self._cachePut(req.path, null);
    return callback(null, res.headers);
  }));
};


MAPI.prototype._cacheGet = function _cacheGet(key) {
  return this.cache ? this.cache.get(key) : null;
};


MAPI.prototype._cachePut = function cachePut(key, value) {
  if (this.cache)
    this.cache.put(key, value);
};