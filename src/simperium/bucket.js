import { EventEmitter } from 'events'
import inherits from 'inherits';
import { v4 as uuid } from 'uuid';

/**
 * @callback taskCallback
 * @param {?Error} - if an error occurred it will be provided, otherwise null
 * @param {Any} - the result of task
 */

/**
 * Convenience function to turn a function that uses a callback into a function
 * that returns a Promise.
 *
 * @param {taskCallback} task - function that expects a single callback argument
 * @returns {Promise} callback wrapped in a promise interface
 */
const callbackAsPromise = ( task ) => new Promise( ( resolve, reject ) => {
	task( ( error, result ) => error ? reject( error ) : resolve( result ) );
} );

/**
 * Runs a promise with a callback (if one is provided) to support the old callback API.
 * NOTE: if the callback API is removed this is a place to warn users
 *
 * @param {Function} [callback] - if provided, will be called with the expected values
 * @param {Promise} promise - promise to run, executes callback if provieded
 * @returns {Promise} promise is passed through
 */
const deprecateCallback = ( callback, promise ) => {
	if ( typeof callback === 'function' ) {
		// Potentially could warn here if we decide to remove callback API
		return promise.then(
			result => {
				callback( null, result );
				return result;
			},
			error => {
				callback( error );
				return error;
			}
		);
	}
	return promise;
};

/**
 * A bucket object represents the data stored in Simperium for the given id
 *
 * @typedef {Object} BucketObject
 * @param {String} id - bucket object id
 * @param {Object} data - object literal of bucket object data stored at the id
 * @param {?Boolean} isIndexing - used to indicate that the bucket is being indexed
 */

/**
 * @callback bucketStoreGetCallback
 * @param {?Error}
 * @param {?BucketObject}
 */

/**
 * @callback bucketStoreRemoveCallback
 * @param {?Error}
 */

/**
 * @callback bucketStoreFindCallback
 * @param {?Error}
 * @param {?BucketObject[]}
 */

/**
 * Used by a bucket to store bucket object data.
 *
 * @interface BucketStore
 */

/**
 * Retrieve a bucket object from the store
 * @function
 * @name BucketStore#get
 * @param {String} id - the bucket object id to fetch
 * @param {bucketStoreGetCallback} - callback once the object is fetched
 */

/**
 * Updates the data for the given object id.
 *
 * @function
 * @name BucketStore#update
 * @param {String} id - to of object to update
 * @param {Object} data - data to update the object to
 * @param {Boolean} isIndexing - indicates the object is being downloaded during an index
 * @param {bucketStoreGetCallback}
 */

/**
 * Deletes the object at id from the datastore.
 *
 * @function
 * @name BucketStore#remove
 * @param {String} id - object to delete from the bucket
 * @param {bucketStoreRemoveCallback} - called once the object is deleted
 */

/**
 * Fetchs all bucket objects from the datastore.
 *
 * @function
 * @name BucketStore#find
 * @param {?Object} query - currently undefined
 * @param {bucketStoreFindCallback} - called with results
 */

/**
 * Turns existing bucket storage provider callback api into a promise based API
 *
 * @param {BucketStore} store - a bucket storage object
 * @returns {Object} store api methods that use Promises instead of callbacks
 */
const promiseAPI = store => ( {
	get: id =>
		callbackAsPromise( store.get.bind( store, id ) ),
	update: ( id, object, isIndexing ) =>
		callbackAsPromise( store.update.bind( store, id, object, isIndexing ) ),
	remove: id =>
		callbackAsPromise( store.remove.bind( store, id ) ),
	find: query =>
		callbackAsPromise( store.find.bind( store, query ) )
} );

/**
 * A bucket that syncs data with Simperium.
 *
 * @param {String} name - Simperium bucket name
 * @param {bucketStoreProvider} storeProvider - a factory function that provides a bucket store
 * @param {Channel} channel - a channel instance used for syncing Simperium data
 */
