'use strict';

var assert = require('assert');
var utils = require('../utils');
var ProofStream = require('../audit-tools/proof-stream');
var Contract = require('../contract');
var StorageItem = require('../storage/item');
var stream = require('readable-stream');
var kad = require('kad');
var url = require('url');
var async = require('async');
var Contact =  require('./contact');
var constants = require('../constants');
var DataChannelClient = require('../data-channels/client');

/**
 * Defines the Storj protocol methods and mounts on a {@link Network} instance
 * to handle Storj protocol messages
 * @constructor
 * @license AGPL-3.0
 * @param {Object} options
 * @param {Network} options.network - Network instance to bind to
 */
function Protocol(opts) {
  if (!(this instanceof Protocol)) {
    return new Protocol(opts);
  }

  assert(typeof opts === 'object' , 'Invalid options supplied');

  this._network = opts.network;
  this._logger = this._network._logger;
}

/**
 * Handles OFFER messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleOffer = function(params, callback) {
  var self = this;
  var contract;

  this._logger.info(
    'handling storage contract offer from %s', params.contact.nodeID
  );

  try {
    contract = Contract.fromObject(params.contract);
  } catch (err) {
    return callback(new Error('Invalid contract format'));
  }

  // TODO: Ultimately we will need to create a robust decision engine that will
  // TODO: allow us to better determine if the received offer is in our best
  // TODO: interest. For now, we just make sure that we have the data_shard
  // TODO: from the OFFER and we wish to CONSIGN it.

  // For now, we just accept any storage offer we get that matches our own...
  var key = contract.get('data_hash');

  this._verifyContract(contract, params.contact, function(err) {
    if (err) {
      return callback(err);
    }

    var doConsign = self._network._pendingContracts[key].bind(
      self._network,
      null,
      Contact(params.contact),
      contract
    );
    delete self._network._pendingContracts[key];

    var item = new StorageItem({ hash: key });

    item.contracts[params.contact.nodeID] = contract;

    self._network.manager.save(item, function(err) {
      if (err) {
        return callback(err);
      }

      self._logger.info(
        'accepting storage contract offer from %s', params.contact.nodeID
      );

      callback(null, { contract: contract.toObject() });
      doConsign();
    });
  });
};

/**
 * Verifies that the contract is valid
 * @private
 */
Protocol.prototype._verifyContract = function(contract, contact, callback) {
  if (!contract.verify('farmer', contact.nodeID)) {
    return callback(new Error('Invalid signature from farmer'));
  }

  contract.sign('renter', this._network.keypair.getPrivateKey());

  if (!contract.isComplete()) {
    return callback(new Error('Contract is not complete'));
  }

  if (!this._network._pendingContracts[contract.get('data_hash')]) {
    this._network.emit('unhandledOffer', contract, contact);
    return callback(new Error('Contract no longer open to offers'));
  }

  var blacklist = this._network._pendingContracts[
    contract.get('data_hash')
  ].blacklist;

  if (blacklist.indexOf(contact.nodeID) !== -1) {
    return callback(new Error('Contract no longer open to offers'));
  }

  callback(null);
};

/**
 * Handles AUDIT messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleAudit = function(params, callback) {
  var self = this;
  var limit = constants.MAX_CONCURRENT_AUDITS;

  if (!Array.isArray(params.audits)) {
    return callback(new Error('Invalid audit list supplied'));
  }

  this._logger.info(
    'handling storage audit from %s', params.contact.nodeID
  );

  async.mapLimit(params.audits, limit, function(audit, done) {
    self._proveShardExistence(
      audit.data_hash,
      audit.challenge,
      params.contact.nodeID,
      done
    );
  }, function onComplete(err, proofs) {
    if (err) {
      return callback(err);
    }

    callback(null, { proofs: proofs });
  });
};

/**
 * Performs a single audit proof generation
 * @private
 * @param {String} hash - The hash of the shard to prove
 * @param {String} challenge - The challenge input for proof generation
 * @param {String} nodeID - The nodeID of the auditor
 * @param {Function} callback - Called on completion of the proof generation
 */
