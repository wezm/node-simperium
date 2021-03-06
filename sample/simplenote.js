/*eslint no-process-exit: 0*/
var Client = require( '../lib/simperium/client' );
var Auth = require( '../lib/simperium/auth' );

var client = new Client( process.env.SIMPERIUM_APP_ID );
var auth = new Auth( process.env.SIMPERIUM_APP_ID, process.env.SIMPERIUM_APP_SECRET );

var interval = Number.POSITIVE_INFINITY, lastInt;

client.connect();

auth.on( 'authorize', function( user ) {
	var notes = client.bucket( 'note' );

	client.accessToken = user.access_token;

	notes.on( 'index', function() {
		var now = ( new Date() ).getTime(),
			note = {
				content: 'Hola mundo!',
				systemTags: [],
				tags: [],
				creationDate: now,
				modificationDate: now,
				publishURL: '',
				shareURL: '',
				deleted: false
			};

		notes.add( note, function( err, id ) {
			// if (err) throw err;
			setTimeout( function() {
				note.content += '\n\nEl Fin';
				note.deleted = true;
				notes.update( id, note );
				notes.remove( id );
			}, 2000 );
		} );
	} );
} );

auth.authorize(
	process.env.SIMPERIUM_USERNAME,
	process.env.SIMPERIUM_PASSWORD
).then( function( user ) {
	console.log( 'Logged in', user );
}, function( error ) {
	console.error( 'Failed to authenticate', error, error.stack );
	throw( error );
	client.end();
} );

client.on( 'send', function( data ) {
	console.warn( ' => ', data.slice( 0, 200 ) );
} );

client.on( 'message', function( message ) {
	console.warn( ' <= ', message.slice( 0, 200 ) );
} );

client.on( 'reconnect', function( attempt ) {
	console.warn( 'Attempting reconnection', attempt );
} );

process.on( 'SIGINT', function() {
	if ( lastInt ) {
		interval = ( new Date() ).getTime() - lastInt.getTime();
	}

	if ( interval < 500 ) {
		console.log( 'Shutting down' );
		process.exit();
	}

	lastInt = new Date();
	console.log( 'Reconnecting, press interrupt again to exit' );
	console.log( 'Disconnect and reconnect' );
	client.disconnect();
} );
