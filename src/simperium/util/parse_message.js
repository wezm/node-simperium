// @flow
export default ( data: string ) => {
	const marker = data.indexOf( ':' );

	return {
		command: data.slice( 0, marker ),
		data: data.slice( marker + 1 )
	}
}