Protocol.prototype._proveShardExistence = function(hash, chall, nid, cb) {
  if (!hash || !chall) {
    return cb(new Error('Invalid data hash or challenge provided'));
  }

  this._network.manager.load(hash, function(err, item) {
    if (err) {
      return cb(err);
    }

    if (item.shard instanceof stream.Writable) {
      return cb(new Error('Shard not found'));
    }

    var proof = new ProofStream(item.trees[nid], chall);

    item.shard.pipe(proof).on('finish', function() {
      cb(null, proof.getProofResult());
    });
  });
};

/**
 * Handles CONSIGN messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleConsign = function(params, callback) {
  var self = this;
  var token = utils.generateToken();

  this._logger.info(
    'handling storage consignment request from %s', params.contact.nodeID
  );

  self._network.manager.load(params.data_hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    var contract = item.contracts[params.contact.nodeID];
    var t = Date.now();

    if (!contract) {
      return callback(new Error('Consignment is not authorized'));
    }

    item.trees[contract.get('renter_id')] = params.audit_tree;

    try {
      assert(
        t < contract.get('store_end') &&
        t + constants.CONSIGN_THRESHOLD > contract.get('store_begin'),
        'Consignment violates contract store time'
      );
    } catch (err) {
      return callback(err);
    }

    self._network.manager.save(item, function(err) {
      if (err) {
        return callback(err);
      }

      self._logger.info(
        'authorizing data channel for %s', params.contact.nodeID
      );

      self._network.dataChannelServer.accept(token, params.data_hash);
      callback(null, { token: token });
    });
  });
};

/**
 * Handles MIRROR messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleMirror = function(params, callback) {
  var self = this;
  var hash = params.data_hash;
  var token = params.token;

  self._network.manager.load(hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    // NB: Don't mirror data we are not contracted for
    if (!item.contracts[params.contact.nodeID]) {
      return callback(new Error('No contract found for shard'));
    }

    // NB: Don't mirror if we already have the shard
    if (typeof item.shard.write !== 'function') {
      return callback(null, {});
    }

    self._logger.info(
      'opening datachannel with %j to mirror %s',
      params.farmer,
      hash
    );

    var dcx = new DataChannelClient(params.farmer);

    function _onChannelError(err) {
      dcx.removeAllListeners();
      self._logger.error(
        'failed to open datachannel for mirroring, reason: %s',
        err.message
      );
      callback(err);
    }

    function _onChannelOpen() {
      var rs = dcx.createReadStream(token, hash);

      self._logger.info('datachannel successfully established for mirror');
      dcx.removeListener('error', _onChannelError);

      rs.on('error', function _onStreamError(err) {
        self._logger.error('failed to read from mirror node: %s', err.message);
        rs.unpipe(item.shard);
        item.shard.destroy();
      }).pipe(item.shard);

      callback(null, {});
    }

    dcx.on('error', _onChannelError).on('open', _onChannelOpen);
  });
};

/**
 * Handles RETRIEVE messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleRetrieve = function(params, callback) {
  var self = this;
  var hash = params.data_hash;
  var token = utils.generateToken();

  if (!kad.utils.isValidKey(hash)) {
    return callback(new Error('Invalid data hash provided: ' + hash));
  }

  self._network.manager.load(hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    // TODO: We will need to increment the download count to track payments, as
    // TODO: well as make sure that the requester is allowed to fetch the shard
    // TODO: as part of the contract.

    self._logger.info(
      'authorizing data channel for %s', params.contact.nodeID
    );

    self._network.dataChannelServer.accept(token, item.hash);
    callback(null, { token: token });
  });
};

/**
 * Handles PROBE messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleProbe = function(params, callback) {
  var message = new kad.Message({
    method: 'PING',
    params: { contact: this._network.contact }
  });

  this._logger.info('performing probe for %s', params.contact.nodeID);
  this._network.transport.send(params.contact, message, function(err) {
    if (err) {
      return callback(new Error('Probe failed, you are not addressable'));
    }

    callback(null, {});
  });
};

/**
 * Handles FIND_TUNNEL messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleFindTunnel = function(params, callback) {
  var available = this._network.transport._tunserver.hasTunnelAvailable();
  var knownTunnelers = this._network._tunnelers.getContactList();
  var tunnels = available ?
                [this._network.contact].concat(knownTunnelers) :
                knownTunnelers;

  this._logger.info('finding tunnels for %s', params.contact.nodeID);

  if (tunnels.length) {
    this._logger.info(
      'sending %s tunnels to %s', tunnels.length, params.contact.nodeID
    );
    return callback(null, { tunnels: tunnels });
  }

  if (params.relayers.length < constants.MAX_FIND_TUNNEL_RELAYS) {
    return this._askNeighborsForTunnels(params.relayers, callback);
  }

  callback(null, { tunnels: tunnels });
};

/**
 * Sends a FIND_TUNNEL to our seed on behalf of requester
 * @private
 */
