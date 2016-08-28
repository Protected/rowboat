var Discord = require("discord.js");
var jsonfile = require('jsonfile');
var chokidar = require('chokidar');
var fs = require('fs');

var PA = null;
var mybot = new Discord.Client();

var commandList = [
{
    command: "dummy1",
    func: _dummy1Cmd,
    help: "Does dummy things",
	syntax: "+dummy <arg> <arg>",
    dest: "any",
}
];


function setMain(mains){
	PA = mains;
}

function onReassemble(){

}

// callbacks
var server;
var channel;
function onMessage (from, to, message, messageObj){
    mybot.sendMessage(channel, from + ": " + message );
}

// Exports
exports.commandList = commandList;
exports.setMain = setMain;
exports.onReassemble = onReassemble;
exports.messageCallback = onMessage;



//// Function methods

function _dummy1Cmd (from, to, dest, message, messageObj ) {
	PA.client.say(dest,"It does things.");
}


// Discord related

var settings = jsonfile.readFileSync("discord.env");

var serverName = settings.serverName;

var amIReady = false;

mybot.on("message", function(message) {
    var blob = {
        username: message.author.username,
        content: message.content
    };
	if ( mybot.user.username != blob.username )
		PA.client.say(settings.channelName, blob.username+": "+blob.content);
});

mybot.on("ready", function(message) {
	server = mybot.servers.get("name", serverName);
	channel = server.defaultChannel;
    amIReady = true;
});

mybot.loginWithToken(settings.token, function(err) {
});
