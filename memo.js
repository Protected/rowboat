
var _ = require('underscore');

var PA = null;


var commandList = [{
    command: "memo",
    func: _memoCmd,
    help: "Sends / Reads memos.",
    dest: "any",
	permission: "z",
}];

function setMain(mains){
	PA = mains;
	PA.client.addListener('message', function (from, to, message, messageObj) {
		if ( from == "RPG_Gamer" ) {
			//checkForMemos();
		}
	});
}
function onReassemble(){

}
exports.commandList = commandList;
exports.setMain = setMain;
exports.onReassemble = onReassemble;

function checkForMemos(){
	//PA.client.say("RPG_Gamer", "You have -2- new memo(s).");
}



function _memoCmd (from, to, dest, message, messageObj ) {
	PA.client.say(dest,">:D!");

}