'use strict';

var sinon = require('sinon');
var expect = require('chai').expect;
var Contract = require('../../../lib/contract');
var KeyPair = require('../../../lib/crypto-tools/keypair');
var FarmerInterface = require('../../../lib/network/interfaces/farmer');
var Network = require('../../../lib/network');
var kad = require('kad');
var Contact = require('../../../lib/network/contact');
var utils = require('../../../lib/utils');
var StorageItem = require('../../../lib/storage/item');
var EventEmitter = require('events').EventEmitter;

describe('FarmerInterface', function() {

  describe('@constructor', function() {

    it('should use the keypair address if non supplied', function() {
      var keypair = KeyPair();
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        negotiator: function() {
          return false;
        },
        payment: { address: keypair.getAddress() },
        logger: kad.Logger(0),
        backend: require('memdown')
      });
      expect(farmer.getPaymentAddress()).to.equal(keypair.getAddress());
    });

  });

  describe('#_handleContractPublication', function() {

    it('should not send an offer if negotiator returns false', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        negotiator: function(contract, callback) {
          callback(false);
        },
        logger: kad.Logger(0),
        backend: require('memdown')
      });
      var _addTo = sinon.stub(farmer, '_addContractToPendingList');
      farmer._handleContractPublication(Contract({}));
      setImmediate(function() {
        _addTo.restore();
        expect(_addTo.called).to.equal(false);
        done();
      });
    });

    it('should not send an offer if negotiator cannot get farmer free space',
      function(done) {

      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        negotiator: function(contract, callback) {
          callback(false);
        },
        logger: kad.Logger(0),
        backend: require('memdown')
      });

      var _size = sinon.stub(
        farmer.manager._storage,
        'size'
      ).callsArgWith(0, new Error('Cannot get farmer disk space'));

      var _addTo = sinon.stub(farmer, '_addContractToPendingList');
      farmer._handleContractPublication(Contract({}));
      _size.restore();
      setImmediate(function() {
        expect(_addTo.called).to.equal(false);

        done();
      });
    });

    it('should not send an offer if concurrency is exceeded', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        negotiator: function(c, callback) {
          callback(true);
        },
        logger: kad.Logger(0),
        backend: require('memdown'),
        concurrency: 0
      });
      var _addTo = sinon.stub(farmer, '_addContractToPendingList');
      farmer._handleContractPublication(Contract({}));
      setImmediate(function() {
        expect(_addTo.called).to.equal(false);
        done();
      });
    });

  });

  describe('#_addContractToPendingList', function() {

    it('should not add duplicates to the list', function() {
      var ctx = { _pendingOffers: [] };
      var _test = FarmerInterface.prototype._addContractToPendingList.bind(ctx);
      var fakeContract = {
        get: sinon.stub().returns('test')
      };
      _test(fakeContract);
      expect(ctx._pendingOffers).to.have.lengthOf(1);
      _test(fakeContract);
      expect(ctx._pendingOffers).to.have.lengthOf(1);
    });

  });

  describe('#_negotiateContract', function() {

    it('should ask network for renter if not locally known', function(done) {
      var kp1 = KeyPair();
      var kp2 = KeyPair();
      var contract = new Contract({
        renter_id: kp1.getNodeID(),
        farmer_id: kp2.getNodeID(),
        payment_source: kp1.getAddress(),
        payment_destination: kp2.getAddress(),
        data_hash: utils.rmd160('test')
      });
      contract.sign('renter', kp1.getPrivateKey());
      contract.sign('farmer', kp2.getPrivateKey());
      expect(contract.isComplete()).to.equal(true);
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _getContactByNodeID = sinon.stub(
        farmer.router,
        'getContactByNodeID'
      ).returns(null);
      var _findNode = sinon.stub(
        farmer.router,
        'findNode'
      ).callsArgWith(1, null, [Contact({
        address: '127.0.0.1',
        port: 1234,
        nodeID: kp1.getNodeID()
      })]);
      var _save = sinon.stub(farmer.manager, 'save').callsArg(1);
      farmer._sendOfferForContract = function() {
        expect(_findNode.called).to.equal(true);
        _getContactByNodeID.restore();
        _findNode.restore();
        _save.restore();
        done();
      };
      farmer._negotiateContract(contract);
    });

    it('should remove contract from pending if save fails', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _remove = sinon.stub(farmer, '_removeContractFromPendingList');
      var _getContactByNodeID = sinon.stub(
        farmer.router,
        'getContactByNodeID'
      ).returns(null);
      var _save = sinon.stub(farmer.manager, 'save').callsArgWith(
        1,
        new Error('Save failed')
      );
      farmer._negotiateContract(Contract({
        data_hash: utils.rmd160(' some data')
      }));
      setImmediate(function() {
        _getContactByNodeID.restore();
        _save.restore();
        _remove.restore();
        expect(_remove.called).to.equal(true);
        done();
      });
    });

    it('should remove contract from pending if lookup fails', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _save = sinon.stub(farmer.manager, 'save').callsArgWith(
        1,
        null
      );
      var _remove = sinon.stub(farmer, '_removeContractFromPendingList');
      var _getContactByNodeID = sinon.stub(
        farmer.router,
        'getContactByNodeID'
      ).returns(null);
      var _findNode = sinon.stub(farmer.router, 'findNode').callsArgWith(
        1,
        new Error('Lookup failed')
      );
      farmer._negotiateContract(Contract({
        data_hash: utils.rmd160('some data')
      }));
      setImmediate(function() {
        setImmediate(function() {
          _save.restore();
          _getContactByNodeID.restore();
          _remove.restore();
          _findNode.restore();
          expect(_remove.called).to.equal(true);
          done();
        });
      });
    });

    it('should remove contract from pending if no renter', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _remove = sinon.stub(farmer, '_removeContractFromPendingList');
      var _getContactByNodeID = sinon.stub(
        farmer.router,
        'getContactByNodeID'
      ).returns(null);
      var _findNode = sinon.stub(farmer.router, 'findNode').callsArgWith(
        1,
        null,
        []
      );
      farmer._negotiateContract(Contract({
        data_hash: utils.rmd160('some data')
      }));
      setImmediate(function() {
        setImmediate(function() {
          setImmediate(function() {
            setImmediate(function() {
              _getContactByNodeID.restore();
              _findNode.restore();
              _remove.restore();
              expect(_remove.called).to.equal(true);
              done();
            });
          });
        });
      });
    });

    it('should send offer directly to renter if locally known', function(done) {
      var kp1 = KeyPair();
      var kp2 = KeyPair();
      var contract = new Contract({
        renter_id: kp1.getNodeID(),
        farmer_id: kp2.getNodeID(),
        payment_source: kp1.getAddress(),
        payment_destination: kp2.getAddress(),
        data_hash: utils.rmd160('test')
      });
      contract.sign('renter', kp1.getPrivateKey());
      contract.sign('farmer', kp2.getPrivateKey());
      expect(contract.isComplete()).to.equal(true);
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _getContactByNodeID = sinon.stub(
        farmer.router,
        'getContactByNodeID'
      ).returns({});
      var _findNode = sinon.stub(farmer.router, 'findNode');
      var _save = sinon.stub(farmer.manager, 'save').callsArg(1);
      farmer._sendOfferForContract = function() {
        expect(_findNode.called).to.equal(false);
        _getContactByNodeID.restore();
        _findNode.restore();
        _save.restore();
        done();
      };
      farmer._negotiateContract(contract);
    });

  });

  describe('#join', function() {

    it('should bubble error from Network#join', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _join = sinon.stub(Network.prototype, 'join').callsArgWith(
        0,
        new Error('Failed to join network')
      );
      farmer.join(function(err) {
        _join.restore();
        expect(err.message).to.equal('Failed to join network');
        done();
      });
    });

  });

  describe('#_sendOfferForContract', function() {

    it('should log a warning if transport send fails', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _send = sinon.stub(farmer.transport, 'send').callsArgWith(
        2,
        new Error('Failed to send offer')
      );
      var _warn = sinon.stub(farmer._logger, 'warn');
      farmer._sendOfferForContract({
        toObject: sinon.stub(),
        get: sinon.stub()
      });
      setImmediate(function() {
        _send.restore();
        _warn.restore();
        expect(_warn.calledWith('Failed to send offer')).to.equal(true);
        done();
      });
    });

    it('should log default error if none provided', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _send = sinon.stub(farmer.transport, 'send').callsArgWith(
        2,
        null,
        { result: {} }
      );
      var _warn = sinon.stub(farmer._logger, 'warn');
      farmer._sendOfferForContract({
        toObject: sinon.stub(),
        get: sinon.stub()
      });
      setImmediate(function() {
        _send.restore();
        _warn.restore();
        expect(_warn.calledWith('Renter refused to sign')).to.equal(true);
        done();
      });
    });

  });

  describe('#_handleContractPublication', function() {

    it('should return false for invalid contract', function(done) {
      var _shouldSendOffer = sinon.stub();
      FarmerInterface.prototype._handleContractPublication.call({
        _logger: { debug: sinon.stub() },
        _shouldSendOffer: _shouldSendOffer
      }, { version: '12' });
      setImmediate(function() {
        expect(_shouldSendOffer.called).to.equal(false);
        done();
      });
    });

  });

  describe('#_handleOfferRes', function() {

    it('should stop and log error if invalid contract', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _warn = sinon.stub(farmer._logger, 'warn');
      farmer._handleOfferRes({ result: { contract: { version: '12'} } });
      setImmediate(function() {
        _warn.restore();
        expect(
          _warn.calledWith('renter responded with invalid contract')
        ).to.equal(true);
        done();
      });
    });

    it('should stop and log error if signature invalid', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _warn = sinon.stub(farmer._logger, 'warn');
      farmer._handleOfferRes({
        result: {
          contract: Contract({}).toObject()
        }
      }, new Contract());
      setImmediate(function() {
        _warn.restore();
        expect(
          _warn.calledWith('renter signature is invalid')
        ).to.equal(true);
        done();
      });
    });

    it('should create a new item if cannot load existing', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var _load = sinon.stub(farmer.manager, 'load').callsArgWith(1, {});
      var _save = sinon.stub(farmer.manager, 'save');
      var _verify = sinon.stub(Contract.prototype, 'verify').returns(true);
      farmer._handleOfferRes({
        result: {
          contract: Contract({}).toObject()
        }
      }, new Contract(), {});
      setImmediate(function() {
        _load.restore();
        _save.restore();
        _verify.restore();
        expect(_save.args[0][0]).to.be.instanceOf(StorageItem);
        done();
      });
    });

  });

  describe('#_listenForCapacityChanges', function() {

    it('should set the free space to true', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var manager = new EventEmitter();
      farmer._listenForCapacityChanges(manager);
      manager.emit('unlocked');
      setImmediate(function() {
        expect(farmer._hasFreeSpace).to.equal(true);
        done();
      });
    });

    it('should set the free space to false', function(done) {
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: kad.Logger(0),
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var manager = new EventEmitter();
      farmer._listenForCapacityChanges(manager);
      manager.emit('locked');
      setImmediate(function() {
        expect(farmer._hasFreeSpace).to.equal(false);
        done();
      });
    });

    it('should log the error', function(done) {
      var logger = kad.Logger(0);
      var _warn = sinon.stub(logger, 'warn');
      var farmer = new FarmerInterface({
        keypair: KeyPair(),
        port: 0,
        tunport: 0,
        noforward: true,
        logger: logger,
        backend: require('memdown'),
        storage: { path: 'test' }
      });
      var manager = new EventEmitter();
      farmer._listenForCapacityChanges(manager);
      manager.emit('error', new Error('Failed'));
      setImmediate(function() {
        expect(_warn.called).to.equal(true);
        done();
      });
    });

  });

});