export default function Bucket( name, storeProvider, channel ) {
	EventEmitter.call( this );
	this.name = name;
	this.store = storeProvider( this );
	this.storeAPI = promiseAPI( this.store );
	this.isIndexing = false;

	/**
	 * Listeners for channel events that will be added to Channel instance
	 */
	this.onChannelIndex = this.emit.bind( this, 'index' );
	this.onChannelError = this.emit.bind( this, 'error' );
	this.onChannelUpdate = ( id, data, original, patch, isIndexing ) => {
		this.update( id, data, { original, patch, isIndexing }, { sync: false } );
	};

	this.onChannelIndexingStateChange = ( isIndexing ) => {
		this.isIndexing = isIndexing;
		if ( isIndexing ) {
			this.emit( 'indexing' );
		}
	};

	this.onChannelRemove = ( id ) => this.remove( id );

	if ( channel ) {
		this.setChannel( channel );
	}
}

inherits( Bucket, EventEmitter );

/**
 * Sets the channel the Bucket will use to sync changes.
 *
 * This exists to allow the Client to provide a backwards compatible API. There
 * is probably no reason to change the Channel once it's already set.
 *
 * @param {Channel} channel - channel instance to use for syncing
 */
Bucket.prototype.setChannel = function( channel ) {
	if ( this.channel ) {
		this.channel
			.removeListener( 'index', this.onChannelIndex )
			.removeListener( 'error', this.onChannelError )
			.removeListener( 'update', this.onChannelUpdate )
			.removeListener( 'indexingStateChange', this.onChannelIndexingStateChange )
			.removeListener( 'remove', this.onChannelRemove );
	}
	this.channel = channel;
	channel
		// forward the index and error events from the channel
		.on( 'index', this.onChannelIndex )
		.on( 'error', this.onChannelError )
		// when the channel updates or removes data, the bucket should apply
		// the same updates
		.on( 'update', this.onChannelUpdate )
		.on( 'indexingStateChange', this.onChannelIndexingStateChange )
		.on( 'remove', this.onChannelRemove );

	/**
	 * Fetch the current state for a given id in the datastore
	 *
	 * @param {string} id - object to fetch current state for
	 * @returns {Promise<Object|null>} local state or null if no state to provide
	 */
	const localStateForKey = ( id ) => {
		return this.get( id ).then( ( object ) => {
			if ( object ) {
				return object.data;
			}
		} );
	}

	// Sets up a default network change subscriber that triggers a channel
	// change operation. This will queue up any changes that exist that
	// may have not been added to the local queue yet
	channel.beforeNetworkChange( ( id, ... args ) => {
		const changeResolver = this.changeResolver
			// if there is a subcriber, let it handle the network change
			? Promise.resolve( this.changeResolver( id, ... args ) )
			// if no subscriber, resolving null will mean we should handle it
			: Promise.resolve( null );

		return changeResolver
			.then( localState => {
				// if subscriber provided local state of any truthy type use that
				// as the object's local state
				if ( localState ) {
					return localState;
				}
				// Subscriber did not provide local state, fetch it from the datastore
				return localStateForKey( id );
			} )
	} );
};

/**
 * @callback NetworkChangeResolver
 * @param { string } key - bucket object being changed
 * @param { Object } data - the new object data
 * @param { Object } base - the object data before the patch is applied
 * @param { Object } patch - the patch used to bring base to data
 * @returns { Object | null | Promise<Object | null> } - resolve when network change should be applied
 */

/**
 * Subscribe to changes to this bucket that are coming from simperium that
 * did not originate on this client. Can be used to save an object before
 * network changes are applied.
 *
 * @param {NetworkChangeResolver} changeResolver - callback executed when network changes for this bucket are going to be applied
 */
Bucket.prototype.beforeNetworkChange = function( changeResolver ) {
	this.changeResolver = changeResolver;
}

/**
 * Reloads all the data from the currently cached set of ghost data
 */
Bucket.prototype.reload = function() {
	this.channel.reload();
};

/**
 * Stores an object in the bucket and syncs it to simperium. Generates an
 * object ID to represent the object in simperium.
 *
 * @param {Object} data - plain js object literal to be saved/synced
 * @param {?bucketStoreGetCallback} callback - runs when object has been saved
 * @return {Promise<Object>} data stored in the bucket
 */
Bucket.prototype.add = function( data, callback ) {
	var id = uuid();
	return this.update( id, data, callback );
};

/**
 * Requests the object data stored in the bucket for the given id.
 *
 * @param {String} id - bucket object id
 * @param {?bucketStoreGetCallback} callback - with the data stored in the bucket
 * @return {Promise<Object>} the object id, data and indexing status
 */
