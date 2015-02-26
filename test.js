var PA = null;

var commandList = [{
    command: "dummy1",
    func: _dummy1Cmd,
    help: "Does dummy things",
	syntax: "+dummy <arg> <arg>",
    dest: "any",
},{
	command: "dummy2",
    func: _dummy2Cmd,
    help: "Does other dummy things",
	syntax: "+dummy <arg>",
    dest: "any",
}];


function setMain(mains){
	PA = mains;
}

function onReassemble(){

}

exports.commandList = commandList;
exports.setMain = setMain;
exports.onReassemble = onReassemble;

//// Function methods

function _dummy1Cmd (from, to, dest, message, messageObj ) {
	PA.client.say(dest,"It does things.");
}

function _dummy2Cmd (from, to, dest, message, messageObj ) {
	PA.client.say(dest,"It does even more things.");
	PA.client.notice(from,"See?");
}