Protocol.prototype._askNeighborsForTunnels = function(relayers, callback) {
  var self = this;
  var nearestNeighbors = this._network.router.getNearestContacts(
    this._network.contact.nodeID,
    3,
    this._network.contact.nodeID
  ).filter(function(contact) {
    return relayers.indexOf(contact.nodeID) === -1;
  });

  this._logger.info('asking nearest neighbors for known tunnels');

  function askNeighbor(neighbor, done) {
    self._network.transport.send(neighbor, kad.Message({
      method: 'FIND_TUNNEL',
      params: {
        contact: self._network.contact,
        relayers: [self._network.contact].concat(relayers)
      }
    }), function(err, response) {
      if (err || !Array.isArray(response.result.tunnels)) {
        return done(false);
      }

      if (response.result.tunnels && response.result.tunnels.length) {
        response.result.tunnels.forEach(function(tun) {
          if (self._network._tunnelers.getSize() < kad.constants.K) {
            self._network._tunnelers.addContact(
              self._network.transport._createContact(tun)
            );
          }
        });
        return done(true);
      }

      done(false);
    });
  }

  async.detectSeries(nearestNeighbors, askNeighbor, function() {
    callback(null, { tunnels: self._network._tunnelers.getContactList() });
  });
};

/**
 * Handles OPEN_TUNNEL messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleOpenTunnel = function(params, callback) {
  var self = this;

  this._logger.info('opening gateway for %s', params.contact.nodeID);
  this._network.transport._tunserver.createGateway(function(err, gateway) {
    if (err) {
      return callback(err);
    }

    var tunnel = url.format({
      protocol: 'ws',
      slashes: true,
      hostname: self._network.contact.address,
      port: self._network.transport._tunserver.getListeningPort(),
      pathname: 'tun',
      query: { token: gateway.getEntranceToken() }
    });

    var alias = {
      address: self._network.contact.address,
      port: gateway.getEntranceAddress().port
    };

    self._logger.info(
      'gateway opened for %s at %j', params.contact.nodeID, alias
    );

    if (!self._network.transport._requiresTraversal) {
      return callback(null, { tunnel: tunnel, alias: alias });
    }

    self._network.transport.createPortMapping(
      gateway.getEntranceAddress().port,
      function(err) {
        if (err) {
          return callback(err);
        }

        callback(null, { tunnel: tunnel, alias: alias });
      }
    );
  });
};

/**
 * Handles TRIGGER messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleTrigger = function(params, callback) {
  this._network.triggers.process(params, callback);
};

/**
 * Returns bound references to the protocol handlers
 * @returns {Object} handlers
 */
Protocol.prototype.handlers = function() {
  return {
    OFFER: this._handleOffer.bind(this),
    AUDIT: this._handleAudit.bind(this),
    CONSIGN: this._handleConsign.bind(this),
    MIRROR: this._handleMirror.bind(this),
    RETRIEVE: this._handleRetrieve.bind(this),
    PROBE: this._handleProbe.bind(this),
    FIND_TUNNEL: this._handleFindTunnel.bind(this),
    OPEN_TUNNEL: this._handleOpenTunnel.bind(this),
    TRIGGER: this._handleTrigger.bind(this)
  };
};

module.exports = Protocol;