Bucket.prototype.get = function( id, callback ) {
	return deprecateCallback( callback, this.storeAPI.get( id ) );
};

/**
 * Update the bucket object of `id` with the given data.
 *
 * @param {String} id - the bucket id for the object to update
 * @param {Object} data - object literal to replace the object data with
 * @param {Object} remoteUpdateInfo - object containing data about a remote change
 * @param {Object} [updateInfo.original] - the original object before the udpate
 * @param {Object} [updateInfo.patch] - the JSONDiff patch to apply to the object
 * @param {Boolean} [updateInfo.isIndexing] - true if the bucket is currently indexing
 * @param {Object} [options] - optional settings
 * @param {Boolean} [options.sync=true] - false if object should not be synced with this update
 * @param {?bucketStoreGetCallback} callback - executed when object is updated localy
 * @returns {Promise<Object>} - update data
 */
Bucket.prototype.update = function( id, data, remoteUpdateInfo, options, callback ) {
	// Callback could be 3rd or 4th argument
	if ( typeof remoteUpdateInfo === 'function' ) {
		callback = remoteUpdateInfo;
		options = { sync: true };
	} else if ( typeof options === 'function' ) {
		callback = options;
		options = { sync: true };
	}

	if ( !! options === false ) {
		options = { sync: true };
	}

	const task = this.storeAPI.update( id, data, this.isIndexing )
		.then( bucketObject => {
			return this.channel.update( bucketObject, options.sync );
		} )
		.then( bucketObject => {
			this.emit( 'update', id, bucketObject.data, remoteUpdateInfo );
			return bucketObject;
		} );
	return deprecateCallback( callback, task );
};

/**
 * @callback bucketHasLocalChanges
 * @param {?Error}
 * @param {?Boolean}
 */

/**
 * Check if the bucket has pending changes that have not yet been synced.
 *
 * @param {?bucketHasLocalChanges} callback - optional callback to receive response
 * @returns {Promise<Boolean>} resolves to true if their are still changes to sync
 */
Bucket.prototype.hasLocalChanges = function( callback ) {
	return deprecateCallback( callback, this.channel.hasLocalChanges() );
};

/**
 * @callback bucketGetVersion
 * @param {?Error}
 * @param {Number}
 */

/**
 * Gets the currently synced version number for the specified object id.
 *
 * A version of `0` indicates that an object has not been added to simperium yet.
 *
 * @param {String} id - object to get the version for
 * @param {?bucketGetVersionCallback} callback - optional callback
 * @returns {Promise<number>} - resolves to the current synced version
 */
Bucket.prototype.getVersion = function( id, callback ) {
	return deprecateCallback( callback, this.channel.getVersion( id ) );
};

/**
 * Attempts to sync the object specified by `id` using whatever data
 * is locally stored for the object
 *
 * @param {String} id - object to sync
 * @param {?bucketStoreGetCallback} callback - optional callback
 * @returns {Promise<BucketObject>} - object id, data
 */
Bucket.prototype.touch = function( id, callback ) {
	const task = this.storeAPI.get( id )
		.then( object => {
			if ( object ) {
				return this.update( object.id, object.data );
			}
		} );

	return deprecateCallback( callback, task );
};

/**
 * Deletes the object from the bucket
 *
 * @param {String} id - object to delete
 * @param {?bucketStoreRemoveCallback} callback - optional callback
 * @returns {Promise<Void>} - resolves when object has been deleted
 */
Bucket.prototype.remove = function( id, callback ) {
	const task = this.storeAPI.remove( id )
		.then( ( result ) => {
			this.emit( 'remove', id );
			this.channel.remove( id );
			return result;
		} )
	return deprecateCallback( callback, task );
};

Bucket.prototype.find = function( query, callback ) {
	return deprecateCallback( callback, this.storeAPI.find( query ) );
};

/**
 * Gets all known past versions of an object
 *
 * @param {String} id - object to fetch revisions for
 * @param {Function} [callback] - optional callback
 * @returns {Promise<Array<Object>>} - list of objects with id, data and version
 */
Bucket.prototype.getRevisions = function( id, callback ) {
	return deprecateCallback( callback, this.channel.getRevisions( id ) );
}
