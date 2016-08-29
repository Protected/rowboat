/* Environment: Discord -- This environment connects to a Discord server/guild. */

var jsonfile = require('jsonfile');
var discord = require('discord.js');

//== Environment settings (discord.env.json)

//*Discord application token
var token = null;

//*Server name to operate on (application must have been previously added to server)
var servername = null;

//*Default channel to operate on (must be a channel in the above server)
var defaultchannel = null;

//== 

var client = null;
var server = null;
var channels = {};

var cbError = [];
var cbMessage = [];


var envname = "Discord";
exports.name = envname;


exports.initialize = function() {
    var params;
    try {
        params = jsonfile.readFileSync("discord.env.json");
    } catch(e) {}
    
    if (params.token) token = params.token;
    if (!token) return false;
    
    if (params.servername) servername = params.servername;
    if (!servername) return false;
    
    if (params.defaultchannel) defaultchannel = params.defaultchannel;
    if (!defaultchannel) return false;
    
    return true;
}


exports.connect = function() {

    client = new discord.Client();

    client.on("ready", function(message) {
        server = client.servers.get("name", servername);
        channels[server.defaultChannel.name] = server.defaultChannel;
        if (defaultchannel != server.defaultChannel.name) {
            channels[defaultchannel] = server.channels.getAll("type", "text").get("name", defaultchannel);
        }
    });
    
    client.on("message", function(message) {
        if (message.author.username == client.user.username) return;
        var type = "regular";
        if (message.channel instanceof discord.PMChannel) type = "private";
        for (var i = 0; i < cbMessage.length; i++) {
            cbMessage[i](envname, type, message.content, message.author.username, message);
        }
    });

    client.loginWithToken(token, function(err) {
        if (!err) return;
        for (var i = 0; i < cbError.length; i++) {
            cbError[i](envname, err);
        }
    });

}


exports.disconnect = function() {
    client.logout(function(err) {
        if (!err) return;
        cbError[i](envname, err);
    });
}


exports.msg = function(target, msg) {

    var targetchan = null;
    
    if (typeof target == "string") {
        if (!channels[target]) {
            channels[target] = server.channels.getAll("type", "text").get("name", target);
        }
        if (channels[target]) {
            targetchan = channels[target];
        }
    } else {
        targetchan = target;
    }
    
    if (!targetchan) {
        targetchan = channels[defaultchannel];
    }
    
    client.sendMessage(targetchan, msg, {disableEveryone: true}, function(err) {
        if (!err) return;
        for (var i = 0; i < cbError.length; i++) {
            cbError[i](envname, err);
        }
    });
}


exports.registerOnError = function(func) {  //callback(env, errormsg)
    cbError.push(func);
}


exports.registerOnMessage = function(func) {  //callback(env, type, message, author, rawobject)
    cbMessage.push(func);
}


exports.getRawObject = function() {
    return {
        "client": client,
        "server": server
    }
}
